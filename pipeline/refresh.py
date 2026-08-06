#!/usr/bin/env python3
"""FRONG Ledger data pipeline — incremental refresh.

Run from repo root: python3 pipeline/refresh.py

State lives in docs/data/:
  data.json       — everything the frontend needs (holders, txs, candles, harvests, meta)
  snapshots.jsonl — one summary row per run (price, holder count, whale aggregate)

Incremental strategy:
  - Wallets already tracked: fetch transfer pages newest-first, stop at last seen tx.
  - New wallets entering the top-N: full backfill (one-time).
  - Candles: only fetch since the last stored candle; old candles compact to hourly.
  - Cost basis is always recomputed from the full stored tx list (cheap, exact).

Stdlib only — no dependencies, runs on a bare GitHub Actions runner.
"""
import json, os, sys, time, bisect, datetime, urllib.request
from concurrent.futures import ThreadPoolExecutor

BS = "https://robinhoodchain.blockscout.com/api/v2"
GT = "https://api.geckoterminal.com/api/v2"
DS = "https://api.dexscreener.com/latest/dex/tokens"
TOKEN = "0x6245e67affA44a23077f0Ea7f981a8DC743a0c47"
MAIN_POOL = "0xacea8920877840033f0275c37f9b61550b5326917e948bcf8339714d96f9521a"
FEE_LOCKER = "0x7198C32a497c09497e04C86cf8F77A244A9E4b8F"
PROTOCOL_RECIPIENT = "0x666DA63451a502a323677C2eF5F763181358bE9b"
TOP_N = 50           # wallets ranked on the site
TRACK_CAP = 80       # keep tracking wallets that fell out of top-N, up to this many
SUPPLY = 1e9

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data", "data.json")
SNAPS = os.path.join(ROOT, "docs", "data", "snapshots.jsonl")

KNOWN = {
    "0x8366a39cc670b4001a1121b8f6a443a643e40951": "Uniswap v4 PoolManager",
    "0x09a431261e3d0f1dc2f7e0b14718dbbbcbe19ae4": "FRONG/WETH v3 pool",
    FEE_LOCKER.lower(): "Fee locker",
    PROTOCOL_RECIPIENT.lower(): "Protocol fee recipient",
    "0x39b38686a19836ac10162c490e4558e120cbbe5f": "RobinHoodSettler (RH app order flow)",
    "0x000000000000000000000000000000000000dead": "Burn",
}

def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "frong-ledger/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                print(f"  FAIL {url[:100]}: {e}", file=sys.stderr)
                return None
            time.sleep(2 * (i + 1))

def iso2ts(s):
    return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())

def paginate(url, max_pages, stop_fn=None):
    """Yield items across Blockscout pages (newest first). stop_fn(item) True => stop."""
    d = get(url)
    n = 0
    while d:
        for it in d.get("items", []):
            if stop_fn and stop_fn(it):
                return
            yield it
        n += 1
        np = d.get("next_page_params")
        if not np or n >= max_pages:
            if np and n >= max_pages:
                yield {"__truncated__": True}
            return
        qs = "&".join(f"{k}={v}" for k, v in np.items())
        time.sleep(0.2)
        sep = "&" if "?" in url else "?"
        d = get(f"{url}{sep}{qs}")

def norm_transfer(it, KNOWN):
    try:
        val = int(it["total"]["value"]) / 10 ** int(it["total"].get("decimals") or 18)
    except Exception:
        return None
    return {
        "ts": iso2ts(it["timestamp"]),
        "from": it["from"]["hash"],
        "from_name": it["from"].get("name") or KNOWN.get(it["from"]["hash"].lower()),
        "from_c": bool(it["from"].get("is_contract")),
        "to": it["to"]["hash"],
        "to_name": it["to"].get("name") or KNOWN.get(it["to"]["hash"].lower()),
        "to_c": bool(it["to"].get("is_contract")),
        "amount": val,
        "tx": it.get("transaction_hash") or it.get("tx_hash"),
    }

# ---------------- load prior state ----------------
state = {}
if os.path.exists(DATA):
    with open(DATA) as f:
        state = json.load(f)
tracked = {w["addr"].lower(): w for w in state.get("wallets", [])}
candles5 = state.get("candles5", [])   # recent 5-min [ts,o,h,l,c? -> we keep [ts,c]]
candles1h = state.get("candles1h", []) # compacted hourly [ts,c]
harvests = state.get("harvests", [])

now = int(time.time())
print(f"== refresh @ {now} | tracked wallets: {len(tracked)} ==")

