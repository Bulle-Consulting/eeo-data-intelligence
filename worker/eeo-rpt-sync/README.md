# eeo-rpt-sync Worker

Submission relay for the district dashboards' **EEO IBP Grant Report** and
**Grant Modification Request** forms (plus a legacy Budget Modification
route). Renders the complete form — every answer, expenditure row, and
timeline activity — into the email body and an HTML attachment, and forwards
any file the dashboard attaches (the uploaded expenditure report, or the
dashboard-generated PDF copy of the Grant Modification form).

## What is live (2026-11-23)

The deployed Worker is `live-worker.js` (version f62861ff), not `worker.js`.
`worker.js` and its tests are an earlier rewrite that adds a `/gmr` route; it
was never deployed and lacks the live draft saving. The live Worker:

- `POST /rpt/{district}/submit` emails the **EEO IBP Grant Report**. The
  dashboards also send the **Grant Modification Request** here, because the
  live Worker has no `/gmr` route (they try `/gmr`, get 404, fall back).
- Both go to `admin@bulleconsulting.com`, `eeosubmissions@cccco.edu` and
  `JLocust@cccco.edu`, whatever list the dashboard sends (`SUBMIT_TO`;
  owner's rule 2026-11-23, Dr. Locust added at CCCCO's request).
- `PUT /rpt/{district}` stores the in-progress report draft (KV `rpt:{district}`,
  binding `BMR_KV`, the same namespace as bmr-sync) and emails a
  "[Report draft started]" notice to `admin@bulleconsulting.com` only.
- `GET /rpt/{district}` and `GET /bmr/{district}` return only
  `{ submitted, submittedAt }`; no dashboard reads a record back.
- CORS and `PUT`/`POST` only from the dashboards' published origins and the
  EEO Dashboard; anything else gets 403.
- The legacy `POST /bmr/{district}/submit` route crashes (an undefined
  helper). It is unused: BMRs go through bmr-sync.
- Emails come from `Bulle Consulting — EEO Portal <noreply@bulleconsulting.com>`.

Deploy it with the live Worker's own settings (`wrangler init --from-dash
eeo-rpt-sync`, replace `src/worker_code.js` with `live-worker.js`, deploy),
never with this folder's `wrangler.toml`, which lacks the KV binding.

## Endpoints (worker.js, not deployed)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/rpt/{district}/submit` | EEO IBP Grant Report → emails the full report. |
| `POST` | `/gmr/{district}/submit` | Grant Modification Request → properly-labelled email with the full form. |
| `POST` | `/bmr/{district}/submit` | Legacy Budget Modification relay (bmr-sync is the primary). |
| `GET`  | `/bmr/{district}` | Read the stored BMR record (KV, optional). |
| `GET`  | `/health` | Liveness check. |

## Deploy

```bash
cd worker/eeo-rpt-sync
npx wrangler deploy

# One-time: the email-sending key (fixes "Submission error: no RESEND_API_KEY
# configured" on the Grant Report form). Secrets survive future deploys.
npx wrangler secret put RESEND_API_KEY
```

The dashboards already point at
`https://eeo-rpt-sync.shrill-king-ef4e.workers.dev` and are
backwards-compatible: until this version is deployed they automatically fall
back from `/gmr/...` (404 on the old Worker) to the `/rpt/...` route, and if
the Worker can't send email at all they open the staff member's own mail app
with a complete copy of the form.

## Email sender

`sendEmail()` uses Resend (`RESEND_API_KEY` secret, `SENDER_ADDR` var
optional). Swap providers by changing only that function.
