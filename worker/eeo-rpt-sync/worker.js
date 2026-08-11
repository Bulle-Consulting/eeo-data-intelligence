// eeo-rpt-sync — Cloudflare Worker for EEO IBP Grant form submissions.
// Routes:
//   POST /rpt/{district}/submit  EEO IBP Grant Report — emails the full report
//                                (every answer + expenditure row) as a styled
//                                HTML body + attachment, plus any uploaded
//                                expenditure file.
//   POST /gmr/{district}/submit  Grant Modification Request — properly-labelled
//                                subject and a full rendering of the form, plus
//                                the dashboard's own PDF/HTML copy if attached.
//   POST /bmr/{district}/submit  Legacy Budget Modification relay (kept for
//                                older dashboards; bmr-sync is the primary).
//   GET  /bmr/{district}         Read the stored BMR record (KV, optional).
//   GET  /health
//
// Email is sent via Resend. One-time setup after deploy:
//   npx wrangler secret put RESEND_API_KEY
// Without the secret every submit returns
//   { ok:false, error:"no RESEND_API_KEY configured" } and nothing is emailed —
// the dashboards then fall back to opening the staff member's own mail app.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/health') return json({ ok: true });
    const rptMatch = path.match(/^\/rpt\/([^/]+)\/submit$/);
    if (rptMatch && request.method === 'POST') return handleRptSubmit(request, env, rptMatch[1]);
    const gmrMatch = path.match(/^\/gmr\/([^/]+)\/submit$/);
    if (gmrMatch && request.method === 'POST') return handleGmrSubmit(request, env, gmrMatch[1]);
    const bmrSubmit = path.match(/^\/bmr\/([^/]+)\/submit$/);
    if (bmrSubmit && request.method === 'POST') return handleBmrSubmit(request, env, bmrSubmit[1]);
    const bmrGet = path.match(/^\/bmr\/([^/]+)$/);
    if (bmrGet && request.method === 'GET') return handleBmrGet(request, env, bmrGet[1]);
    return json({ error: 'not found' }, 404);
  }
};

const DEFAULT_RECIPIENTS = ['eeosubmissions@cccco.edu', 'admin@bulleconsulting.com'];

// ───────────────────────── EEO IBP Grant Report ─────────────────────────
async function handleRptSubmit(request, env, districtSlug) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const {
    district = districtSlug,
    state = {},
    recipients = DEFAULT_RECIPIENTS,
    submittedAt = new Date().toISOString(),
    uploadFileName = null,
    uploadFileB64 = null
  } = body;
  const subject = `EEO IBP Grant Report — ${district} — ${fmtDate(submittedAt)}`;
  const htmlBody = buildRptHtml(state, district, submittedAt);
  const textBody = buildRptText(state, district, submittedAt);
  const attachments = [{ filename: 'form-submission.html', content: b64utf8(htmlBody), type: 'text/html' }];
  if (uploadFileB64 && uploadFileName) {
    attachments.push({ filename: uploadFileName, content: uploadFileB64, type: mimeFor(uploadFileName), disposition: 'attachment' });
  }
  const sendResult = await sendEmail({ env, to: recipients, subject, html: htmlBody, text: textBody, attachments, from: { email: 'noreply@bulleconsulting.com', name: 'Bulle Consulting — EEO Portal' } });
  if (!sendResult.ok) return json({ ok: false, error: sendResult.error, district: districtSlug });
  return json({ ok: true, district: districtSlug, mailed: true, recipients });
}

