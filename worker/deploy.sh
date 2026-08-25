#!/usr/bin/env bash
# One-shot deploy of the meme pond drop box. Run from this folder.
#   1. npx --yes wrangler@4 login      (opens a browser — log in with the pondkeeper Cloudflare account)
#   2. ./deploy.sh
# Idempotent: re-run any time to redeploy after editing src/index.js.
set -euo pipefail
cd "$(dirname "$0")"

echo "> KV namespace"
if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
  ID=$(npx --yes wrangler@4 kv namespace create MEMES 2>/dev/null | grep -oE '[a-f0-9]{32}' | head -1 || true)
  if [ -z "$ID" ]; then ID=$(npx --yes wrangler@4 kv namespace list | python3 -c 'import json,sys; print([n["id"] for n in json.load(sys.stdin) if n["title"].endswith("MEMES")][0])'); fi
  sed -i '' "s/REPLACE_WITH_KV_ID/$ID/" wrangler.toml
  echo "  id=$ID written to wrangler.toml"
else echo "  (configured)"; fi

echo "> deploy (if asked to register a workers.dev subdomain, pick a neutral name — it becomes part of the public URL)"
npx --yes wrangler@4 deploy

echo "> secrets"
if ! npx --yes wrangler@4 secret list | grep -q ADMIN_KEY; then
  KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  printf '%s' "$KEY" | npx --yes wrangler@4 secret put ADMIN_KEY
  printf '%s' "$(python3 -c 'import secrets; print(secrets.token_hex(16))')" | npx --yes wrangler@4 secret put SALT
  echo
  echo "  ADMIN KEY (save it somewhere private — it is the only way into the inbox):"
  echo "  $KEY"
else echo "  (already set)"; fi

echo
echo "DONE. Your worker URL is the https://frong-meme-pond.….workers.dev line printed under 'Deployed' above."
echo "      next: set  const API = '<that url>'  in docs/memes.js, commit, push."
echo "      inbox: <that url>/admin?key=<ADMIN_KEY>"
