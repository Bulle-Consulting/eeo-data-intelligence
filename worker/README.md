# bmr-sync Worker

Shared store for District **Budget Modification Request (BMR)** data, and the
submission relay that emails a completed BMR to the CCCCO EEO inbox.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `PUT`  | `/bmr/{district}` | A district dashboard publishes its live BMR data (auto-sync). |
| `POST` | `/bmr/{district}/submit` | District **submits**: stores the record **and emails a full copy**. |
| `GET`  | `/bmr` | The "BMR Updates" (CRM) tab reads every district at once. |
| `GET`  | `/bmr/{district}` | Read a single district. |

## One-time deploy

```bash
cd worker

# 1. Create the KV store and paste the printed id into wrangler.toml (kv_namespaces).
npx wrangler kv namespace create BMR

# 2. Add your Resend API key as a secret (get one free at resend.com; verify your
#    sending domain so MAIL_FROM works, e.g. noreply@bulleconsulting.com).
npx wrangler secret put RESEND_API_KEY

# 3. Deploy.
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL (e.g. `https://bmr-sync.<account>.workers.dev`).

## Connect the dashboards

In each district dashboard's `index.html`, set:

```js
const BMR_SYNC_URL = 'https://bmr-sync.<account>.workers.dev';   // the URL from step 3
```

That single URL powers both the live CRM sync (`PUT`) and the Submit/Print
email (`POST /submit`). Recipients default to
`eeosubmissions@cccco.edu` and `admin@bulleconsulting.com` (change `SUBMIT_TO`
in `wrangler.toml` to adjust) — no per-user setup required.

## Swapping email providers

Email is sent in `sendSubmissionEmail()` via the Resend REST API. To use a
different provider (Postmark, SendGrid, MailChannels, SES, …), change only that
one function; the rest of the Worker is provider-agnostic.
