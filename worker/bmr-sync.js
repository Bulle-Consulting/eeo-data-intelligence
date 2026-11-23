// bmr-sync — Cloudflare Worker for Budget Modification Request submissions.
// Persists BMR state in KV; on submit emails a fully-styled HTML rendering
// of the form (matching the dashboard's Budget Modification tab) to
// CCCCO + Bulle admin via Resend.

// Who may use this service from a browser: the published origins of the 11
// district dashboards and the EEO Data Intelligence Dashboard, plus the EEO
// Dashboard itself. Only these get CORS headers, and only these may save or
// submit (PUT / POST). An Origin header can be forged outside a browser, so
// this stops other websites, not a person with command-line tools.
const ALLOWED_ORIGINS = [
  'https://wardere83.github.io',        // 10 district dashboards
  'https://bulle-consulting.github.io', // Kern CCD + EEO Data Intelligence Dashboard
  'https://eeo.bulleconsulting.com',    // EEO Dashboard
  'https://projects.bulleconsulting.com',
];

// Owner's rule (2026-11-23): every submitted BMR goes to these two addresses,
// whatever the dashboard sends, and the submitter gets a copy as a
// confirmation receipt. Every email this service sends comes from admin@.
const BMR_TO = ['admin@bulleconsulting.com', 'eeosubmissions@cccco.edu'];
const MAIL_FROM = 'Bulle Consulting <admin@bulleconsulting.com>';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = (res) => withCors(res, allowed ? origin : '');
    if (request.method === 'OPTIONS') {
      return allowed ? cors(new Response(null, { status: 204 })) : new Response('forbidden', { status: 403, headers: { vary: 'Origin' } });
    }
    if (url.pathname === '/health') return cors(new Response('ok', { status: 200 }));

    const m = url.pathname.match(/^\/bmr\/([a-z0-9-]{1,32})(?:\/(submit))?$/i);
    if (!m) return cors(new Response('not found', { status: 404 }));
    const district = m[1].toLowerCase();
    const isSubmit = m[2] === 'submit';

    // Public read: only whether the district has submitted and when. No
    // caller reads a record back (the forms keep their drafts in the
    // browser), so names, emails, phones, the form and the PDF never leave.
    if (request.method === 'GET' && !isSubmit) {
      const stored = await env.BMR_STATE.get(district, 'json');
      const res = json(publicStatus(stored));
      res.headers.set('cache-control', 'no-store');
      return cors(res);
    }
    if ((request.method === 'PUT' || request.method === 'POST') && !allowed) {
      return new Response('forbidden', { status: 403, headers: { vary: 'Origin' } });
    }
    if (request.method === 'PUT' && !isSubmit) {
      const body = await safeJson(request);
      if (!body) return cors(new Response('invalid json', { status: 400 }));
      const prevDraft = await env.BMR_STATE.get(district, 'json').catch(() => null);
      const nowIso = new Date().toISOString();
      const draftDue = draftNotifyDue(prevDraft, Date.parse(nowIso));
      await env.BMR_STATE.put(district, JSON.stringify({ ...body, updatedAt: nowIso, firstDraftAt: draftDue ? nowIso : (prevDraft && prevDraft.firstDraftAt) || nowIso }));
      let notified = false;
      if (draftDue) {
        try {
          const sent = await notifyDraftStarted(env, 'bmr', district, body, nowIso);
          notified = !!(sent && sent.ok);
        } catch (_) {}
      }
      return cors(json({ ok: true, district, notified }));
    }
    if (request.method === 'POST' && isSubmit) {
      const body = await safeJson(request);
      if (!body) return cors(new Response('invalid json', { status: 400 }));

      await env.BMR_STATE.put(district, JSON.stringify({ ...body, submittedAt: body.submittedAt || new Date().toISOString() }));

      const recipients = BMR_TO.slice();
      const districtLabel = body.name || district;
      const meta = (body.state && body.state.meta) || {};
      const dateStr = (meta.date || new Date().toISOString().slice(0, 10)).replace(/[^a-z0-9]/gi, '-');
      const subject = `Budget Modification Request — ${districtLabel}${meta.date ? ' (' + meta.date + ')' : ''}`;
      const formHtml = renderFormHtml(body);
      const pdfBytes = await renderPdfFromHtml(env, formHtml);
      const attach = pdfBytes
        ? { filename: safeFilename(`BMR-${districtLabel}-${dateStr}.pdf`), content: bytesToB64(pdfBytes), content_type: 'application/pdf' }
        : { filename: safeFilename(`BMR-${districtLabel}-${dateStr}.html`), content: b64(formHtml), content_type: 'text/html' };

      const mail = await sendMail(env, {
        to: recipients,
        subject,
        text: renderTextBody(body),
        html: renderEmailBodyHtml(body),
        attachments: [attach],
      });
      if (!mail.ok) return cors(json({ ok: true, district, mailed: false, mailError: mail.error }));

      // Confirmation receipt: a copy for the person who submitted, from admin@.
      const submitter = receiptAddress(meta.email);
      let receipt = false;
      if (submitter) {
        try {
          const sent = await sendMail(env, {
            to: [submitter],
            subject: 'Receipt: ' + subject,
            text: renderReceiptText(body),
            html: renderReceiptHtml(body),
            attachments: [attach],
          });
          receipt = !!(sent && sent.ok);
        } catch (_) {}
      }
      return cors(json({ ok: true, district, mailed: true, recipients, receipt, receiptTo: receipt ? submitter : null }));
    }
    return cors(new Response('method not allowed', { status: 405 }));
  },
};

