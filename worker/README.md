# bmr-sync Worker

Shared store for District **Budget Modification Request (BMR)** data, and the
submission relay that emails a completed BMR to the CCCCO EEO inbox.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `PUT`  | `/bmr/{district}` | A district dashboard publishes its live BMR data (auto-sync). |
| `POST` | `/bmr/{district}/submit` | District **submits**: stores the record **and emails a full copy**. |
| `GET`  | `/bmr/{district}` | Public status for the "BMR Updates" tab: `{ submitted, submittedAt }` only. |
| `GET`  | `/health` | Liveness check. |

## Who can read and write

- `GET /bmr/{district}` never returns names, emails, phone numbers, the form
  or the PDF. No dashboard reads its record back: the forms keep their drafts
  in the browser. A district counts as submitted when its record has a
  submission date, a submitter and a budget.
- CORS is granted only to the dashboards' published origins and the EEO
  Dashboard (`ALLOWED_ORIGINS` in `bmr-sync.js`). `PUT` and `POST` from any
  other origin, or with no Origin, get `403`.
- Limit: the Origin header is set by browsers, so this stops other websites
  and casual use, not someone who forges the header with command-line tools.
  The stored records stay private either way, because no route returns them.
  Fully closing writes would need a secret only the server knows, for example
  the EEO Dashboard signing each district user's request.

## One Worker for every district (current and future)

This Worker is district-agnostic. It keys everything off the `{district}` in the
URL (`/bmr/{district}/submit`), stores one KV record per district, and defaults
recipients from `SUBMIT_TO`. Any dashboard — existing or brand new — just needs
to point its `BMR_SYNC_URL` at this one Worker; no per-district Worker changes,
redeploys, or new infrastructure are required. Add a district by deploying its
dashboard with a unique `BMR_SYNC_ID` and the shared `BMR_SYNC_URL`.

Every submission email includes the **full form as an HTML attachment**
(`Budget_Modification_<district>_<date>.html`) containing every section —
meta, both years with complete justifications, and the reconciliation summary —
so nothing is ever clipped.

## Email sender

Email is sent by `sendMail()` through Resend (`RESEND_API_KEY` secret, sender
from the `SENDER_ADDR` secret). The PDF is rendered by Cloudflare Browser
Rendering (`CF_API_TOKEN` secret). Recipients come from the submitted form,
falling back to `eeosubmissions@cccco.edu` and `admin@bulleconsulting.com`.

## Deploy

The live Worker's bindings (KV `BMR_STATE` and the secrets above) are not the
ones in `wrangler.toml`, so never run a plain `wrangler deploy` in this folder.
Run the deploy script instead. It signs in to Cloudflare in your browser,
deploys `bmr-sync.js` with the live Worker's own settings, checks the result
and signs out:

```bash
sh worker/deploy-bmr-sync.sh
```

It stops first if the BMR Updates tab is not yet published with the new
reading code, or if the live Worker was changed outside this repository.

## Connect the dashboards

In each district dashboard's `index.html`, set:

```js
const BMR_SYNC_URL = 'https://bmr-sync.shrill-king-ef4e.workers.dev';
```

That single URL powers both the live sync (`PUT`) and the Submit/Print
email (`POST /submit`). A dashboard published at a new address also needs
that address's origin added to `ALLOWED_ORIGINS` in `bmr-sync.js`.

## Swapping email providers

Email is sent in `sendMail()`. To use a different provider, change only that
one function; the rest of the Worker is provider-agnostic.
