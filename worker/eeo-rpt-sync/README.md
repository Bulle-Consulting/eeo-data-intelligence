# eeo-rpt-sync Worker

Submission relay for the district dashboards' **EEO IBP Grant Report** and
**Grant Modification Request** forms (plus a legacy Budget Modification
route). Renders the complete form — every answer, expenditure row, and
timeline activity — into the email body and an HTML attachment, and forwards
any file the dashboard attaches (the uploaded expenditure report, or the
dashboard-generated PDF copy of the Grant Modification form).

## Endpoints

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
