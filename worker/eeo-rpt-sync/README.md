# eeo-rpt-sync Worker

Submission relay for two of the district dashboards' three forms: the
**EEO IBP Grant Report** and the **Grant Modification Request Form**. (The
third, the **Budget Modification Request Form**, goes only through bmr-sync.)

## What is live (2026-11-23)

The deployed Worker is `live-worker.js`, not `worker.js`. `worker.js` and its
tests are an earlier rewrite that was never deployed. The live Worker:

- `POST /gmr/{slug}/submit`: the **Grant Modification Request Form**. Emailed as
  "Grant Modification Request Form — {district} — {date}" with the full form
  text and the dashboard's PDF (`Grant-Modification-Request-Form-….pdf`);
  stored as `gmr:{slug}`. Until 2026-11-23 this route did not exist, so the
  dashboards fell back to `/rpt` and the form was emailed labelled as an EEO
  IBP Grant Report. A Grant Modification Request Form that still arrives at
  `/rpt` (`formType: grant_modification_request`) is handled the same way.
- `POST /rpt/{district}/submit`: the **EEO IBP Grant Report**, emailed as
  "EEO IBP Grant Report — {district} — {date}" with a copy of the form
  (`EEO-IBP-Grant-Report-….html`) and any uploaded file; stored as `rpt:{district}`.
- Both go to `admin@bulleconsulting.com`, `eeosubmissions@cccco.edu` and
  `JLocust@cccco.edu`, whatever list the dashboard sends (`SUBMIT_TO`).
- If the email fails: HTTP 502 with `ok: false`, and the stored record is
  marked `mailed: false` so it doesn't count as submitted.
- `PUT /rpt/{district}` stores the in-progress EEO IBP Grant Report draft and
  emails an "[EEO IBP Grant Report draft started]" notice to
  `admin@bulleconsulting.com` only.
- `GET /rpt/{district}` returns only `{ submitted, submittedAt }`.
- No Budget Modification Request Form routes (`/bmr/...` answers 404).
- CORS and `PUT`/`POST` only from the dashboards' published origins and the
  EEO Dashboard; anything else gets 403.
- Emails come from `Bulle Consulting <noreply@bulleconsulting.com>`.
- KV binding `BMR_KV` is the same namespace as bmr-sync.

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