// -------------------- utils --------------------
// CORS for an allowed origin only; any other site's browser can't read the reply.
function withCors(res, origin) {
  const h = new Headers(res.headers);
  h.set('vary', 'Origin');
  if (origin) {
    h.set('access-control-allow-origin', origin);
    h.set('access-control-allow-methods', 'GET,PUT,POST,OPTIONS');
    h.set('access-control-allow-headers', 'content-type');
  }
  return new Response(res.body, { status: res.status, headers: h });
}
// What GET /bmr/{district} returns. A district counts as submitted only when
// its record is a real submission (submitted with a submitter and a budget),
// the rule the BMR Updates tab used; drafts and test records are not.
function publicStatus(stored) {
  const meta = (stored && stored.state && stored.state.meta) || {};
  const submitted = !!(stored && (stored.submitted || stored.submittedAt) &&
    String(meta.submittedBy || '').trim() && stored.baseline && stored.model);
  return { submitted, submittedAt: submitted && stored.submittedAt ? String(stored.submittedAt) : null };
}
function json(v) { return new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } }); }
async function safeJson(request) { try { return await request.json(); } catch { return null; } }
function b64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function safeFilename(s) { return s.replace(/[^a-z0-9._-]+/gi, '-'); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function moneyOrDash(v) { return (v == null || v === '') ? '—' : money(v); }

async function renderPdfFromHtml(env, html) {
  const tok = env.CF_API_TOKEN;
  const accountId = env.CF_ACCOUNT_ID || 'cf21c30e35a4b95b280bba9b1497d670';
  if (!tok) return null;
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/pdf`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        viewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
        pdfOptions: {
          format: 'letter',
          landscape: true,
          printBackground: true,
          margin: { top: '0.35in', bottom: '0.35in', left: '0.35in', right: '0.35in' },
          preferCSSPageSize: true
        }
      }),
    });
    if (r.status >= 200 && r.status < 300) {
      const buf = new Uint8Array(await r.arrayBuffer());
      const sig = buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
      return sig ? buf : null;
    }
  } catch { /* fall through to null */ }
  return null;
}

function bytesToB64(u8) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function sendMail(env, { to, subject, text, html, attachments }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'no RESEND_API_KEY configured' };
  const from = MAIL_FROM;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text, html, attachments }),
  });
  if (res.status >= 200 && res.status < 300) return { ok: true };
  const error = await res.text().catch(() => `${res.status}`);
  return { ok: false, error };
}

// -------------------- helpers to normalize incoming shape --------------------
// Baseline / model may arrive as either:
//   Array of { code, label, y1, y2 }  (dashboard shape)
//   or Object { category: amount }    (legacy)
function baselineArray(body) {
  if (Array.isArray(body.baseline)) return body.baseline;
  const b = body.baseline || {};
  return Object.keys(b).map(code => ({ code, label: code, y1: 0, y2: 0 }));
}
function modelArray(body) {
  if (Array.isArray(body.model)) return body.model;
  const m = body.model || {};
  return Object.keys(m).map(code => ({ code, label: code, y1: 0, y2: 0 }));
}
const YEAR_META_DEFAULT = { y1: { label: 'Year 1', dates: '' }, y2: { label: 'Year 2', dates: '' } };

// -------------------- text summary (email plain-text body) --------------------
function renderTextBody(body) {
  const meta = (body.state && body.state.meta) || {};
  const lines = [];
  lines.push('BUDGET MODIFICATION REQUEST');
  lines.push(meta.district || body.name || body.district || '');
  lines.push('');
  if (meta.submittedBy) lines.push('Submitted by: ' + meta.submittedBy);
  if (meta.email) lines.push('Email: ' + meta.email);
  if (meta.date) lines.push('Submission date: ' + meta.date);
  if (meta.approvedBy) lines.push('Approved by: ' + meta.approvedBy);
  lines.push('');
  if (body.award != null) lines.push('Total award (ceiling): ' + money(body.award));
  const modelTotal = modelArray(body).reduce((s, r) => s + (Number(r.y1) || 0) + (Number(r.y2) || 0), 0);
  if (modelArray(body).length) lines.push('Modified project budget: ' + money(modelTotal));
  lines.push('');
  lines.push('A fully-styled copy of the Budget Modification Request is attached to this email as an HTML file — open it in any browser to see the complete form: baseline vs. modified figures per object code, per-year proposed/actuals/balance/projections, and every justification exactly as staff submitted it.');
  return lines.join('\n');
}

// -------------------- email body (message the reader opens first) --------------------
function renderEmailBodyHtml(body) {
  const meta = (body.state && body.state.meta) || {};
  const districtLabel = esc(body.name || meta.district || body.district || '');
  const submittedBy = esc(meta.submittedBy || '');
  const submittedEmail = esc(meta.email || '');
  const submittedDate = esc(meta.date || new Date().toISOString().slice(0, 10));
  const total = modelArray(body).reduce((s, r) => s + (Number(r.y1) || 0) + (Number(r.y2) || 0), 0);
  const ceiling = body.award != null ? money(body.award) : '—';

  return `<!doctype html><html><body style="margin:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif;color:#0F172A">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px">
    <div style="background:#FFFFFF;border-radius:16px;padding:28px;border:1px solid #E5E7EB">
      <p style="margin:0 0 4px;color:#6B7280;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">Budget Modification Request</p>
      <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;letter-spacing:-.01em">${districtLabel}</h1>
      <p style="margin:0 0 20px;color:#6B7280;font-size:14px">Submitted ${submittedDate}${submittedBy ? ' by ' + submittedBy : ''}${submittedEmail ? ' · ' + submittedEmail : ''}</p>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#6B7280">Total award (ceiling)</td><td style="padding:8px 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${esc(ceiling)}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;border-top:1px solid #F1F5F9">Modified project budget</td><td style="padding:8px 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;border-top:1px solid #F1F5F9">${esc(money(total))}</td></tr>
      </table>
      <p style="margin:24px 0 0;color:#334155;font-size:14px;line-height:1.6">The complete, fully-styled Budget Modification Request is attached as an <strong>HTML file</strong>. Open the attachment in any browser to see every object code, per-year proposed/actuals/fund balance/projections, and every justification exactly as staff submitted them — same layout as the dashboard's Budget Modification form.</p>
    </div>
    <p style="text-align:center;color:#94A3B8;font-size:12px;margin:16px 0 0">bmr-sync · Bulle Consulting · CCCCO EEO IBP Grant</p>
  </div>
</body></html>`;
}

// -------------------- confirmation receipt (to the submitter) --------------------
// The submitter's address from the form, when it is one plain address and not
// already one of the two recipients.
function receiptAddress(v) {
  const a = String(v || '').trim();
  if (a.length > 254 || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[a-z]{2,}$/i.test(a)) return '';
  return BMR_TO.includes(a.toLowerCase()) ? '' : a;
}
function receiptFacts(body) {
  const meta = (body.state && body.state.meta) || {};
  return {
    who: String(meta.submittedBy || '').trim(),
    district: body.name || meta.district || body.district || '',
    date: meta.date || new Date().toISOString().slice(0, 10),
    ceiling: body.award != null ? money(body.award) : '—',
    total: money(modelArray(body).reduce((s, r) => s + (Number(r.y1) || 0) + (Number(r.y2) || 0), 0)),
  };
}
function renderReceiptText(body) {
  const f = receiptFacts(body);
  return [
    'Dear ' + (f.who || 'colleague') + ',',
    '',
    'Thank you. This confirms that the Budget Modification Request for ' + f.district + ' was submitted on ' + f.date + ' and sent to the CCCCO EEO IBP Grant Initiative (eeosubmissions@cccco.edu) and Bulle Consulting (admin@bulleconsulting.com).',
    '',
    'Total award (ceiling): ' + f.ceiling,
    'Modified project budget: ' + f.total,
    '',
    'A copy of your submission is attached for your records. For questions, reply to this email.',
    '',
    'Bulle Consulting',
    'CCCCO EEO IBP Grant Initiative',
  ].join('\n');
}
function renderReceiptHtml(body) {
  const f = receiptFacts(body);
  return `<!doctype html><html><body style="margin:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif;color:#0F172A">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px">
    <div style="background:#FFFFFF;border-radius:16px;padding:28px;border:1px solid #E5E7EB;font-size:14px;line-height:1.6;color:#334155">
      <p style="margin:0 0 4px;color:#6B7280;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600">Submission receipt</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;letter-spacing:-.01em;color:#0F172A">${esc(f.district)}</h1>
      <p style="margin:0 0 12px">Dear ${esc(f.who || 'colleague')},</p>
      <p style="margin:0 0 12px">Thank you. This confirms that the Budget Modification Request for ${esc(f.district)} was submitted on ${esc(f.date)} and sent to the CCCCO EEO IBP Grant Initiative (eeosubmissions@cccco.edu) and Bulle Consulting (admin@bulleconsulting.com).</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 12px">
        <tr><td style="padding:8px 0;color:#6B7280">Total award (ceiling)</td><td style="padding:8px 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:#0F172A">${esc(f.ceiling)}</td></tr>
        <tr><td style="padding:8px 0;color:#6B7280;border-top:1px solid #F1F5F9">Modified project budget</td><td style="padding:8px 0;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;border-top:1px solid #F1F5F9;color:#0F172A">${esc(f.total)}</td></tr>
      </table>
      <p style="margin:0 0 12px">A copy of your submission is attached for your records. For questions, reply to this email.</p>
      <p style="margin:0">Bulle Consulting<br>CCCCO EEO IBP Grant Initiative</p>
    </div>
  </div>
</body></html>`;
}

// -------------------- the full form (attached HTML file) --------------------
function renderFormHtml(body) {
  const meta = (body.state && body.state.meta) || {};
  const yearMeta = (body.state && body.state.yearMeta) || YEAR_META_DEFAULT;
  const years = (body.state && body.state.years) || {};
  const baseline = baselineArray(body);
  const model = modelArray(body);

  const districtLabel = esc(meta.district || body.name || body.district || '');
  const submittedDate = esc(meta.date || new Date().toISOString().slice(0, 10));
  const approvedBy = esc(meta.approvedBy || '');

  // Per-year totals for KPI cards at the bottom
  const yearTotals = { y1: { proposed: 0 }, y2: { proposed: 0 } };
  const yearBaselineTotals = { y1: 0, y2: 0 };
  baseline.forEach(bl => {
    yearBaselineTotals.y1 += Number(bl.y1) || 0;
    yearBaselineTotals.y2 += Number(bl.y2) || 0;
  });

  const modelTotal = model.reduce((s, r) => s + (Number(r.y1) || 0) + (Number(r.y2) || 0), 0);
  const ceiling = body.award != null ? money(body.award) : '—';
  const varianceVsAward = modelTotal - (Number(body.award) || 0);

  // Per-year table: Expenditure Type | Description | Proposed Funds | Actuals | Fund Balance | Projections | Expenditure Updates
  const yearSections = ['y1', 'y2'].map(yk => {
    const ym = yearMeta[yk] || { label: yk.toUpperCase(), dates: '' };
    const yearRows = (years[yk] && years[yk].rows) || {};
    let totProposed = 0, totActuals = 0, totBalance = 0, totProjections = 0;
    const dollar = (v) => (v == null || v === '') ? '<span class="dim">—</span>' : '<span class="dollar">$</span>&nbsp;' + esc(Number(v).toLocaleString('en-US'));
    const rows = baseline.map(bl => {
      const rs = yearRows[bl.code] || {};
      const base = Number(bl[yk]) || 0;
      const proposedRaw = rs.proposed != null && rs.proposed !== '' ? Number(rs.proposed) : base;
      const actualsRaw = rs.actuals != null && rs.actuals !== '' ? Number(rs.actuals) : 0;
      const balanceRaw = rs.balance != null && rs.balance !== '' ? Number(rs.balance) : null;
      const projRaw = rs.projections != null && rs.projections !== '' ? Number(rs.projections) : null;
      totProposed += Number(proposedRaw) || 0;
      totActuals += Number(actualsRaw) || 0;
      if (balanceRaw != null) totBalance += balanceRaw;
      if (projRaw != null) totProjections += projRaw;
      const description = (rs.description != null && String(rs.description).trim()) || (bl.label || '');
      const updates = rs.updates && String(rs.updates).trim();
      return `<tr>
        <td class="code"><span class="code-num${bl.code === '7000' ? ' indirect' : ''}">${esc(bl.code)}</span></td>
        <td class="desc">${esc(description)}</td>
        <td class="num">${dollar(proposedRaw)}</td>
        <td class="num">${dollar(actualsRaw)}</td>
        <td class="num">${dollar(balanceRaw)}</td>
        <td class="num">${dollar(projRaw)}</td>
        <td class="upd">${updates ? esc(updates) : ''}</td>
      </tr>`;
    }).join('');

    yearTotals[yk].proposed = totProposed;

    const totalLine = (v) => '$' + Number(v).toLocaleString('en-US');
    return `<section class="year year-${yk}">
      <div class="year-head">
        <span class="year-chip">${esc(ym.label.toUpperCase())}</span>
        <h2>${esc(ym.label)} Budget Modification</h2>
        <span class="year-dates">${esc(ym.dates || '')}</span>
        <span class="year-total">Modified budget: <strong>${esc(totalLine(totProposed))}</strong></span>
      </div>
      <table class="detail">
        <thead>
          <tr>
            <th class="hdr-narrow">Expenditure Type<small>per original grant submission</small></th>
            <th>Description</th>
            <th class="num">Proposed Funds<small>current &rarr; modified</small></th>
            <th class="num">Actuals<small>spent to date</small></th>
            <th class="num">Fund Balance<small>entered by district</small></th>
            <th class="num">Projections<small>to be spent by Jun 2028</small></th>
            <th class="hdr-wide">Expenditure Updates<small>explanation / narrative</small></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" class="tot-label">${esc(ym.label)} Totals:</td>
            <td class="num tot">${esc(totalLine(totProposed))}</td>
            <td class="num tot">${esc(totalLine(totActuals))}</td>
            <td class="num tot">${esc(totalLine(totBalance))}</td>
            <td class="num tot">${esc(totalLine(totProjections))}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </section>`;
  }).join('');

  const varianceCls = varianceVsAward === 0 ? 'zero' : varianceVsAward > 0 ? 'up' : 'down';
  const varianceStr = varianceVsAward === 0 ? '+$0' : (varianceVsAward > 0 ? '+' : '') + money(varianceVsAward);
  const varianceCap = varianceVsAward === 0 ? 'Balanced to award' : (varianceVsAward > 0 ? 'Over award' : 'Under award');
  const pageDateStr = new Date().toLocaleDateString('en-US', { month:'numeric', day:'numeric', year:'2-digit' }) + ', ' +
    new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>Budget Modification Request &mdash; ${districtLabel}</title>
<style>
  :root {
    --brand:#0B2E4F; --brand-2:#0E5FBA; --accent:#DAA520; --ink:#0F172A;
    --muted:#64748B; --line:#E5E7EB; --line-2:#F1F5F9;
    --paper:#FFFFFF; --page:#FFFFFF;
    --up:#047857; --down:#B91C1C;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:var(--page); color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Helvetica,Arial,sans-serif; }
  .page-header { display:flex; justify-content:space-between; padding:0 20px; font-size:11px; color:var(--muted); margin-bottom:6px; }
  .page-header .title { color:var(--ink); }
  .page { max-width:1500px; margin:0 auto; padding:0 18px; background:var(--paper); }
  section.year { border:1px solid var(--line); border-radius:8px; padding:8px 12px 6px; margin-bottom:6px; }
  section.year.year-y2 { border-top:3px solid var(--accent); }
  .year-head { display:flex; align-items:baseline; gap:12px; margin-bottom:8px; flex-wrap:wrap; }
  .year-head h2 { margin:0; font-size:15px; font-weight:700; color:var(--brand-2); letter-spacing:-.005em; }
  .year-head .year-dates { color:var(--muted); font-size:12px; }
  .year-head .year-total { margin-left:auto; color:var(--muted); font-size:12px; }
  .year-head .year-total strong { color:var(--brand-2); font-weight:700; font-variant-numeric:tabular-nums; }
  section.year-y2 .year-head h2 { color:var(--accent); }
  section.year-y2 .year-head .year-total strong { color:var(--accent); }
  .year-chip { background:transparent; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.10em; text-transform:uppercase; padding:0; border:0; }
  section.year-y2 .year-chip { color:var(--accent); }
  section.year.year-y1 .year-chip { color:var(--brand-2); }
  table { width:100%; border-collapse:collapse; }
  thead th { text-align:left; padding:6px 8px 8px; color:var(--brand-2); font-size:9.5px; font-weight:700; letter-spacing:.10em; text-transform:uppercase; border-bottom:1px solid var(--line); vertical-align:top; }
  thead th small { display:block; font-weight:500; font-size:8.5px; color:var(--muted); letter-spacing:.04em; text-transform:none; margin-top:2px; }
  th.num, td.num { text-align:right; font-variant-numeric:tabular-nums; }
  tbody td { padding:5px 8px; border-bottom:1px solid var(--line-2); font-size:11.5px; vertical-align:middle; }
  td.code { color:var(--brand-2); font-weight:700; width:66px; }
  td.code .code-num { color:var(--brand-2); font-weight:700; }
  td.code .code-num.indirect { color:var(--accent); }
  td.desc { color:var(--ink); }
  td.num .dollar { color:var(--muted); margin-right:2px; }
  td.num .dim { color:var(--muted); }
  td.upd { color:#0F172A; font-size:11px; line-height:1.35; white-space:pre-wrap; }
  tfoot td.tot-label { padding:9px 8px; font-weight:700; color:var(--brand-2); text-align:right; }
  tfoot td.tot { padding:9px 8px; font-weight:700; color:var(--brand-2); border-top:1px solid var(--line); font-variant-numeric:tabular-nums; }
  section.year-y2 tfoot td.tot-label,
  section.year-y2 tfoot td.tot { color:var(--accent); }
  .kpi-row { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin:6px 0 6px; }
  .kpi { background:#FFFFFF; border:1px solid var(--line); border-radius:8px; padding:7px 10px; }
  .kpi .k { color:var(--muted); font-size:9.5px; letter-spacing:.10em; text-transform:uppercase; font-weight:700; }
  .kpi .v { font-size:17px; font-weight:700; margin-top:3px; letter-spacing:-.02em; font-variant-numeric:tabular-nums; color:var(--ink); }
  .kpi .v.up { color:var(--up); } .kpi .v.down { color:var(--down); }
  .kpi .cap { color:var(--muted); font-size:10px; margin-top:2px; }
  .kpi .cap.up { color:var(--up); }
  .approved-by { border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
  .approved-by .k { color:var(--muted); font-size:9.5px; letter-spacing:.10em; text-transform:uppercase; font-weight:700; }
  .approved-by .v { margin-top:3px; padding:5px 8px; border:1px solid var(--line); border-radius:4px; font-size:12px; min-height:20px; color:var(--ink); }
  .foot-note { color:var(--muted); font-size:10px; margin:4px 0 0 4px; }
  .page-footer { display:flex; justify-content:space-between; padding:6px 20px 0; font-size:10px; color:var(--muted); }
  @page { size: 14in 8.5in; margin: 0.18in; }
  @media print {
    html, body { background:#FFFFFF; }
    .page { margin:0; padding:0 12px; max-width:none; }
  }
</style>
</head><body>
<div class="page-header">
  <span class="date">${esc(pageDateStr)}</span>
  <span class="title">Forms &middot; Spend-Down Monitor</span>
</div>
<div class="page">
  ${yearSections}

  <div class="kpi-row">
    <div class="kpi">
      <div class="k">Total Award (Ceiling)</div>
      <div class="v">${esc(ceiling)}</div>
      <div class="cap">Fixed CCCCO Tier 2 grant award</div>
    </div>
    <div class="kpi">
      <div class="k">Modified Project Budget</div>
      <div class="v">${esc(money(modelTotal))}</div>
      <div class="cap">Both years, after modifications</div>
    </div>
    <div class="kpi">
      <div class="k">Variance vs Award</div>
      <div class="v ${varianceCls}">${esc(varianceStr)}</div>
      <div class="cap ${varianceCls}">${esc(varianceCap)}</div>
    </div>
    <div class="kpi">
      <div class="k">Modified Y1 / Y2</div>
      <div class="v">${esc(money(yearTotals.y1.proposed))} / ${esc(money(yearTotals.y2.proposed))}</div>
      <div class="cap">Baseline ${esc(money(yearBaselineTotals.y1))} / ${esc(money(yearBaselineTotals.y2))}</div>
    </div>
  </div>

  <div class="approved-by">
    <div class="k">Approved by CCCCO Staff</div>
    <div class="v">${approvedBy || ''}</div>
  </div>

  <p class="foot-note">Entries are saved automatically in this browser.</p>
</div>
<div class="page-footer">
  <span>${esc(pageDateStr)}</span>
  <span>Forms &middot; Spend-Down Monitor</span>
</div>
<div class="page-footer">
  <span>https://eeo.bulleconsulting.com/dashboard</span>
  <span>1/1</span>
</div>
</body></html>`;
}


// ---------- draft-started notice (admin only; never CCCCO) ----------
// Fires on the first PUT of a drafting session: no firstDraftAt recorded, or the
// recorded one has aged out, or there has been no activity inside the window.
const DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;
function draftNotifyDue(prev, nowMs) {
  if (!prev) return true;
  const first = Date.parse(prev.firstDraftAt || '');
  if (!isFinite(first)) return true;
  if (nowMs - first > DRAFT_WINDOW_MS) return true;
  const upd = Date.parse(prev.updatedAt || '');
  if (!isFinite(upd)) return true;
  if (nowMs - upd > DRAFT_WINDOW_MS) return true;
  return false;
}
function draftEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function draftBodyLines(label, districtSlug, body, whenIso) {
  const state = (body && body.state) || {};
  const meta = state.meta || {};
  const name = (body && body.name) || districtSlug;
  const lines = [
    label + ' draft activity started.',
    'District: ' + name + ' (' + districtSlug + ')',
    'First activity: ' + whenIso
  ];
  const by = meta.submittedBy || state.submittedBy || state.leadName || '';
  const em = meta.email || state.email || state.leadEmail || '';
  if (by) lines.push('Submitted by: ' + by);
  if (em) lines.push('Contact: ' + em);
  lines.push('');
  lines.push('Draft activity only - nothing has been submitted yet.');
  return { lines, name };
}
async function notifyDraftStarted(env, kind, districtSlug, body, whenIso) {
  const label = kind === 'bmr' ? 'BMR' : 'Report';
  const d = draftBodyLines(label, districtSlug, body, whenIso);
  return sendMail(env, {
    to: ['admin@bulleconsulting.com'],
    subject: '[' + label + ' draft started] ' + d.name,
    text: d.lines.join('\n'),
    html: '<p style="font:14px/1.6 Arial,sans-serif;color:#222">' + d.lines.map(draftEsc).join('<br>') + '</p>'
  });
}
