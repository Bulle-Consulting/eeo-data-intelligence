/**
 * bmr-sync - shared store for District Budget Modification Request (BMR) data,
 * plus a submission relay that emails a completed BMR to the CCCCO EEO inbox.
 *
 * Endpoints:
 *   PUT  /bmr/{district}         - a district dashboard publishes its live BMR data
 *   POST /bmr/{district}/submit  - district submits: store the record + email a full copy
 *   GET  /bmr                    - the BMR Updates (CRM) tab reads every district at once
 *   GET  /bmr/{district}         - read a single district
 *
 * Storage: KV namespace bound as BMR (key per district, last write wins).
 *
 * Email (POST /submit): sent via Resend. Configure on the Worker:
 *   RESEND_API_KEY  (secret)      - `npx wrangler secret put RESEND_API_KEY`
 *   MAIL_FROM       (var)         - verified sender, e.g. "EEO Grant Forms <noreply@bulleconsulting.com>"
 *   SUBMIT_TO       (var, optional) - comma-separated default recipients; overridden by the request body
 */
const DEFAULT_TO = ['eeosubmissions@cccco.edu', 'admin@bulleconsulting.com'];
const YEARS = {
  y1: { label: 'Year 1', dates: 'Jan 2026 – Jun 2027' },
  y2: { label: 'Year 2', dates: 'Jul 2027 – Jun 2028' }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'bmr') return new Response('Not found', { status: 404, headers: cors });
    const json = { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' };

    // Submit: persist the record (so the CRM tab shows it) AND email a full copy.
    if (request.method === 'POST' && parts[1] && parts[2] === 'submit') {
      const district = parts[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!district) return new Response('Bad district', { status: 400, headers: cors });
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
      if (JSON.stringify(body).length > 200000) return new Response('Too large', { status: 413, headers: cors });

      const now = new Date().toISOString();
      const record = { ...body, district, submitted: true, submittedAt: body.submittedAt || now, updatedAt: now };
      await env.BMR.put('bmr:' + district, JSON.stringify(record));

      const to = (Array.isArray(body.recipients) && body.recipients.length)
        ? body.recipients
        : (env.SUBMIT_TO ? env.SUBMIT_TO.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_TO);
      try {
        await sendSubmissionEmail(env, to, record);
      } catch (e) {
        // The record is stored; report the email failure so the client can fall back.
        return new Response(JSON.stringify({ ok: false, stored: true, error: String((e && e.message) || e) }), { status: 502, headers: json });
      }
      return new Response(JSON.stringify({ ok: true, district, emailed: to }), { headers: json });
    }

    if (request.method === 'PUT' && parts[1] && !parts[2]) {
      const district = parts[1].toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!district) return new Response('Bad district', { status: 400, headers: cors });
      let body;
      try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers: cors }); }
      if (JSON.stringify(body).length > 200000) return new Response('Too large', { status: 413, headers: cors });
      const record = { ...body, district, updatedAt: new Date().toISOString() };
      await env.BMR.put('bmr:' + district, JSON.stringify(record));
      return new Response(JSON.stringify({ ok: true, district }), { headers: json });
    }

    if (request.method === 'GET' && !parts[1]) {
      const list = await env.BMR.list({ prefix: 'bmr:' });
      const out = [];
      for (const k of list.keys) {
        const v = await env.BMR.get(k.name);
        if (v) { try { out.push(JSON.parse(v)); } catch {} }
      }
      return new Response(JSON.stringify({ districts: out }), { headers: json });
    }

    if (request.method === 'GET' && parts[1]) {
      const v = await env.BMR.get('bmr:' + parts[1].toLowerCase());
      return new Response(v || 'null', { headers: json });
    }

    return new Response('Method not allowed', { status: 405, headers: cors });
  }
};

/* ── Email rendering ───────────────────────────────────────────────────────── */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function money(v) {
  return (v == null || v === '') ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US');
}
function yearTotal(baseline, rows, yk) {
  return baseline.reduce((s, b) => {
    const r = (rows && rows[b.code]) || {};
    return s + (r.proposed != null ? r.proposed : b[yk]);
  }, 0);
}