# ---------------- candles (incremental) ----------------
last_c = candles5[-1][0] if candles5 else 0
new_c = []
before = None
for _ in range(5):
    u = f"{GT}/networks/robinhood/pools/{MAIN_POOL}/ohlcv/minute?aggregate=5&limit=1000&currency=usd"
    if before:
        u += f"&before_timestamp={before}"
    d = get(u)
    if not d:
        break
    items = d["data"]["attributes"]["ohlcv_list"]
    if not items:
        break
    fresh = [[c[0], c[4]] for c in items if c[0] > last_c]
    new_c += fresh
    if len(fresh) < len(items) or len(items) < 1000:
        break
    before = min(c[0] for c in items) - 1
    time.sleep(2.2)
new_c.sort(key=lambda x: x[0])
candles5 += new_c
# compact: 5-min older than 48h -> hourly
cutoff = now - 48 * 3600
old = [c for c in candles5 if c[0] < cutoff]
candles5 = [c for c in candles5 if c[0] >= cutoff]
seen_h = {c[0] for c in candles1h}
last_hr = None
for c in old:
    hr = c[0] - c[0] % 3600
    if hr != last_hr and hr not in seen_h:
        candles1h.append([hr, c[1]])
        seen_h.add(hr)
        last_hr = hr
candles1h.sort(key=lambda x: x[0])
print(f"candles: +{len(new_c)} new, {len(candles5)} recent(5m) + {len(candles1h)} hourly")

all_candles = candles1h + candles5
cts = [c[0] for c in all_candles]
def price_at(ts):
    if not all_candles:
        return 0.0
    i = bisect.bisect_right(cts, ts) - 1
    return all_candles[max(0, i)][1]

# ---------------- market stats ----------------
cur_price, fdv, liq, vol24, chg24 = None, None, None, None, None
ds = get(f"{DS}/{TOKEN}")
if ds and ds.get("pairs"):
    p = max(ds["pairs"], key=lambda x: x["liquidity"]["usd"])
    cur_price = float(p["priceUsd"]); fdv = p.get("fdv"); liq = p["liquidity"]["usd"]
    chg24 = p["priceChange"].get("h24")
    vol24 = sum(x["volume"]["h24"] for x in ds["pairs"])
if cur_price is None:
    cur_price = all_candles[-1][1] if all_candles else 0.0
tok = get(f"{BS}/tokens/{TOKEN}") or {}
holders_count = int(tok.get("holders_count") or 0)
print(f"price {cur_price} | holders {holders_count}")

# ---------------- holder ranking ----------------
ranked, contracts_top = [], []
d = get(f"{BS}/tokens/{TOKEN}/holders")
pages = 0
while d and pages < 5:
    for h in d.get("items", []):
        a = h["address"]
        row = {"addr": a["hash"], "name": a.get("name") or KNOWN.get(a["hash"].lower()),
               "balance": int(h["value"]) / 1e18, "is_contract": bool(a.get("is_contract"))}
        (contracts_top if row["is_contract"] else ranked).append(row)
    np = d.get("next_page_params")
    pages += 1
    if not np or len(ranked) >= TOP_N + 10:
        break
    qs = "&".join(f"{k}={v}" for k, v in np.items())
    time.sleep(0.25)
    d = get(f"{BS}/tokens/{TOKEN}/holders?{qs}")
top = ranked[:TOP_N]
top_addrs = {w["addr"].lower() for w in top}
print(f"ranked {len(ranked)} EOAs, top {len(top)} selected")

# ---------------- transfers (incremental per wallet) ----------------
def refresh_wallet(addr, prior):
    """Return updated tx list (oldest first)."""
    known_last = prior["txs"][-1] if prior and prior["txs"] else None
    stop = None
    if known_last:
        stop = lambda it: (it.get("transaction_hash") or it.get("tx_hash")) == known_last["tx"] \
                          and iso2ts(it["timestamp"]) <= known_last["ts"]
    fresh, truncated = [], False
    max_pages = 6 if known_last else 40
    for it in paginate(f"{BS}/addresses/{addr}/token-transfers?token={TOKEN}", max_pages, stop):
        if it.get("__truncated__"):
            truncated = True
            continue
        t = norm_transfer(it, KNOWN)
        if t:
            fresh.append(t)
    fresh.sort(key=lambda x: x["ts"])
    txs = (prior["txs"] if prior else []) + fresh
    return txs, truncated