// ─────────────────────── Grant Modification Request ───────────────────────
// The dashboards POST { district, gmr: {…all form fields…}, uploadFileName,
// uploadFileB64 } where the upload is the dashboard's own fully-styled copy of
// the form (PDF when html2pdf is available, HTML otherwise). The email gets a
// properly-labelled subject, a full rendering of every answer in the body, the
// Worker's own HTML attachment, and the dashboard's PDF/HTML copy.
async function handleGmrSubmit(request, env, districtSlug) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const {
    district = districtSlug,
    gmr = {},
    recipients = DEFAULT_RECIPIENTS,
    submittedAt = new Date().toISOString(),
    uploadFileName = null,
    uploadFileB64 = null
  } = body;
  const g = (gmr && Object.keys(gmr).length) ? gmr : ((body.state && body.state.gmr) || {});
  const subject = `Grant Modification Request — ${district} — ${fmtDate(submittedAt)}`;
  const htmlBody = buildGmrHtml(g, district, submittedAt);
  const textBody = buildGmrText(g, district, submittedAt);
  const attachments = [{ filename: 'Grant-Modification-Request.html', content: b64utf8(htmlBody), type: 'text/html' }];
  if (uploadFileB64 && uploadFileName) {
    attachments.push({ filename: uploadFileName, content: uploadFileB64, type: mimeFor(uploadFileName), disposition: 'attachment' });
  }
  const sendResult = await sendEmail({ env, to: recipients, subject, html: htmlBody, text: textBody, attachments, from: { email: 'noreply@bulleconsulting.com', name: 'Bulle Consulting — EEO Portal' } });
  if (!sendResult.ok) return json({ ok: false, error: sendResult.error, district: districtSlug });
  return json({ ok: true, district: districtSlug, mailed: true, recipients });
}

function gmrTimelineEntries(g) {
  return (Array.isArray(g.timeline) ? g.timeline : []).filter(r => r && ((r.activity || '') + (r.timeline || '') + (r.description || '')).trim());
}

function buildGmrHtml(g, district, submittedAt) {
  const escv = v => esc(v == null ? '' : String(v));
  const dim = '<span style="color:#888">—</span>';
  const metaRow = (l, v) => v ? `<tr><td style="padding:5px 10px;font-weight:600;color:#1a2e5a;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(l)}</td><td style="padding:5px 10px;font-size:13px;color:#333;">${escv(v)}</td></tr>` : '';
  const section = (t, v) => `<div style="margin:16px 0 6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6b00;border-top:1px solid #e2e8f0;padding-top:12px;">${esc(t)}</div>` +
    `<div style="font-size:13px;color:#333;line-height:1.6;white-space:pre-wrap;">${String(v || '').trim() ? escv(v) : dim}</div>`;
  let tlRows = '';
  const tl = gmrTimelineEntries(g);
  if (tl.length) {
    tl.forEach((r, i) => {
      tlRows += `<tr style="background:${i % 2 ? '#fff' : '#f8f9fb'}"><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${escv(r.activity)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${escv(r.timeline)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${escv(r.description)}</td></tr>`;
    });
  } else {
    tlRows = '<tr><td colspan="3" style="padding:8px;text-align:center;color:#888;font-size:12px;">No timeline activities entered</td></tr>';
  }
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:0;"><div style="max-width:720px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);">` +
    `<div style="background:#1a2e5a;padding:20px 28px;"><div style="color:#fff;font-size:18px;font-weight:700;">Grant Modification Request</div><div style="color:#c8a84b;font-size:12px;margin-top:3px;">Submitted ${fmtDate(submittedAt)} · ${esc(district)}</div></div>` +
    `<div style="padding:20px 28px;">` +
    `<table style="width:100%;border-collapse:collapse;">${metaRow('District', g.district || district)}${metaRow('Submitted By', g.submittedBy)}${metaRow('Email', g.email)}${metaRow('Submission Date', g.date)}</table>` +
    section('Original Workplan, Activities, and Outcomes — incl. barriers prompting the change', g.originalWorkplan) +
    section('Proposed Workplan, Activities and Outcomes', g.proposedWorkplan) +
    `<div style="margin:16px 0 6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6b00;border-top:1px solid #e2e8f0;padding-top:12px;">Timeline — all activities complete by June 30, 2028</div>` +
    `<table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;"><thead><tr style="background:#1a2e5a;color:#fff;"><th style="padding:6px 8px;font-size:12px;text-align:left;">Activity</th><th style="padding:6px 8px;font-size:12px;text-align:left;">Timeline</th><th style="padding:6px 8px;font-size:12px;text-align:left;">Description</th></tr></thead><tbody>${tlRows}</tbody></table>` +
    section('SME Recommendations — for Chancellor’s Office use only', g.sme) +
    (g.approvedBy ? `<table style="width:100%;border-collapse:collapse;margin-top:12px;">${metaRow('Approved By', g.approvedBy)}</table>` : '') +
    `<p style="margin:18px 0 0;font-size:12px;color:#666;">A corresponding Budget Modification Request must also be completed to align with this programmatic change.</p>` +
    `</div><div style="background:#f0f4f8;padding:12px 28px;font-size:11px;color:#666;text-align:center;">Bulle Consulting · EEO IBP Grant Portal · Automated submission copy.</div></div></body></html>`;
}

