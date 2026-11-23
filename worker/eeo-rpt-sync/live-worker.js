var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker_code.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
// Owner's rule (2026-11-23): Grant Report and Grant Modification Request
// submissions from any district go to these addresses, whatever the dashboard
// sends. Dr. Jonathan Locust (CCCCO) added at CCCCO's request of 2026-08-27.
var SUBMIT_TO = ["admin@bulleconsulting.com", "eeosubmissions@cccco.edu", "jlocust@cccco.edu"];
// Only the dashboards' published origins and the EEO Dashboard may use this
// service from a browser; only they may save or submit. (An Origin header can
// be forged outside a browser: this stops other websites, not command-line tools.)
var ALLOWED_ORIGINS = [
  "https://wardere83.github.io",
  "https://bulle-consulting.github.io",
  "https://eeo.bulleconsulting.com",
  "https://projects.bulleconsulting.com"
];
var worker_code_default = {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    if (request.method === "OPTIONS" && !allowed) return new Response("forbidden", { status: 403, headers: { vary: "Origin" } });
    if ((request.method === "PUT" || request.method === "POST") && !allowed) return new Response("forbidden", { status: 403, headers: { vary: "Origin" } });
    const res = await route(request, env, ctx);
    const h = new Headers(res.headers);
    h.delete("Access-Control-Allow-Origin");
    h.delete("Access-Control-Allow-Methods");
    h.delete("Access-Control-Allow-Headers");
    h.set("vary", "Origin");
    if (allowed) for (const [k, v] of Object.entries(CORS)) h.set(k, k === "Access-Control-Allow-Origin" ? origin : v);
    return new Response(res.body, { status: res.status, headers: h });
  }
};
// Public read: only whether a record is a submission and when. Drafts, names,
// emails and answers never leave. No dashboard reads a record back.
function publicStatus(s) {
  const submittedAt = s && s.submittedAt ? String(s.submittedAt) : null;
  const res = json({ submitted: !!submittedAt, submittedAt });
  res.headers.set("cache-control", "no-store");
  return res;
}
async function route(request, env, ctx) {
  {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health") return json({ ok: true });
    const rptMatch = path.match(/^\/rpt\/([^/]+)\/submit$/);
    if (rptMatch && request.method === "POST") return handleRptSubmit(request, env, rptMatch[1]);
    const rptState = path.match(/^\/rpt\/([^/]+)$/);
    if (rptState && request.method === "GET") return handleRptGet(request, env, rptState[1]);
    if (rptState && request.method === "PUT") return handleRptPut(request, env, rptState[1]);
    const bmrSubmit = path.match(/^\/bmr\/([^/]+)\/submit$/);
    if (bmrSubmit && request.method === "POST") return handleBmrSubmit(request, env, bmrSubmit[1]);
    const bmrGet = path.match(/^\/bmr\/([^/]+)$/);
    if (bmrGet && request.method === "GET") return handleBmrGet(request, env, bmrGet[1]);
    return json({ error: "not found" }, 404);
  }
}
async function handleRptSubmit(request, env, districtSlug) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const {
    district = districtSlug,
    state = {},
    submittedAt = (/* @__PURE__ */ new Date()).toISOString(),
    uploadFileName = null,
    uploadFileB64 = null
  } = body;
  const recipients = SUBMIT_TO.slice();
  const subject = `EEO IBP Grant Report \u2014 ${district} \u2014 ${fmtDate(submittedAt)}`;
  const htmlBody = buildRptHtml(state, district, submittedAt);
  const textBody = buildRptText(state, district, submittedAt);
  const attachments = [{ filename: 'form-submission.html', content: btoa(unescape(encodeURIComponent(htmlBody))), type: 'text/html' }];
  if (uploadFileB64 && uploadFileName) {
    attachments.push({ filename: uploadFileName, content: uploadFileB64, type: mimeFor(uploadFileName), disposition: "attachment" });
  }
  if (env.BMR_KV) {
      try {
        await env.BMR_KV.put("rpt:" + districtSlug, JSON.stringify({ district, state, submittedAt }));
      } catch (_) {
      }
    }
    const sendResult = await sendEmail({ env, to: recipients, subject, html: htmlBody, text: textBody, attachments, from: { email: "noreply@bulleconsulting.com", name: "Bulle Consulting \u2014 EEO Portal" } });
  if (!sendResult.ok) return json({ ok: false, error: sendResult.error, district: districtSlug });
  return json({ ok: true, district: districtSlug, mailed: true, recipients });
}
__name(handleRptSubmit, "handleRptSubmit");
async function handleBmrSubmit(request, env, districtSlug) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const { district = districtSlug, state = {}, submittedAt = (/* @__PURE__ */ new Date()).toISOString() } = body;
  const recipients = SUBMIT_TO.slice();
  const meta = state.meta || {};
  const subject = `Budget Modification Request \u2014 ${district} \u2014 ${fmtDate(submittedAt)}`;
  const sendResult = await sendEmail({ env, to: recipients, subject, html: `<h2>Budget Modification Request</h2><p><b>District:</b> ${district}<br><b>Submitted by:</b> ${meta.submittedBy || ""}<br><b>Date:</b> ${fmtDate(submittedAt)}</p>`, text: `Budget Modification Request
District: ${district}
Submitted by: ${meta.submittedBy || ""}
Date: ${fmtDate(submittedAt)}`, attachments: [{ filename: 'Budget-Modification-Request.html', content: btoa(unescape(encodeURIComponent(buildBmrHtmlBody(state, districtSlug, meta, submittedAt)))), type: 'text/html' }], from: { email: "noreply@bulleconsulting.com", name: "Bulle Consulting \u2014 EEO Portal" } });
  if (env.BMR_KV) {
    try {
      await env.BMR_KV.put(`bmr:${districtSlug}`, JSON.stringify({ district, state, submittedAt }));
    } catch (_) {
    }
  }
  if (!sendResult.ok) return json({ ok: false, error: sendResult.error });
  return json({ ok: true, district: districtSlug, mailed: true, recipients });
}
__name(handleBmrSubmit, "handleBmrSubmit");
async function handleBmrGet(request, env, districtSlug) {

  function buildBmrHtmlBody(state, district, meta, submittedAt) { const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}) : ''; const rows = (state.rows||[]).map(r=>`<tr><td>${r.code||''}</td><td>${r.description||''}</td><td>$${Number(r.current||0).toLocaleString()}</td><td>$${Number(r.proposed||0).toLocaleString()}</td><td>${r.justification||''}</td></tr>`).join(''); return `<!DOCTYPE html><html><head><meta charset='utf-8'><title>Budget Modification Request</title><style>body{font-family:Arial,sans-serif;margin:40px;color:#1a1f2e;}h1{color:#003E5A;border-bottom:3px solid #FFCD00;padding-bottom:10px;}h2{color:#003E5A;margin-top:24px;}table{width:100%;border-collapse:collapse;margin-top:12px;}th{background:#003E5A;color:#fff;padding:8px 10px;text-align:left;font-size:12px;}td{padding:8px 10px;border-bottom:1px solid #ddd;font-size:13px;}.meta{background:#f3f6f9;padding:16px;border-radius:8px;margin-bottom:20px;}.meta p{margin:4px 0;font-size:13px;}</style></head><body><h1>Budget Modification Request</h1><div class='meta'><p><strong>District:</strong> ${district}</p><p><strong>Submitted By:</strong> ${(meta&&meta.submittedBy)||''}</p><p><strong>Email:</strong> ${(meta&&meta.email)||''}</p><p><strong>Submission Date:</strong> ${fmtDate(submittedAt)}</p></div><h2>Year 1 Modifications</h2><table><thead><tr><th>Code</th><th>Description</th><th>Current</th><th>Proposed</th><th>Justification</th></tr></thead><tbody>${(state.y1rows||[]).map(r=>`<tr><td>${r.code||''}</td><td>${r.description||''}</td><td>$${Number(r.current||0).toLocaleString()}</td><td>$${Number(r.proposed||0).toLocaleString()}</td><td>${r.justification||''}</td></tr>`).join('')}</tbody></table><h2>Year 2 Modifications</h2><table><thead><tr><th>Code</th><th>Description</th><th>Current</th><th>Proposed</th><th>Justification</th></tr></thead><tbody>${(state.y2rows||[]).map(r=>`<tr><td>${r.code||''}</td><td>${r.description||''}</td><td>$${Number(r.current||0).toLocaleString()}</td><td>$${Number(r.proposed||0).toLocaleString()}</td><td>${r.justification||''}</td></tr>`).join('')}</tbody></table><p style='margin-top:24px;font-size:12px;color:#666;'>Submitted on ${fmtDate(submittedAt)}</p></body></html>`; }
  if (env.BMR_KV) {
    try {
      const s = await env.BMR_KV.get(`bmr:${districtSlug}`, "json");
      return publicStatus(s);
    } catch (_) {
    }
  }
  return publicStatus(null);
}
__name(handleBmrGet, "handleBmrGet");
async function sendEmail({ env, to, subject, html, text, attachments = [], from }) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "no RESEND_API_KEY configured" };
  const toArr = Array.isArray(to) ? to : [to];
  let fromStr;
  if (from && typeof from === "object") {
  fromStr = from.name ? `${from.name} <${from.email}>` : from.email;
  } else if (typeof from === "string" && from) {
  fromStr = from;
  } else {
  fromStr = env.SENDER_ADDR || "Bulle Consulting — EEO Portal <noreply@bulleconsulting.com>";
  }
  const atts = (attachments || []).map((a) => ({
  filename: a.filename,
  content: a.content,
  ...(a.content_type || a.type ? { content_type: a.content_type || a.type } : {})
  }));
  const body = { from: fromStr, to: toArr, subject, text, html };
  if (atts.length > 0) body.attachments = atts;
  try {
  const resp = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
  body: JSON.stringify(body)
  });
  if (resp.status >= 200 && resp.status < 300) return { ok: true };
  const err = await resp.text().catch(() => `${resp.status}`);
  return { ok: false, error: `Resend ${resp.status}: ${String(err).slice(0, 200)}` };
  } catch (e) {
  return { ok: false, error: String(e) };
  }
  }