def compute(addr, txs, balance):
    qty = cost = realized = buy_usd = sell_usd = 0.0
    for t in txs:
        px = t.get("price") or price_at(t["ts"])
        t["price"] = px
        t["usd"] = t["amount"] * px
        if t["to"].lower() == addr.lower():
            cost += t["usd"]; qty += t["amount"]; buy_usd += t["usd"]
        else:
            avg = cost / qty if qty > 0 else px
            take = min(t["amount"], qty)
            realized += take * (px - avg)
            cost -= take * avg
            qty = max(0.0, qty - t["amount"])
            sell_usd += t["usd"]
    avg_cost = cost / qty if qty > 0 else None
    return {
        "balance": balance, "pct_supply": balance / SUPPLY * 100,
        "value_usd": balance * cur_price, "avg_entry": avg_cost,
        "unrealized": (cur_price - avg_cost) * balance if avg_cost else None,
        "unrealized_pct": ((cur_price / avg_cost - 1) * 100) if avg_cost else None,
        "realized": realized, "buy_usd": buy_usd, "sell_usd": sell_usd,
        "n_txs": len(txs), "computed_balance": qty,
        "balance_mismatch": abs(qty - balance) > max(1.0, balance * 0.02),
        "first_ts": txs[0]["ts"] if txs else None,
    }

wallets_out = []
work = [(w["addr"], w["balance"]) for w in top]
# keep previously-tracked wallets that fell out of top-N (up to cap)
for a, w in tracked.items():
    if a not in top_addrs and len(work) < TRACK_CAP:
        bal = next((r["balance"] for r in ranked if r["addr"].lower() == a), None)
        if bal is None:
            r = get(f"{BS}/addresses/{w['addr']}/token-balances")
            bal = 0.0
            for tb in r or []:
                if tb["token"]["address_hash"].lower() == TOKEN.lower():
                    bal = int(tb["value"]) / 1e18
        work.append((w["addr"], bal))

def process_wallet(item):
    i, (addr, bal) = item
    prior = tracked.get(addr.lower())
    txs, trunc = refresh_wallet(addr, prior)
    stats = compute(addr, txs, bal)
    stats["truncated"] = trunc or bool(prior and prior.get("truncated"))
    n_new = len(txs) - (len(prior["txs"]) if prior else 0)
    if n_new or not prior:
        print(f"  [{i+1}/{len(work)}] {addr[:10]} +{n_new} txs (total {len(txs)})")
    return {"addr": addr, "in_top": addr.lower() in top_addrs, **stats, "txs": txs}

with ThreadPoolExecutor(max_workers=6) as pool:
    wallets_out = [w for w in pool.map(process_wallet, enumerate(work)) if w]

# ---------------- fee mechanics (no attribution) ----------------
last_h = harvests[-1]["ts"] if harvests else 0
new_h = []
for it in paginate(f"{BS}/addresses/{PROTOCOL_RECIPIENT}/token-transfers?token={TOKEN}", 10,
                   lambda it: iso2ts(it["timestamp"]) <= last_h):
    if it.get("__truncated__"):
        continue
    t = norm_transfer(it, KNOWN)
    if t and t["to"].lower() == PROTOCOL_RECIPIENT.lower():
        new_h.append({"ts": t["ts"], "frong": t["amount"], "tx": t["tx"]})
new_h.sort(key=lambda x: x["ts"])
harvests += new_h
locked_frong = sum(h["frong"] for h in harvests)
print(f"harvests: +{len(new_h)} new, total {len(harvests)} | cumulative {locked_frong/1e6:.1f}M FRONG recycled")

# ---------------- write ----------------
wallets_out.sort(key=lambda w: -w["balance"])
out = {
    "generated_at": now,
    "token": {"symbol": "FRONG", "address": TOKEN, "supply": SUPPLY,
              "price": cur_price, "fdv": fdv, "liq_main": liq,
              "vol24_all": vol24, "chg24": chg24, "holders_count": holders_count},
    "top_n": TOP_N,
    "wallets": wallets_out,
    "contracts_top": contracts_top[:10],
    "candles5": candles5,
    "candles1h": candles1h,
    "harvests": harvests,
}
os.makedirs(os.path.dirname(DATA), exist_ok=True)
with open(DATA, "w") as f:
    json.dump(out, f)

top_set = [w for w in wallets_out if w["in_top"]]
snap = {
    "ts": now, "price": cur_price, "holders": holders_count,
    "liq": liq, "fdv": fdv,
    "whale_balance": sum(w["balance"] for w in top_set),
    "whale_unrealized": sum(w["unrealized"] or 0 for w in top_set),
    "in_profit": sum(1 for w in top_set if (w["unrealized"] or 0) > 0),
}
with open(SNAPS, "a") as f:
    f.write(json.dumps(snap) + "\n")
print(f"WROTE data.json ({os.path.getsize(DATA)//1024} KB) + snapshot row")
