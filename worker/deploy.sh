#!/usr/bin/env bash
# One-shot deploy of the meme pond drop box. Run from this folder.
#   1. npx wrangler login      (opens a browser — log in with the pondkeeper Cloudflare account)
#   2. ./deploy.sh
# Idempotent: re-run any time to redeploy after editing src/index.js.
set -euo pipefail
cd "$(dirname "$0")"

echo "> R2 bucket"
npx wrangler r2 bucket create frong-meme-pond 2>/dev/null || echo "  (exists)"

echo "> KV namespace"
if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
  ID=$(npx wrangler kv namespace create MEMES 2>/dev/null | grep -oE '[a-f0-9]{32}' | head -1 || true)
  if [ -z "$ID" ]; then ID=$(npx wrangler kv namespace list | python3 -c 'import json,sys; print([n["id"] for n in json.load(sys.stdin) if n["title"].endswith("MEMES")][0])'); fi
  sed -i '' "s/REPLACE_WITH_KV_ID/$ID/" wrangler.toml
  echo "  id=$ID written to wrangler.toml"
else echo "  (configured)"; fi

echo "> deploy"
npx wrangler deploy | tee /tmp/wrangler-deploy.log
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' /tmp/wrangler-deploy.log | head -1 || true)

echo "> secrets"
if ! npx wrangler secret list | grep -q ADMIN_KEY; then
  KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  printf '%s' "$KEY" | npx wrangler secret put ADMIN_KEY
  printf '%s' "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" | npx wrangler secret put SALT
  echo
  echo "  ADMIN KEY (save it somewhere private — it is the only way into the inbox):"
  echo "  $KEY"
else echo "  (already set)"; fi

echo
echo "OK  worker: ${URL:-see output above}"
echo "    next: set  const API = '${URL:-https://<worker>.workers.dev}'  in docs/memes.js, commit, push."
echo "    inbox: ${URL:-https://<worker>.workers.dev}/admin?key=<ADMIN_KEY>"
