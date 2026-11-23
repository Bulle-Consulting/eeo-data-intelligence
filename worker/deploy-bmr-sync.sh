#!/bin/sh
# Deploy worker/bmr-sync.js to the live bmr-sync Worker.
#
# The live Worker's bindings (KV "BMR_STATE", secrets RESEND_API_KEY,
# SENDER_ADDR, CF_API_TOKEN) are not the ones in wrangler.toml, so a plain
# `wrangler deploy` here would break it. This script downloads the live
# Worker's own settings, swaps in this folder's bmr-sync.js and deploys that.
# Secrets are kept by Cloudflare across deploys.
#
# Run from anywhere:  sh worker/deploy-bmr-sync.sh
# It signs in to Cloudflare in your browser if needed and signs out at the end.
set -eu
cd "$(dirname "$0")"
W="${WRANGLER:-npx --yes wrangler@4.86.0}"   # WRANGLER is for testing only
URL="https://bmr-sync.shrill-king-ef4e.workers.dev"
TAB="https://bulle-consulting.github.io/eeo-data-intelligence/"
PREVIOUS=dc7ac00   # the commit whose bmr-sync.js is live (deployed 2026-11-23)

# 1. The BMR Updates tab must already read the new reply, or it would show
#    every district as "No submission yet".
if ! curl -fsS "$TAB" | grep -q "typeof d.submitted === 'boolean'"; then
  echo "Stop: the EEO Data Intelligence Dashboard is not yet showing the updated BMR Updates tab. Wait for it to publish, then run this again." >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; $W logout >/dev/null 2>&1 || true' EXIT

# 2. Sign in (opens the browser) unless already signed in.
$W whoami 2>&1 | grep -q "You are logged in" || $W login

# 3. Download the live Worker and its settings.
(cd "$TMP" && $W init --from-dash bmr-sync --no-delegate-c3 >/dev/null)
CONF="$TMP/bmr-sync/wrangler.jsonc"
MAIN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).main)" "$CONF")
LIVE="$TMP/bmr-sync/$MAIN"

# 4. Stop if someone changed the live Worker outside this repository.
#    Cloudflare hands back the bundled code a deploy uploaded, so compare the
#    live code with the source and with the source bundled the same way.
git show "$PREVIOUS:worker/bmr-sync.js" > "$TMP/previous.js"
bundle() {   # bundle <source> <out dir>: the code `wrangler deploy` would upload
  mkdir -p "$2/src" && cp "$CONF" "$2/wrangler.jsonc" && cp "$1" "$2/src/$(basename "$MAIN")"
  (cd "$2" && $W deploy --dry-run --outdir out --config wrangler.jsonc >/dev/null 2>&1) &&
    grep -v sourceMappingURL "$2/out/$(basename "$MAIN")"
}
grep -v sourceMappingURL "$LIVE" > "$TMP/live.js"
matches() {  # matches <source>: the live code is this source, raw or bundled
  diff -qw "$1" "$LIVE" >/dev/null && return 0
  rm -rf "$TMP/b" && bundle "$1" "$TMP/b" > "$TMP/bundled.js" && diff -q "$TMP/bundled.js" "$TMP/live.js" >/dev/null
}
if ! matches "$TMP/previous.js" && ! matches bmr-sync.js; then
  if [ "${FORCE:-}" != "1" ]; then
    diff -uw "$TMP/previous.js" "$LIVE" > "$TMP/live-changes.diff" || true
    echo "Stop: the live Worker differs from this repository's last deployed version:" >&2
    head -60 "$TMP/live-changes.diff" >&2
    echo "Review the difference. If it is only formatting, run again with FORCE=1." >&2
    exit 1
  fi
fi

# 5. Deploy this folder's bmr-sync.js with the live settings.
cp bmr-sync.js "$LIVE"
$W deploy --config "$CONF"

# 6. Check the live result (prints field names only, never values).
node -e "
const base = process.argv[1];
(async () => {
  const r = await fetch(base + '/bmr/ahc', { headers: { origin: 'https://bulle-consulting.github.io' } });
  const keys = Object.keys(await r.json()).sort().join(',');
  const p = await fetch(base + '/bmr/ahc', { method: 'OPTIONS', headers: { origin: 'https://example.com' } });
  console.log('GET /bmr/ahc fields:', keys, keys === 'submitted,submittedAt' ? '(ok)' : '(UNEXPECTED)');
  console.log('Preflight from another website:', p.status, p.status === 403 ? '(ok)' : '(UNEXPECTED)');
})();" "$URL"
