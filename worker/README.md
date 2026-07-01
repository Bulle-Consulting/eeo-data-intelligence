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

## Email sender

Email is sent by `sendSubmissionEmail()`, which prefers the **native Cloudflare
Email Service** (`env.EMAIL` send binding — already declared in `wrangler.toml`).
No third-party account or API key is required. If no `EMAIL` binding is present
it falls back to Resend (`RESEND_API_KEY`).

## One-time deploy

```bash
cd worker

# 1. KV store: already created (id is in wrangler.toml). To recreate:
#    npx wrangler kv namespace create BMR

# 2. Onboard a sending domain to Email Service so the Worker can email external
#    recipients (e.g. cccco.edu). In the Cloudflare dashboard:
#      Compute > Email Service > enable, then add & verify the sending domain
#      that MAIL_FROM uses (bulleconsulting.com). This adds DNS records.

# 3. Deploy.
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL (e.g. `https://bmr-sync.<account>.workers.dev`).

Until the sending domain is onboarded, the `EMAIL` binding can only reach
addresses verified as destinations in Email Routing — add `admin@bulleconsulting.com`
there to test end-to-end before the domain is fully onboarded.

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

Email is sent in `sendSubmissionEmail()` — native Cloudflare Email Service
first, Resend as fallback. To use a different provider (Postmark, SendGrid,
SES, …), change only that one function; the rest of the Worker is
provider-agnostic.