function buildGmrText(g, district, submittedAt) {
  const v = x => (x == null || String(x).trim() === '') ? '—' : String(x);
  const lines = [
    'GRANT MODIFICATION REQUEST',
    `District: ${v(g.district || district)}`,
    `Submitted: ${fmtDate(submittedAt)}`,
    `Submitted by: ${v(g.submittedBy)} | ${v(g.email)}`,
    '',
    'ORIGINAL WORKPLAN, ACTIVITIES, AND OUTCOMES (incl. barriers prompting the change)',
    v(g.originalWorkplan),
    '',
    'PROPOSED WORKPLAN, ACTIVITIES AND OUTCOMES',
    v(g.proposedWorkplan),
    '',
    'TIMELINE (all activities complete by June 30, 2028)'
  ];
  const tl = gmrTimelineEntries(g);
  if (tl.length) tl.forEach((r, i) => lines.push(`${i + 1}. ${v(r.activity)} | ${v(r.timeline)} | ${v(r.description)}`));
  else lines.push('—');
  lines.push('', 'SME RECOMMENDATIONS (Chancellor’s Office use)', v(g.sme));
  if (g.approvedBy) lines.push('', `Approved by: ${g.approvedBy}`);
  lines.push('', 'A corresponding Budget Modification Request must also be completed to align with this programmatic change.', 'Bulle Consulting · EEO IBP Grant Portal');
  return lines.join('\n');
}

// ─────────────────── Legacy Budget Modification relay ───────────────────
async function handleBmrSubmit(request, env, districtSlug) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const { district = districtSlug, state = {}, recipients = DEFAULT_RECIPIENTS, submittedAt = new Date().toISOString() } = body;
  const meta = state.meta || {};
  const subject = `Budget Modification Request — ${district} — ${fmtDate(submittedAt)}`;
  const sendResult = await sendEmail({
    env, to: recipients, subject,
    html: `<h2>Budget Modification Request</h2><p><b>District:</b> ${esc(district)}<br><b>Submitted by:</b> ${esc(meta.submittedBy || '')}<br><b>Date:</b> ${fmtDate(submittedAt)}</p>`,
    text: `Budget Modification Request\nDistrict: ${district}\nSubmitted by: ${meta.submittedBy || ''}\nDate: ${fmtDate(submittedAt)}`,
    attachments: [{ filename: 'Budget-Modification-Request.html', content: b64utf8(buildBmrHtmlBody(state, districtSlug, meta, submittedAt)), type: 'text/html' }],
    from: { email: 'noreply@bulleconsulting.com', name: 'Bulle Consulting — EEO Portal' }
  });
  if (env.BMR_KV) {
    try { await env.BMR_KV.put(`bmr:${districtSlug}`, JSON.stringify({ district, state, submittedAt })); } catch (_) {}
  }
  if (!sendResult.ok) return json({ ok: false, error: sendResult.error });
  return json({ ok: true, district: districtSlug, mailed: true, recipients });
}