function renderYearHtml(baseline, rows, yk) {
  const y = YEARS[yk] || { label: yk, dates: '' };
  const body = baseline.map(b => {
    const r = (rows && rows[b.code]) || {};
    const proposed = r.proposed != null ? r.proposed : b[yk];
    const cell = 'border:1px solid #ddd;padding:6px 8px';
    return `<tr>
      <td style="${cell};font-weight:600">${esc(b.code)}</td>
      <td style="${cell}">${esc(r.description || b.label)}</td>
      <td style="${cell};text-align:right">${money(proposed)}</td>
      <td style="${cell};text-align:right">${money(r.actuals)}</td>
      <td style="${cell};text-align:right">${money(r.balance)}</td>
      <td style="${cell};text-align:right">${money(r.projections)}</td>
      <td style="${cell}">${esc(r.updates || '')}</td>
    </tr>`;
  }).join('');
  const th = 'border:1px solid #ddd;padding:6px 8px;text-align:left;background:#f3f4f6;font-size:12px';
  return `<h3 style="margin:18px 0 6px">${esc(y.label)} · ${esc(y.dates)} — Modified total: ${money(yearTotal(baseline, rows, yk))}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px">
      <thead><tr>
        <th style="${th}">Type</th><th style="${th}">Description</th>
        <th style="${th}">Proposed</th><th style="${th}">Actuals</th>
        <th style="${th}">Fund Balance</th><th style="${th}">Projections</th>
        <th style="${th}">Expenditure Update (justification)</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function renderEmailHtml(record) {
  const meta = (record.state && record.state.meta) || {};
  const baseline = record.baseline || [];
  const years = (record.state && record.state.years) || {};
  const yhtml = ['y1', 'y2'].map(yk => renderYearHtml(baseline, (years[yk] && years[yk].rows) || {}, yk)).join('');
  const row = (k, v) => v ? `<tr><td style="padding:2px 10px 2px 0;color:#555">${esc(k)}</td><td style="padding:2px 0"><strong>${esc(v)}</strong></td></tr>` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:820px">
    <h2 style="margin:0 0 4px">Budget Modification Request</h2>
    <div style="color:#555;margin-bottom:12px">${esc(record.name || meta.district || record.district || '')}</div>
    <table style="font-size:13px;margin-bottom:8px">
      ${row('Submitted by', meta.submittedBy)}
      ${row('Email', meta.email)}
      ${row('Submission date', meta.date)}
      ${row('Approved by', meta.approvedBy)}
      ${row('Total award (ceiling)', money(record.award))}
    </table>
    ${yhtml}
    <p style="color:#888;font-size:12px;margin-top:18px">Submitted via the EEO district dashboard on ${esc(record.submittedAt || '')}.</p>
  </div>`;
}

function renderEmailText(record) {
  const meta = (record.state && record.state.meta) || {};
  const baseline = record.baseline || [];
  const years = (record.state && record.state.years) || {};
  const L = ['BUDGET MODIFICATION REQUEST', (record.name || meta.district || record.district || ''), ''];
  if (meta.submittedBy) L.push('Submitted by: ' + meta.submittedBy);
  if (meta.email) L.push('Email: ' + meta.email);
  if (meta.date) L.push('Submission date: ' + meta.date);
  if (meta.approvedBy) L.push('Approved by: ' + meta.approvedBy);
  L.push('Total award (ceiling): ' + money(record.award), '');
  ['y1', 'y2'].forEach(yk => {
    const rows = (years[yk] && years[yk].rows) || {};
    const y = YEARS[yk] || { label: yk, dates: '' };
    L.push('== ' + y.label.toUpperCase() + ' · ' + y.dates + ' ==  Modified total: ' + money(yearTotal(baseline, rows, yk)));
    baseline.forEach(b => {
      const r = rows[b.code] || {};
      const proposed = r.proposed != null ? r.proposed : b[yk];
      L.push(b.code + ' ' + b.label);
      L.push('    Proposed ' + money(proposed) + ' | Actuals ' + money(r.actuals) +
             ' | Fund Balance ' + money(r.balance) + ' | Projections ' + money(r.projections));
      if (r.updates && String(r.updates).trim()) L.push('    Update: ' + String(r.updates).trim());
    });
    L.push('');
  });
  return L.join('\n');
}

async function sendSubmissionEmail(env, to, record) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured on the Worker');
  const meta = (record.state && record.state.meta) || {};
  const name = record.name || meta.district || record.district || 'District';
  const subject = 'Budget Modification Request — ' + name + (meta.date ? ' (' + meta.date + ')' : '');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || 'EEO Grant Forms <noreply@bulleconsulting.com>',
      to,
      reply_to: meta.email || undefined,
      subject,
      html: renderEmailHtml(record),
      text: renderEmailText(record)
    })
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return true;
}
