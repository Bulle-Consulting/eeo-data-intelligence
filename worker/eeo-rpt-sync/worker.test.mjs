// Request-level tests for the eeo-rpt-sync Worker. Run: node worker.test.mjs
// Stubs the Resend API and asserts routing, subjects, and full-document content.
import worker from './worker.js';
import assert from 'node:assert/strict';

let sent = [];
globalThis.fetch = async (url, opts) => {
  sent.push({ url: String(url), body: JSON.parse(opts.body) });
  return new Response(JSON.stringify({ id: 'test' }), { status: 200 });
};

const post = (path, body, env = { RESEND_API_KEY: 'test-key' }) =>
  worker.fetch(new Request('https://w.example' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }), env);

const b64utf8 = s => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = s => Buffer.from(s, 'base64').toString('utf8');

// ── /gmr: properly-labelled subject + full document ──
sent = [];
let res = await post('/gmr/santa-monica-grant-mod/submit', {
  district: 'Santa Monica CCD',
  gmr: {
    district: 'Santa Monica CCD', submittedBy: 'Test User, Lead', email: 'test@example.edu', date: '2026-07-30',
    originalWorkplan: 'ORIGINAL-PLAN with <angle> & detail', proposedWorkplan: 'PROPOSED-PLAN',
    sme: 'SME-NOTES', approvedBy: 'Approver X',
    timeline: [{ activity: 'A1', timeline: 'Jan-Jun 2027', description: 'D1' }, { activity: '', timeline: '', description: '' }]
  },
  recipients: ['admin@bulleconsulting.com'],
  uploadFileName: 'Grant-Modification-Request-Santa-Monica-CCD.pdf',
  uploadFileB64: b64utf8('%PDF-fake')
});
let out = await res.json();
assert.equal(out.ok, true, 'gmr submit ok');
assert.equal(sent.length, 1, 'one email sent');
let mail = sent[0].body;
assert.equal(mail.subject, 'Grant Modification Request — Santa Monica CCD — July 30, 2026', 'gmr subject: ' + mail.subject);
assert.match(mail.html, /Grant Modification Request/);
assert.match(mail.html, /ORIGINAL-PLAN with &lt;angle&gt; &amp; detail/);
assert.match(mail.html, /PROPOSED-PLAN/);
assert.match(mail.html, /A1/); assert.match(mail.html, /Jan-Jun 2027/);
assert.match(mail.html, /SME-NOTES/); assert.match(mail.html, /Approver X/);
assert.match(mail.text, /ORIGINAL-PLAN/); assert.match(mail.text, /1\. A1 \| Jan-Jun 2027 \| D1/);
assert.equal(mail.attachments.length, 2, 'html + pdf attachments');
assert.equal(mail.attachments[0].filename, 'Grant-Modification-Request.html');
assert.match(fromB64(mail.attachments[0].content), /ORIGINAL-PLAN/);
assert.equal(mail.attachments[1].filename, 'Grant-Modification-Request-Santa-Monica-CCD.pdf');
assert.equal(mail.attachments[1].content_type, 'application/pdf');
console.log('PASS /gmr full document + subject');

// ── /gmr with empty timeline and no upload ──
sent = [];
res = await post('/gmr/x/submit', { district: 'X CCD', gmr: { submittedBy: 'A', email: 'a@b.c', originalWorkplan: 'O', proposedWorkplan: 'P' } });
out = await res.json();
assert.equal(out.ok, true);
assert.match(sent[0].body.html, /No timeline activities entered/);
assert.equal(sent[0].body.attachments.length, 1);
console.log('PASS /gmr minimal');

// ── /rpt unchanged behavior, aliased fields render ──
sent = [];
res = await post('/rpt/test-district/submit', {
  district: 'Test District',
  state: {
    district: 'Test District', leadName: 'Lead L', leadEmail: 'l@d.edu', teamChanged: 'Yes',
    teamChangedDetail: 'TEAM-DETAIL', goals: 'G', goalsMet: 'Yes', goalsMetDetail: 'GOALS-DETAIL',
    updates: 'Yes', updatesDetail: 'UPDATES-DETAIL', barriers: 'B', certify: 'Lead L',
    expenditures: [{ type: '1000', year: 'Y1', description: 'Desc', approved: '10', spent: '5', balance: '5' }]
  },
  recipients: ['admin@bulleconsulting.com']
});
out = await res.json();
assert.equal(out.ok, true);
mail = sent[0].body;
assert.equal(mail.subject, 'EEO IBP Grant Report — Test District — ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
assert.match(mail.html, /TEAM-DETAIL/); assert.match(mail.html, /GOALS-DETAIL/); assert.match(mail.html, /UPDATES-DETAIL/);
assert.match(mail.html, /Desc/);
console.log('PASS /rpt full document');

// ── missing RESEND key → ok:false with the exact error the dashboards handle ──
sent = [];
res = await post('/rpt/x/submit', { district: 'X', state: { certify: 'T' } }, {});
out = await res.json();
assert.equal(out.ok, false);
assert.equal(out.error, 'no RESEND_API_KEY configured');
assert.equal(sent.length, 0, 'nothing sent without key');
res = await post('/gmr/x/submit', { district: 'X', gmr: { submittedBy: 'T' } }, {});
out = await res.json();
assert.equal(out.ok, false);
assert.equal(out.error, 'no RESEND_API_KEY configured');
console.log('PASS missing-key error paths');

// ── legacy /bmr + unknown route ──
sent = [];
res = await post('/bmr/x/submit', { district: 'X', state: { meta: { submittedBy: 'S' }, y1rows: [{ code: '1000', description: 'D', current: 1, proposed: 2, justification: 'J' }] } });
out = await res.json();
assert.equal(out.ok, true);
assert.match(sent[0].body.subject, /^Budget Modification Request — X — /);
assert.match(fromB64(sent[0].body.attachments[0].content), /Year 1 Modifications/);
res = await worker.fetch(new Request('https://w.example/nope'), {});
assert.equal(res.status, 404);
res = await worker.fetch(new Request('https://w.example/health'), {});
assert.equal((await res.json()).ok, true);
console.log('PASS legacy /bmr, /health, 404');

console.log('ALL WORKER TESTS PASSED');