function buildBmrHtmlBody(state, district, meta, submittedAt) {
  const fmtD = d => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const yearRows = rows => (rows || []).map(r => `<tr><td>${esc(r.code || '')}</td><td>${esc(r.description || '')}</td><td>$${Number(r.current || 0).toLocaleString()}</td><td>$${Number(r.proposed || 0).toLocaleString()}</td><td>${esc(r.justification || '')}</td></tr>`).join('');
  return `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Budget Modification Request</title><style>body{font-family:Arial,sans-serif;margin:40px;color:#1a1f2e;}h1{color:#003E5A;border-bottom:3px solid #FFCD00;padding-bottom:10px;}h2{color:#003E5A;margin-top:24px;}table{width:100%;border-collapse:collapse;margin-top:12px;}th{background:#003E5A;color:#fff;padding:8px 10px;text-align:left;font-size:12px;}td{padding:8px 10px;border-bottom:1px solid #ddd;font-size:13px;}.meta{background:#f3f6f9;padding:16px;border-radius:8px;margin-bottom:20px;}.meta p{margin:4px 0;font-size:13px;}</style></head><body><h1>Budget Modification Request</h1><div class='meta'><p><strong>District:</strong> ${esc(district)}</p><p><strong>Submitted By:</strong> ${esc((meta && meta.submittedBy) || '')}</p><p><strong>Email:</strong> ${esc((meta && meta.email) || '')}</p><p><strong>Submission Date:</strong> ${fmtD(submittedAt)}</p></div><h2>Year 1 Modifications</h2><table><thead><tr><th>Code</th><th>Description</th><th>Current</th><th>Proposed</th><th>Justification</th></tr></thead><tbody>${yearRows(state.y1rows)}</tbody></table><h2>Year 2 Modifications</h2><table><thead><tr><th>Code</th><th>Description</th><th>Current</th><th>Proposed</th><th>Justification</th></tr></thead><tbody>${yearRows(state.y2rows)}</tbody></table><p style='margin-top:24px;font-size:12px;color:#666;'>Submitted on ${fmtD(submittedAt)}</p></body></html>`;
}

async function handleBmrGet(request, env, districtSlug) {
  if (env.BMR_KV) {
    try {
      const s = await env.BMR_KV.get(`bmr:${districtSlug}`, 'json');
      if (s) return json(s);
    } catch (_) {}
  }
  return json({ district: districtSlug, state: {}, recipients: DEFAULT_RECIPIENTS, submittedAt: new Date().toISOString() });
}

// ───────────────────────────── Email + report rendering ─────────────────────────────
async function sendEmail({ env, to, subject, html, text, attachments = [], from }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'no RESEND_API_KEY configured' };
  const toArr = Array.isArray(to) ? to : [to];
  let fromStr;
  if (from && typeof from === 'object') {
    fromStr = from.name ? `${from.name} <${from.email}>` : from.email;
  } else if (typeof from === 'string' && from) {
    fromStr = from;
  } else {
    fromStr = env.SENDER_ADDR || 'Bulle Consulting — EEO Portal <noreply@bulleconsulting.com>';
  }
  const atts = (attachments || []).map(a => ({
    filename: a.filename,
    content: a.content,
    ...(a.content_type || a.type ? { content_type: a.content_type || a.type } : {})
  }));
  const body = { from: fromStr, to: toArr, subject, text, html };
  if (atts.length > 0) body.attachments = atts;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (resp.status >= 200 && resp.status < 300) return { ok: true };
    const err = await resp.text().catch(() => `${resp.status}`);
    return { ok: false, error: `Resend ${resp.status}: ${String(err).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function buildRptHtml(s, district, submittedAt) {
  const row = (l, v) => v ? `<tr><td style="padding:5px 10px;font-weight:600;color:#1a2e5a;font-size:13px;white-space:nowrap;">${esc(l)}</td><td style="padding:5px 10px;font-size:13px;color:#333;">${esc(v)}</td></tr>` : '';
  const sec = t => `<tr><td colspan="2" style="padding:12px 10px 3px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6b00;border-top:1px solid #e2e8f0;">${esc(t)}</td></tr>`;
  let exRows = '';
  if (Array.isArray(s.expenditures) && s.expenditures.length) {
    s.expenditures.forEach((ex, i) => {
      exRows += `<tr style="background:${i % 2 ? '#fff' : '#f8f9fb'}"><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${esc(ex.type)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${esc(ex.year)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${esc(ex.description)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:right;">${esc(ex.approved)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:right;">${esc(ex.spent)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:right;">${esc(ex.balance)}</td></tr>`;
    });
  } else {
    exRows = '<tr><td colspan="6" style="padding:8px;text-align:center;color:#888;font-size:12px;">No expenditures entered</td></tr>';
  }
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:0;"><div style="max-width:720px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);"><div style="background:#1a2e5a;padding:20px 28px;"><div style="color:#fff;font-size:18px;font-weight:700;">EEO IBP Grant Report</div><div style="color:#c8a84b;font-size:12px;margin-top:3px;">Submitted ${fmtDate(submittedAt)} · ${esc(district)}</div></div><div style="padding:20px 28px;"><table style="width:100%;border-collapse:collapse;">${sec('Contact & Team')}${row('District', s.district)}${row('Project Lead', s.leadName)}${row('Lead Email', s.leadEmail)}${row('Support Staff', s.staffName)}${row('Staff Email', s.staffEmail)}${row('Team Changed', s.teamChanged)}${row('Team Detail', s.teamChangedDetail)}${sec('Grant Goals')}${row('Goals', s.goals)}${row('Goals Met', s.goalsMet)}${row('Goals Detail', s.goalsMetDetail)}${row('Updates', s.updates)}${row('Updates Detail', s.updatesDetail)}${sec('Barriers')}${row('Barriers', s.barriers)}</table><div style="margin:16px 0 6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6b00;border-top:1px solid #e2e8f0;padding-top:12px;">Total Grant Expenditures</div><table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;"><thead><tr style="background:#1a2e5a;color:#fff;"><th style="padding:6px 8px;font-size:12px;">Type</th><th style="padding:6px 8px;font-size:12px;">Year</th><th style="padding:6px 8px;font-size:12px;">Description</th><th style="padding:6px 8px;font-size:12px;text-align:right;">Approved</th><th style="padding:6px 8px;font-size:12px;text-align:right;">Spent</th><th style="padding:6px 8px;font-size:12px;text-align:right;">Balance</th></tr></thead><tbody>${exRows}</tbody></table><table style="width:100%;border-collapse:collapse;margin-top:4px;">${sec('Upload')}${row('Uploaded File', s._uploadFileName || 'None')}${sec('Budget Modification')}${row('Intent', s.bmrIntent)}${sec('Optional')}${row('Comments', s.optional || '—')}${sec('Certification')}${row('Certified By', s.certify)}${row('Submitted At', fmtDate(submittedAt))}</table></div><div style="background:#f0f4f8;padding:12px 28px;font-size:11px;color:#666;text-align:center;">Bulle Consulting · EEO IBP Grant Portal · Automated submission copy.</div></div></body></html>`;
}