__name(sendEmail, "sendEmail");
function buildRptHtml(s, district, submittedAt) {
  const esc = /* @__PURE__ */ __name((v) => String(v || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "esc");
  const row = /* @__PURE__ */ __name((l, v) => v ? `<tr><td style="padding:5px 10px;font-weight:600;color:#1a2e5a;font-size:13px;white-space:nowrap;">${esc(l)}</td><td style="padding:5px 10px;font-size:13px;color:#333;">${esc(v)}</td></tr>` : "", "row");
  const sec = /* @__PURE__ */ __name((t) => `<tr><td colspan="2" style="padding:12px 10px 3px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6b00;border-top:1px solid #e2e8f0;">${esc(t)}</td></tr>`, "sec");
  let exRows = "";
  if (Array.isArray(s.expenditures) && s.expenditures.length) {
    s.expenditures.forEach((ex, i) => {
      exRows += `<tr style="background:${i % 2 ? "#fff" : "#f8f9fb"}"><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${esc(ex.type)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${esc(ex.year)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;">${esc(ex.description)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:right;">${esc(ex.approved)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:right;">${esc(ex.spent)}</td><td style="padding:5px 8px;font-size:12px;border:1px solid #e2e8f0;text-align:right;">${esc(ex.balance)}</td></tr>`;
    });
  } else {
    exRows = '<tr><td colspan="6" style="padding:8px;text-align:center;color:#888;font-size:12px;">No expenditures entered</td></tr>';
  }
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:0;"><div style="max-width:720px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.1);"><div style="background:#1a2e5a;padding:20px 28px;"><div style="color:#fff;font-size:18px;font-weight:700;">EEO IBP Grant Report</div><div style="color:#c8a84b;font-size:12px;margin-top:3px;">Submitted ${fmtDate(submittedAt)} \xB7 ${esc(district)}</div></div><div style="padding:20px 28px;"><table style="width:100%;border-collapse:collapse;">${sec("Contact & Team")}${row("District", s.district)}${row("Project Lead", s.leadName)}${row("Lead Email", s.leadEmail)}${row("Support Staff", s.staffName)}${row("Staff Email", s.staffEmail)}${row("Team Changed", s.teamChanged)}${row("Team Detail", s.teamChangedDetail)}${sec("Grant Goals")}${row("Goals", s.goals)}${row("Goals Met", s.goalsMet)}${row("Goals Detail", s.goalsMetDetail)}${row("Updates", s.updates)}${row("Updates Detail", s.updatesDetail)}${sec("Barriers")}${row("Barriers", s.barriers)}</table><div style="margin:16px 0 6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8a6b00;border-top:1px solid #e2e8f0;padding-top:12px;">Total Grant Expenditures</div><table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;"><thead><tr style="background:#1a2e5a;color:#fff;"><th style="padding:6px 8px;font-size:12px;">Type</th><th style="padding:6px 8px;font-size:12px;">Year</th><th style="padding:6px 8px;font-size:12px;">Description</th><th style="padding:6px 8px;font-size:12px;text-align:right;">Approved</th><th style="padding:6px 8px;font-size:12px;text-align:right;">Spent</th><th style="padding:6px 8px;font-size:12px;text-align:right;">Balance</th></tr></thead><tbody>${exRows}</tbody></table><table style="width:100%;border-collapse:collapse;margin-top:4px;">${sec("Upload")}${row("Uploaded File", s._uploadFileName || "None")}${sec("Budget Modification")}${row("Intent", s.bmrIntent)}${sec("Optional")}${row("Comments", s.optional || "\u2014")}${sec("Certification")}${row("Certified By", s.certify)}${row("Submitted At", fmtDate(submittedAt))}</table></div><div style="background:#f0f4f8;padding:12px 28px;font-size:11px;color:#666;text-align:center;">Bulle Consulting \xB7 EEO IBP Grant Portal \xB7 Automated submission copy.</div></div></body></html>`;
}
__name(buildRptHtml, "buildRptHtml");
function buildRptText(s, district, submittedAt) {
  const v = /* @__PURE__ */ __name((x) => x || "\u2014", "v");
  const lines = [`EEO IBP GRANT REPORT`, `District: ${v(district)}`, `Submitted: ${fmtDate(submittedAt)}`, ``, `CONTACT & TEAM`, `Lead: ${v(s.leadName)} | ${v(s.leadEmail)}`, `Staff: ${v(s.staffName)} | ${v(s.staffEmail)}`, `Team Changed: ${v(s.teamChanged)}`, s.teamChangedDetail ? `Detail: ${s.teamChangedDetail}` : "", ``, `GRANT GOALS`, `Goals: ${v(s.goals)}`, `Goals Met: ${v(s.goalsMet)}`, s.goalsMetDetail ? s.goalsMetDetail : "", `Updates: ${v(s.updates)}`, s.updatesDetail ? s.updatesDetail : "", ``, `BARRIERS`, v(s.barriers), ``, `EXPENDITURES`];
  if (Array.isArray(s.expenditures) && s.expenditures.length) s.expenditures.forEach((ex, i) => lines.push(`${i + 1}. ${ex.type}|${ex.year}|${ex.description}|${ex.approved}|${ex.spent}|${ex.balance}`));
  lines.push(``, `Upload: ${v(s._uploadFileName)}`, `BMR Intent: ${v(s.bmrIntent)}`, ``, `OPTIONAL`, v(s.optional), ``, `CERTIFIED BY: ${v(s.certify)}`, `Bulle Consulting \xB7 EEO IBP Grant Portal`);
  return lines.filter((l) => l !== void 0).join("\n");
}
__name(buildRptText, "buildRptText");
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
__name(json, "json");
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch (_) {
    return iso;
  }
}
__name(fmtDate, "fmtDate");
function mimeFor(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  return { "pdf": "application/pdf", "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xls": "application/vnd.ms-excel", "csv": "text/csv", "doc": "application/msword", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[ext] || "application/octet-stream";
}
__name(mimeFor, "mimeFor");
async function handleRptGet(request, env, districtSlug) {
  if (env.BMR_KV) {
    try {
      const s = await env.BMR_KV.get("rpt:" + districtSlug, "json");
      return publicStatus(s);
    } catch (_) {
    }
  }
  return publicStatus(null);
}
async function handleRptPut(request, env, districtSlug) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  if (!env.BMR_KV) return json({ ok: false, error: "no KV binding" }, 500);
  const nowIso = new Date().toISOString();
  let prev = null;
  try {
    prev = await env.BMR_KV.get("rpt:" + districtSlug, "json");
  } catch (_) {
  }
  const due = draftNotifyDue(prev, Date.parse(nowIso));
  const record = {
    district: districtSlug,
    name: body && body.name || "",
    state: body && body.state || {},
    updatedAt: nowIso,
    firstDraftAt: due ? nowIso : prev && prev.firstDraftAt || nowIso
  };
  try {
    await env.BMR_KV.put("rpt:" + districtSlug, JSON.stringify(record));
  } catch (_) {
    return json({ ok: false, error: "kv write failed" }, 500);
  }
  let notified = false;
  if (due) {
    try {
      const sent = await notifyDraftStarted(env, "rpt", districtSlug, body, nowIso);
      notified = !!(sent && sent.ok);
    } catch (_) {
    }
  }
  return json({ ok: true, district: districtSlug, updatedAt: record.updatedAt, notified });
}
var DRAFT_WINDOW_MS = 24 * 60 * 60 * 1e3;
function draftNotifyDue(prev, nowMs) {
  if (!prev) return true;
  const first = Date.parse(prev.firstDraftAt || "");
  if (!isFinite(first)) return true;
  if (nowMs - first > DRAFT_WINDOW_MS) return true;
  const upd = Date.parse(prev.updatedAt || "");
  if (!isFinite(upd)) return true;
  if (nowMs - upd > DRAFT_WINDOW_MS) return true;
  return false;
}
function draftEsc(v) {
  return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function draftBodyLines(label, districtSlug, body, whenIso) {
  const state = body && body.state || {};
  const meta = state.meta || {};
  const name = body && body.name || districtSlug;
  const lines = [
    label + " draft activity started.",
    "District: " + name + " (" + districtSlug + ")",
    "First activity: " + whenIso
  ];
  const by = meta.submittedBy || state.submittedBy || state.leadName || "";
  const em = meta.email || state.email || state.leadEmail || "";
  if (by) lines.push("Submitted by: " + by);
  if (em) lines.push("Contact: " + em);
  lines.push("");
  lines.push("Draft activity only - nothing has been submitted yet.");
  return { lines, name };
}
async function notifyDraftStarted(env, kind, districtSlug, body, whenIso) {
  const label = kind === "bmr" ? "BMR" : "Report";
  const d = draftBodyLines(label, districtSlug, body, whenIso);
  return sendEmail({
    env,
    to: ["admin@bulleconsulting.com"],
    subject: "[" + label + " draft started] " + d.name,
    text: d.lines.join("\n"),
    html: '<p style="font:14px/1.6 Arial,sans-serif;color:#222">' + d.lines.map(draftEsc).join("<br>") + "</p>"
  });
}
export {
  worker_code_default as default
};



