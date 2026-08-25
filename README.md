# 🐸 Frong Ledger

**Live: https://pondkeeper.github.io/frong-ledger/**

Live whale tracker for FRONG on Robinhood Chain — top-50 wallet positions with
verified cost basis, unrealized/realized PnL, full trade histories, whale-vs-retail
flow, and the locked-liquidity fee mechanics. No backend: a static page plus a
GitHub Actions cron that refreshes the data every 10 minutes.

**Every number is reconstructable.** Cost basis is weighted-average, built from each
wallet's complete on-chain transfer history priced against 5-minute candles.
Reconstructed balances are reconciled against on-chain balances every run — wallets
that don't reconcile are flagged, not hidden.

## How it works

- `pipeline/refresh.py` — incremental data pipeline (stdlib only). Fetches new
  transfers per tracked wallet, new candles, holder rankings, and fee-harvest
  events from the Robinhood Chain Blockscout, GeckoTerminal, and DexScreener
  public APIs. Writes `docs/data/data.json` and appends a summary row to
  `docs/data/snapshots.jsonl`.
- `.github/workflows/refresh.yml` — runs the pipeline every 10 minutes and
  commits the result. Every commit is a permanent timestamped snapshot.
- `docs/` — the static frontend (GitHub Pages). Live price and the recent-trades
  tape are fetched client-side directly from the same public APIs, so the page is
  fresher than the last cron run.

## Meme Pond

`docs/memes.html` is a free-to-use gallery of community FRONG memes (download / copy to
clipboard / share sheet / post to X), served straight from the repo — no backend.

- Images live in `docs/memes/`; `docs/memes/manifest.json` lists them and is rebuilt by
  `python3 pipeline/memes.py` (stdlib only — reads dimensions from the file headers).
- To add a meme: drop the file in `docs/memes/`, run the script, optionally edit the
  entry's `title` / `credit` in the manifest, commit. Files named `template-*` show up
  under the Templates filter; GIFs under GIFs.
- Community submissions arrive as GitHub issues via `.github/ISSUE_TEMPLATE/meme.yml`
  (drag-and-drop image, title, optional credit, pond rules).

## Data sources

- [Robinhood Chain Blockscout](https://robinhoodchain.blockscout.com) — transfers, holders, balances
- [GeckoTerminal](https://www.geckoterminal.com) — historical candles
- [DexScreener](https://dexscreener.com) — live price and pool stats

Not financial advice. Numbers are estimates built from public on-chain data;
methodology and known limitations are documented on the site.