function buildRptText(s, district, submittedAt) {
  const v = x => x || '—';
  const lines = [
    'EEO IBP GRANT REPORT', `District: ${v(district)}`, `Submitted: ${fmtDate(submittedAt)}`, '',
    'CONTACT & TEAM', `Lead: ${v(s.leadName)} | ${v(s.leadEmail)}`, `Staff: ${v(s.staffName)} | ${v(s.staffEmail)}`,
    `Team Changed: ${v(s.teamChanged)}`, s.teamChangedDetail ? `Detail: ${s.teamChangedDetail}` : '', '',
    'GRANT GOALS', `Goals: ${v(s.goals)}`, `Goals Met: ${v(s.goalsMet)}`, s.goalsMetDetail ? s.goalsMetDetail : '',
    `Updates: ${v(s.updates)}`, s.updatesDetail ? s.updatesDetail : '', '',
    'BARRIERS', v(s.barriers), '', 'EXPENDITURES'
  ];
  if (Array.isArray(s.expenditures) && s.expenditures.length) s.expenditures.forEach((ex, i) => lines.push(`${i + 1}. ${ex.type}|${ex.year}|${ex.description}|${ex.approved}|${ex.spent}|${ex.balance}`));
  lines.push('', `Upload: ${v(s._uploadFileName)}`, `BMR Intent: ${v(s.bmrIntent)}`, '', 'OPTIONAL', v(s.optional), '', `CERTIFIED BY: ${v(s.certify)}`, 'Bulle Consulting · EEO IBP Grant Portal');
  return lines.filter(l => l !== undefined).join('\n');
}

// ───────────────────────────── utils ─────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function esc(v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function b64utf8(s) {
  return btoa(unescape(encodeURIComponent(s)));
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch (_) {
    return iso;
  }
}
function mimeFor(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  return {
    'pdf': 'application/pdf',
    'html': 'text/html',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xls': 'application/vnd.ms-excel',
    'csv': 'text/csv',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }[ext] || 'application/octet-stream';
}
