# Meme pond drop box (Cloudflare Worker)

Submitters pick an image on `memes.html` and tap send — no account, no GitHub.
Files land in an R2 bucket, metadata in KV, and **nothing is public until it's
approved** on the moderation page.

- `src/index.js` — the whole thing (no dependencies).
- `wrangler.toml` — bindings. `ALLOWED_ORIGINS` is the CORS allowlist.
- `deploy.sh` — creates the bucket + KV namespace, deploys, sets secrets, prints the URL.

## Deploy (once)

```
cd worker
npx wrangler login          # pondkeeper Cloudflare account
./deploy.sh                 # prints the worker URL + the admin key
```

Then put the worker URL in `docs/memes.js` (`const API = 'https://….workers.dev'`),
commit, push. Redeploy after code changes with `./deploy.sh` again.

## Moderate

`https://<worker>.workers.dev/admin?key=<ADMIN_KEY>` — previews of everything pending
with Approve / Reject (reject deletes the file). Approved memes appear on the site
within a minute (60 s list cache). "Remove" pulls a live one.

## Limits (edit at the top of `src/index.js`)

4 MB per file · PNG/JPG/GIF/WebP only (checked by magic bytes, so no SVG/HTML) ·
12 uploads per IP per hour · inbox stops accepting at 400 pending.
Free tier covers this comfortably (100k requests/day, 10 GB R2, 1k KV writes/day).
