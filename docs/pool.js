/* ===========================================================================
   THE POOL — one jackpot a day in <token>, drawn at the bell.

   Generic: window.POOL_CFG names the OfficePool, the ERC20, the chain, the
   copy. Nothing here is specific to one community. Registers window.__POOL =
   { page } and is mounted by pool.html. Reads go through a batched eth_call
   to CFG.rpc, writes through the wallet (EIP-6963 picker, window.ethereum
   fallback); everything the page needs is a view on the contract — no
   indexer, no worker, no logs.

   Inert until POOL_CFG.pool is set: the page then says the pool has not
   opened and does nothing else. The contract address is NEVER taken from
   the URL. Amounts are BigInt end to end; the token's decimals are read from
   the chain and asserted against the config before the desk is offered.
   =========================================================================== */
(function () {
  "use strict";
  const CFG = window.POOL_CFG || {};
  const COPY = CFG.copy || {};
  const SYM = String(CFG.symbol || "TOKEN");
  const DEC = BigInt(CFG.decimals == null ? 18 : CFG.decimals);
  const SCALE = 10n ** DEC;
  const RPCS = (CFG.rpc || []).filter((u, i, a) => u && a.indexOf(u) === i);
  const BOOST = !!CFG.boost;

  const SEL = {
    deposit: "0xb927dab6", registerBrokers: "0xfb9a75f4", claimDividends: "0xccbba739", claimReferral: "0xe02f1ebd",
    setCode: "0xb9ef767f", draw: "0x23906963",
    roundView: "0xdb5b4737", currentRound: "0x8a19c8bc", playerView: "0xcaeacdb9", players: "0x1f5053a1",
    deposits: "0x0f430645", depositCount: "0xa537f3c9", recentRounds: "0xf36ea453", dueForDraw: "0xf0c0f269",
    roundsOf: "0x8820a363", claimableDividends: "0x062c1746", referralOwed: "0x994ec7c7", codeOf: "0x2cfc2716",
    codeOwner: "0x11ad2f34", referrer: "0x2cf003c2", roundCount: "0x127f0b3f", knobs: "0x48fe7e53", brokerUsed: "0xa314afcf",
    beaconDelay: "0x925e2416",
    allowance: "0xdd62ed3e", balanceOf: "0x70a08231", approve: "0x095ea7b3", decimals: "0x313ce567", symbol: "0x95d89b41",
  };
  const KEY = (CFG.pool || "").toLowerCase();
  const REF_KEY = "pool.ref." + KEY;
  const WALLET_KEY = "pool.wallet.v1";
  const POLL_IDLE = 20000, POLL_HOT = 4000, HOT_WINDOW = 600;
  const BATCH_MAX = 40; // the public rpc's batch ceiling, as measured for the ledger's sister sites
  const DRAND = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];
  const QUICKNET = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
  const ZERO = "0x0000000000000000000000000000000000000000";

  // ---------------------------------------------------------------- helpers
  const w = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
  const big = (hex, i) => BigInt("0x" + w(hex, i));
  const num = (hex, i) => Number(big(hex, i));
  const addr = (hex, i) => "0x" + w(hex, i).slice(24);
  const word = (v) => (typeof v === "bigint" ? v.toString(16) : typeof v === "number" ? BigInt(v).toString(16) : String(v).replace(/^0x/, "")).padStart(64, "0");
  const short = (a) => (a && a !== ZERO ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const bytes32 = (str) => { let h = ""; for (const ch of str) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return h.padEnd(64, "0"); };
  const fromBytes32 = (hex) => { let s = ""; for (let i = 0; i < 64; i += 2) { const c = parseInt(hex.slice(i, i + 2), 16); if (!c) break; s += String.fromCharCode(c); } return s; };
  const validCode = (s) => /^[a-z0-9]{3,20}$/.test(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function decodeString(hex) {
    if (!hex || hex.length < 130) return "";
    const off = num(hex, 0), len = Number(BigInt("0x" + hex.slice(2 + off * 2, 2 + off * 2 + 64)));
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(parseInt(hex.slice(2 + off * 2 + 64 + i * 2, 2 + off * 2 + 66 + i * 2), 16));
    return s;
  }

  /// compact: 1,234,567 → "1.23M", 12,345 → "12.3k", 500 → "500", 0.5 → "0.5"; never scientific.
  /// BigInt in, three decimals of headroom kept exact in the Number (fine below 9e12 tokens).
  function fmt(units) {
    units = BigInt(units);
    const neg = units < 0n; if (neg) units = -units;
    const scaled = DEC >= 3n ? units / 10n ** (DEC - 3n) : units * 10n ** (3n - DEC);
    const n = Number(scaled) / 1000;
    const t = (x, d) => x.toLocaleString("en-US", { maximumFractionDigits: d });
    let s;
    if (n >= 1e12) s = t(n / 1e12, 2) + "T";
    else if (n >= 1e9) s = t(n / 1e9, 2) + "B";
    else if (n >= 1e6) s = t(n / 1e6, 2) + "M";
    else if (n >= 1e4) s = t(n / 1e3, 1) + "k";
    else s = t(n, n >= 100 ? 0 : 2);
    return (neg ? "-" : "") + s;
  }
  /// exact, for the amount box: 500 → "500", 1234.5 → "1,234.5"
  function fmtExact(units, maxFrac) {
    units = BigInt(units);
    const i = units / SCALE, f = units % SCALE;
    let fs = DEC > 0n ? f.toString().padStart(Number(DEC), "0").slice(0, maxFrac == null ? 2 : maxFrac).replace(/0+$/, "") : "";
    return i.toLocaleString("en-US") + (fs ? "." + fs : "");
  }
  /// "12,345" · "12.5k" · "1.2m" → units, null if it is not a number
  function parseAmount(str) {
    let t = String(str || "").trim().toLowerCase().replace(/[\s,_]/g, "");
    let mul = 1n;
    if (t.endsWith("k")) { mul = 1000n; t = t.slice(0, -1); } else if (t.endsWith("m")) { mul = 1000000n; t = t.slice(0, -1); }
    if (!/^\d+(\.\d+)?$/.test(t)) return null;
    const [i, f = ""] = t.split(".");
    const frac = (f + "0".repeat(Number(DEC))).slice(0, Number(DEC));
    try { return (BigInt(i) * SCALE + (frac ? BigInt(frac) : 0n)) * mul; } catch (e) { return null; }
  }
  /// "≈ $1,234" from the optional price hook (USD per token); "" when there is none
  function usd(units) {
    let p = null;
    try { p = typeof CFG.price === "function" ? CFG.price() : CFG.price; } catch (e) { p = null; }
    if (!(typeof p === "number" && isFinite(p) && p > 0)) return "";
    const tokens = Number(DEC >= 3n ? BigInt(units) / 10n ** (DEC - 3n) : BigInt(units) * 10n ** (3n - DEC)) / 1000;
    const v = tokens * p;
    if (!(v >= 0.01)) return "";
    return "≈ $" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 2 }));
  }
  const nyTime = (ts, withDate) => new Date(ts * 1000).toLocaleString("en-US", Object.assign({ timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }, withDate ? { month: "short", day: "numeric" } : {}));
  /// " · 21:00 your time" when the viewer is not on New York time
  const localTime = (ts, brief) => { try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (!tz || tz === "America/New_York") return ""; return " · " + new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + (brief ? " yours" : " your time"); } catch (e) { return ""; } };
  const ago = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - S.skew - ts); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d"; };
  const countdown = (left) => { if (left <= 0) return "0:00"; const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60; return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; };

  // ---------------------------------------------------------------- transport
  let rpcBase = null;
  async function rpcPost(body) {
    const order = rpcBase ? [rpcBase, ...RPCS.filter((u) => u !== rpcBase)] : RPCS;
    let last;
    for (const url of order) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error("http " + r.status);
        const j = await r.json();
        rpcBase = url;
        return j;
      } catch (e) { last = e; }
    }
    throw last || new Error("no rpc endpoint");
  }
  async function call(to, data) {
    const j = await rpcPost({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] });
    if (j.error) { const m = String(j.error.message || "").toLowerCase(); if (m.includes("revert")) return "0x"; throw new Error(j.error.message); }
    return j.result;
  }
  async function batchOnce(slice) {
    const j = await rpcPost(slice.map((it, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: it.to, data: it.data }, "latest"] })));
    if (!Array.isArray(j)) throw new Error("not a batch response");
    const out = new Array(slice.length).fill(null);
    for (const res of j) {
      if (!res) continue;
      if (res.result !== undefined && res.result !== null) { out[Number(res.id)] = res.result; continue; }
      // a revert is an answer; anything else stays null and is retried one by one
      const msg = String((res.error && res.error.message) || "").toLowerCase();
      out[Number(res.id)] = msg.includes("revert") ? "0x" : null;
    }
    return out;
  }
  async function callBatch(items) {
    const out = [];
    for (let i = 0; i < items.length; i += BATCH_MAX) {
      const slice = items.slice(i, i + BATCH_MAX);
      let res = null;
      for (let attempt = 0; attempt < 3 && !res; attempt++) {
        try { res = await batchOnce(slice); } catch (e) { await sleep(250 * (attempt + 1)); }
      }
      if (!res) res = new Array(slice.length).fill(null);
      for (let k = 0; k < slice.length; k++) {
        if (res[k] === null) { try { res[k] = await call(slice[k].to, slice[k].data); } catch (e) { res[k] = null; } }
      }
      out.push(...res);
    }
    return out;
  }
  /// the gas a call needs, from OUR rpc: a BigInt, or a throw carrying the revert data, or null when the rpc is down
  async function estimateGas(from, to, data) {
    let j;
    try { j = await rpcPost({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ from, to, data }] }); } catch (e) { return null; }
    if (!j) return null;
    if (j.error) { const err = new Error(String(j.error.message || "execution reverted") + " " + String(j.error.data || "")); err.data = j.error.data; throw err; }
    return BigInt(j.result);
  }

  // ---------------------------------------------------------------- wallet
  const discovered = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => { try { if (e.detail && e.detail.info && e.detail.info.rdns) discovered.set(e.detail.info.rdns, e.detail); } catch (err) {} });
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (e) {}
  let chosenProvider = null;
  function provider() {
    if (chosenProvider) return chosenProvider;
    const eth = window.ethereum;
    if (!eth) return null;
    return eth.providers && eth.providers.length ? eth.providers[0] : eth;
  }
  const wallets = () => [...discovered.values()];
  /// the fee the wallet SHOWS is limit × max fee, its ceiling, not the charge: suggest 1.25× the node's price, no tip (the sequencer takes none)
  async function suggestedFees() {
    try { const j = await rpcPost({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }); const gp = BigInt(j.result); if (gp <= 0n) return null; return { maxFeePerGas: "0x" + ((gp * 5n) / 4n).toString(16), maxPriorityFeePerGas: "0x0" }; } catch (e) { return null; }
  }
  async function send(to, data, from, gasLimit) {
    const p = provider();
    const tx = { from, to, data, chainId: CFG.chainHex }; // a wallet moved to another chain refuses instead of signing a no-op there
    if (gasLimit) tx.gas = "0x" + gasLimit.toString(16);
    const fees = await suggestedFees();
    if (fees) Object.assign(tx, fees);
    try { return await p.request({ method: "eth_sendTransaction", params: [tx] }); }
    catch (e) {
      // a wallet that will not take EIP-1559 fields on this chain says so; retry once the old way. A rejection is never retried.
      const m = String((e && e.message) || e || "").toLowerCase();
      if (fees && /1559|maxfeepergas|maxpriorityfeepergas/.test(m) && !/reject|denied/.test(m)) { delete tx.maxFeePerGas; delete tx.maxPriorityFeePerGas; return await p.request({ method: "eth_sendTransaction", params: [tx] }); }
      throw e;
    }
  }
  async function waitForTx(hash) {
    for (let i = 0; i < 120; i++) {
      let r = null;
      try { const j = await rpcPost({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }); r = j && j.result; } catch (e) {}
      if (!r) { try { r = await provider().request({ method: "eth_getTransactionReceipt", params: [hash] }); } catch (e) {} }
      if (r) { if (Number(r.status) !== 1) throw new Error("the transaction failed on chain"); return r; }
      await sleep(2500);
    }
    throw new Error("still not confirmed — check your wallet");
  }

  // ---------------------------------------------------------------- decoders
  /// Round is a struct of statics with a nested Knobs: 20 flat words.
  function decodeRound(hex) {
    if (!hex || hex.length < 2 + 64 * 20) return null;
    return {
      closesAt: num(hex, 0), beaconRound: num(hex, 1), state: num(hex, 2), playerCount: num(hex, 3),
      deposits: big(hex, 4), totalWeight: big(hex, 5), pot: big(hex, 6), seed: big(hex, 7), acc: big(hex, 8),
      refundWinner: addr(hex, 9), jackpotWinner: addr(hex, 10), refundPaid: big(hex, 11), jackpotPaid: big(hex, 12),
      rand: "0x" + w(hex, 13),
      minDeposit: big(hex, 14), divBps: num(hex, 15), refBps: num(hex, 16), houseBps: num(hex, 17), boostBps: num(hex, 18), boostCapBps: num(hex, 19),
    };
  }
  const decodePlayer = (hex, o = 0) => (!hex || hex.length < 2 + 64 * (o + 8)) ? null : {
    idx: num(hex, o), brokers: num(hex, o + 1), deposited: big(hex, o + 2), weight: big(hex, o + 3),
    divEarned: big(hex, o + 4), divClaimable: big(hex, o + 5), totalWeight: big(hex, o + 6), abandonClaimed: num(hex, o + 7) === 1,
  };
  function decodeUintArray(hex) {
    if (!hex || hex.length < 130) return [];
    const off = num(hex, 0) / 32, n = num(hex, off);
    const out = [];
    for (let i = 0; i < n; i++) out.push(big(hex, off + 1 + i));
    return out;
  }
  /// players(): (address[] addrs, PlayerView[] views)
  function decodePlayers(hex) {
    if (!hex || hex.length < 130) return [];
    const oa = num(hex, 0) / 32, ov = num(hex, 1) / 32;
    const n = num(hex, oa);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ addr: addr(hex, oa + 1 + i), v: decodePlayer(hex, ov + 1 + i * 8) });
    return out;
  }
  /// deposits(): Deposit[] of (player, amount, at)
  function decodeDeposits(hex) {
    if (!hex || hex.length < 130) return [];
    const o = num(hex, 0) / 32, n = num(hex, o);
    const out = [];
    for (let i = 0; i < n; i++) out.push({ player: addr(hex, o + 1 + i * 3), amount: big(hex, o + 2 + i * 3), at: num(hex, o + 3 + i * 3) });
    return out;
  }

  // ---------------------------------------------------------------- state
  const S = {
    account: null, cur: null, curId: 0, closesAt: 0, delay: 300, skew: 0, count: 0, roundCount: 0,
    players: [], feed: [], history: [], due: [], me: null, claimable: 0n, refOwed: 0n, code: "", referrer: ZERO,
    referrerCode: "", referrerCodeFor: null, inBefore: false, refCheck: null, nameCheck: null,
    knobs: null, refOwner: ZERO, potShown: 0n, seenDeposits: 0, balance: 0n, allowance: 0n,
    fatal: "", loaded: false, busy: false, pickWallet: null, wrongChain: false,
  };

  // ---------------------------------------------------------------- chain
  async function load() {
    const P = CFG.pool, T = CFG.token;
    const head = await callBatch([
      { to: P, data: SEL.currentRound }, { to: P, data: SEL.roundCount }, { to: P, data: SEL.beaconDelay },
      { to: P, data: SEL.dueForDraw }, { to: P, data: SEL.recentRounds + word(8) }, { to: P, data: SEL.knobs },
      { to: P, data: SEL.codeOwner + bytes32(refCode() || "---") }, // does the link's code exist?
      { to: T, data: SEL.decimals }, { to: T, data: SEL.symbol },
    ]);
    if (!head[0] || head[0].length < 2 + 64 * 3) throw new Error("no answer from the pool");
    // the token the config names must be the token the chain describes: every amount on this page depends on it
    const chainDec = head[7] && head[7].length >= 66 ? num(head[7], 0) : null;
    const chainSym = head[8] && head[8].length >= 130 ? decodeString(head[8]) : "";
    if (chainDec == null || BigInt(chainDec) !== DEC) S.fatal = `this page is configured for ${SYM} with ${DEC} decimals, the chain says ${chainDec == null ? "nothing" : chainDec}: the desk is closed until the config is fixed`;
    else if (chainSym && chainSym.toUpperCase() !== SYM.toUpperCase()) S.fatal = `this page is configured for ${SYM}, the token on the chain calls itself ${esc(chainSym)}: the desk is closed until the config is fixed`;
    else S.fatal = "";
    S.refOwner = head[6] && head[6].length >= 66 ? addr(head[6], 0) : ZERO;
    if (refCode() && !(S.refCheck && S.refCheck.code === refCode())) S.refCheck = { code: refCode(), owner: S.refOwner, error: false };
    // the terms a round opening now would take (the board's rules before the first chip-in of a day)
    if (head[5] && head[5].length >= 2 + 64 * 6) S.knobs = { minDeposit: big(head[5], 0), divBps: num(head[5], 1), refBps: num(head[5], 2), houseBps: num(head[5], 3), boostBps: num(head[5], 4), boostCapBps: num(head[5], 5) };
    const cr = head[0];
    S.curId = num(cr, 0); S.closesAt = num(cr, 1); const open = num(cr, 2) === 1;
    // count down against the CHAIN's clock: a device that is off by minutes is the difference between chipping in and not
    if (cr.length >= 2 + 64 * 4) S.skew = Math.floor(Date.now() / 1000) - num(cr, 3);
    S.roundCount = head[1] ? num(head[1], 0) : 0;
    S.delay = (head[2] && num(head[2], 0)) || 300;
    S.due = decodeUintArray(head[3]).map(Number);
    const recent = decodeUintArray(head[4]).map(Number).filter((id) => id !== S.curId || !open);

    const reqs = [];
    if (open) { reqs.push({ to: P, data: SEL.roundView + word(S.curId) }); reqs.push({ to: P, data: SEL.depositCount + word(S.curId) }); }
    for (const id of recent) reqs.push({ to: P, data: SEL.roundView + word(id) });
    if (S.account) {
      reqs.push({ to: P, data: SEL.claimableDividends + word(S.account) });
      reqs.push({ to: P, data: SEL.referralOwed + word(S.account) });
      reqs.push({ to: P, data: SEL.codeOf + word(S.account) });
      reqs.push({ to: P, data: SEL.referrer + word(S.account) });
      reqs.push({ to: P, data: SEL.roundsOf + word(S.account) }); // any toss ever? then the sender is settled
      reqs.push({ to: T, data: SEL.balanceOf + word(S.account) });
      reqs.push({ to: T, data: SEL.allowance + word(S.account) + word(P) });
      if (open) reqs.push({ to: P, data: SEL.playerView + word(S.curId) + word(S.account) });
    }
    const res = reqs.length ? await callBatch(reqs) : [];
    let k = 0;
    if (open) { S.cur = decodeRound(res[k++]); S.count = num(res[k++], 0); }
    else { S.cur = null; S.count = 0; S.players = []; }
    S.history = [];
    for (const id of recent) { const r = decodeRound(res[k++]); if (r) S.history.push(Object.assign({ id }, r)); }
    if (S.account) {
      S.claimable = big(res[k++], 0); S.refOwed = big(res[k++], 0); S.code = fromBytes32(w(res[k++], 0)); S.referrer = addr(res[k++], 0);
      S.inBefore = decodeUintArray(res[k++]).length > 0;
      S.balance = big(res[k++], 0); S.allowance = big(res[k++], 0);
      S.me = open ? decodePlayer(res[k++]) : null;
      // the sender by name when they have one (one extra call, only while it changes)
      if (S.referrer !== ZERO && S.referrerCodeFor !== S.referrer) {
        S.referrerCodeFor = S.referrer;
        try { S.referrerCode = fromBytes32(w((await callBatch([{ to: P, data: SEL.codeOf + word(S.referrer) }]))[0], 0)); } catch (e) { S.referrerCode = ""; }
      }
      // your own link can never send you: never show it as the sender, forget it
      if (same(S.refOwner, S.account)) { try { if (localStorage.getItem(REF_KEY) === refCode()) localStorage.removeItem(REF_KEY); } catch (e) {} }
    }
    // every player (join order; the board is top-10 by deposit, so no page may be skipped) and the last 12 deposits
    if (open && S.cur && S.cur.playerCount > 0) {
      const PAGE = 200, MAX = 4000;
      const n = Math.min(S.cur.playerCount, MAX);
      const pages = [];
      for (let from = 1; from <= n; from += PAGE) pages.push({ to: P, data: SEL.players + word(S.curId) + word(from) + word(PAGE) });
      const from = Math.max(0, S.count - 12);
      pages.push({ to: P, data: SEL.deposits + word(S.curId) + word(from) + word(12) });
      const d = await callBatch(pages);
      S.players = [];
      for (let i = 0; i < pages.length - 1; i++) S.players.push(...decodePlayers(d[i]));
      S.feed = decodeDeposits(d[pages.length - 1]).reverse();
    } else { S.players = []; S.feed = []; }
    S.loaded = true;
  }
  const terms = () => S.cur || S.knobs || { minDeposit: 0n, divBps: 2500, refBps: 500, houseBps: 1000, boostBps: 0, boostCapBps: 10000 };

  // ---------------------------------------------------------------- wallet flow
  /// forget the remembered wallet: back to CONNECT WALLET (the wallet's own permission is revoked when it lets us)
  async function disconnect() {
    const p = provider();
    try { localStorage.removeItem(WALLET_KEY); } catch (e) {}
    chosenProvider = null; S.account = null; S.me = null; S.pickWallet = null; S.wrongChain = false;
    S.claimable = 0n; S.refOwed = 0n; S.code = ""; S.referrer = ZERO; S.balance = 0n; S.allowance = 0n; S.inBefore = false; S.referrerCode = ""; S.referrerCodeFor = null; S.nameCheck = null;
    render();
    if (p && p.request) { try { await p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch (e) { /* not every wallet has it */ } }
    toast("disconnected", true);
  }
  /// forget the remembered wallet and start over: the picker shows again when more than one wallet is installed
  async function switchWallet() {
    try { localStorage.removeItem(WALLET_KEY); } catch (e) {}
    chosenProvider = null; S.account = null; S.me = null; S.pickWallet = null; S.wrongChain = false;
    return connect(null, true).catch((err) => toast(humanError(err), false));
  }
  async function connect(chosen, forcePick) {
    const list = wallets();
    if (!chosenProvider || chosen || forcePick) {
      let remembered = null;
      try { remembered = forcePick ? null : localStorage.getItem(WALLET_KEY); } catch (e) {}
      const saved = chosen || (remembered && list.find((x) => x.info.rdns === remembered));
      if (!saved && list.length > 1) { S.pickWallet = list; render(); toast("this browser has more than one wallet — pick the one to toss with"); return; }
      const pick = saved || list[0];
      if (pick) { chosenProvider = pick.provider; try { localStorage.setItem(WALLET_KEY, pick.info.rdns); } catch (e) {} }
      else if (!provider()) return toast("no wallet in this browser. Open this page in your wallet app", false);
      S.pickWallet = null;
    }
    const p = provider();
    const accounts = await p.request({ method: "eth_requestAccounts" });
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.chainHex }] }); }
    catch (e) {
      try { if (e && e.code === 4902) await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: CFG.chainHex, chainName: CFG.chainName, rpcUrls: [RPCS[0]], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: CFG.explorer ? [CFG.explorer] : undefined }] }); } catch (e2) { /* judged by eth_chainId below */ }
    }
    // a wallet that cannot be on this chain (Phantom, 2026-09-06) must never look connected: its signature would fail on the chainId
    let cid = null;
    try { cid = String(await p.request({ method: "eth_chainId" })).toLowerCase(); } catch (e) {}
    if (cid !== String(CFG.chainHex).toLowerCase()) {
      S.account = null; S.me = null; S.wrongChain = true; render();
      return toast(`this wallet cannot switch to ${CFG.chainName || "the chain"} — try MetaMask (SWITCH WALLET)`, false);
    }
    S.wrongChain = false;
    S.account = accounts[0];
    toast(`connected · ${short(S.account)}`, true); // replaces "opening your wallet…" the moment the wallet answers
    if (p.on && !p.__poolListening) { // once per provider: a re-pick must not stack listeners
      p.__poolListening = true;
      p.on("accountsChanged", (a) => { S.account = a[0] || null; S.me = null; refresh(); });
      p.on("chainChanged", () => refresh());
    }
    await refresh();
  }

  /// the public rpc is load-balanced over replicas that lag each other by a few blocks: a read right after the
  /// receipt can hit one that has not seen the block. Wait until OUR rpc reports the receipt's block (cap 10 s).
  async function waitForBlock(n) {
    const target = Number(n);
    if (!target) return;
    for (let i = 0; i < 20; i++) {
      try { const j = await rpcPost({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }); if (Number(BigInt(j.result)) >= target) return; } catch (e) {}
      await sleep(500);
    }
  }
  async function tx(label, fn, after) {
    if (S.busy) return;
    S.busy = true;
    const countBefore = S.count, claimBefore = S.claimable, codeBefore = S.code;
    let landed = false;
    try {
      toast(label + "…");
      const hash = await fn();
      toast("sent, waiting for the block…");
      const rc = await waitForTx(hash);
      landed = true;
      await waitForBlock(rc && rc.blockNumber);
      toast(label + ": done", true);
      if (after) await after();
    } catch (e) {
      toast(humanError(e), false);
    } finally { S.busy = false; }
    await refresh();
    if (landed) {
      // a burst of re-reads covers a replica still behind, or a wallet-side receipt our rpc has not seen
      const changed = () => S.count !== countBefore || S.claimable !== claimBefore || S.code !== codeBefore;
      if (!changed()) toast("landed — the pond catches up in a moment", true);
      for (const ms of [2000, 5000, 10000]) setTimeout(() => { if (!S.busy) refresh(); }, ms);
    }
  }
  function humanError(e) {
    const m = String((e && (e.shortMessage || e.message)) || e || "");
    if (/reject|denied|cancel/i.test(m)) return "cancelled in the wallet";
    // wallets surface revert DATA more often than error names: match both
    if (/BadAmount|0x749b5939/.test(m)) return "below the minimum for this pond, or not a whole amount";
    if (/BadBroker|0xef6303e2/.test(m)) return "one of those brokers is not yours, not hired, or already counted today";
    if (/RoundNotClosed|0x29e3b953/.test(m)) return "the croak has not come yet";
    if (/RoundNotOpen|0x402bc007/.test(m)) return "that round is already settled";
    if (/NotAPlayer|0xabca3517/.test(m)) return "toss a frong in first";
    if (/CodeTaken|0x6af0cefe/.test(m)) return "that name is taken, or you already have one";
    if (/BadCode|0x6c4ae96c/.test(m)) return "3 to 20 lowercase letters or digits";
    if (/NothingToClaim|0x969bf728/.test(m)) return "nothing to claim";
    if (/TooEarly|0x085de625/.test(m)) return "too early";
    if (/BadBeacon|0x50264bfe|bad beacon/i.test(m)) return "that is not the round's beacon";
    if (/TransferFailed|0x90b8ec18/.test(m)) return "the token transfer failed";
    // the token's own reverts (solady): InsufficientAllowance / InsufficientBalance — not a gas problem
    if (/InsufficientAllowance|0x13be252b|insufficient allowance|exceeds allowance/i.test(m)) return `the pond is not allowed to take that much ${SYM} yet — try again in a moment`;
    if (/InsufficientBalance|0xf4d678b8|insufficient balance|exceeds balance/i.test(m)) return "that is more than you have";
    if (/insufficient/i.test(m)) return "not enough ETH for gas";
    return m.length > 160 ? m.slice(0, 160) + "…" : m || "something went wrong";
  }

  // ---------------------------------------------------------------- actions
  function refCode() {
    let c = "";
    try { c = new URL(location.href).searchParams.get("ref") || localStorage.getItem(REF_KEY) || ""; } catch (e) {}
    c = String(c).toLowerCase();
    return validCode(c) ? c : "";
  }
  async function chipIn(amount) {
    const P = CFG.pool;
    const field = host.querySelector("#op-ref");
    const typed = parseRef((field || {}).value);
    let code = "";
    if (senderOpen()) {
      if (field && !field.disabled) {
        if (typed) {
          if (!validCode(typed)) return toast("a code is 3 to 20 letters or digits", false);
          if (S.code && typed === S.code) return toast("that is your own code — it cannot send you", false);
          let owner = ZERO; try { owner = await ownerOf(typed); } catch (e) { return toast("could not check the code — try again", false); }
          if (owner === ZERO) return toast(`code '${typed}' is not registered · check the spelling`, false);
          if (same(owner, S.account)) return toast("that is your own code — it cannot send you", false);
          code = typed;
        }
      } else code = linkCode();
    }
    // deposit(uint128 amount, uint256[] brokerIds, bytes32 refCode) — no brokers: an empty array at offset 96
    const data = SEL.deposit + word(amount) + word(96) + (code ? bytes32(code) : word(0)) + word(0);
    if (S.allowance < amount) {
      // two confirmations the first time: the allowance, then the chip-in. Say so, and go
      // straight on to the chip-in once the allowance has landed (the allowance re-read after
      // the block can lag a beat, and a silent stop here reads as "nothing happened").
      toast(`first time: two confirmations — allow the pond to take ${SYM}, then the toss`);
      let landed = false;
      await tx(`allowing the pond to take ${SYM}`, () => send(CFG.token, SEL.approve + word(P) + word((1n << 256n) - 1n), S.account), async () => { landed = true; });
      if (!landed) return; // rejected or failed: the toast said so
    }
    // an honest limit: the estimate is real (deposit() has no internal try/catch), +25%.
    // Fallback to the measured ceiling: the first chip-in of a day opens the round (≈470k).
    const fallback = 600000n;
    let limit = fallback;
    try {
      const est = await estimateGas(S.account, P, data);
      if (est != null) { const g = (est * 125n) / 100n; if (g > 150000n && g < fallback * 2n) limit = g; }
    } catch (e) { /* the node could not estimate (an allowance that has not propagated yet, most likely): the ceiling stands */ }
    await tx("tossing", () => send(P, data, S.account, limit), async () => { toast("you're in — see you at the croak", true); });
  }
  async function claimDividends() {
    const ids = decodeUintArray((await callBatch([{ to: CFG.pool, data: SEL.roundsOf + word(S.account) }]))[0]);
    if (!ids.length) return toast("nothing to claim yet", false);
    // only the rounds with something to claim, newest first, at most 20 per transaction
    const views = await callBatch(ids.map((id) => ({ to: CFG.pool, data: SEL.playerView + word(id) + word(S.account) })));
    const pick = ids.filter((id, i) => { const v = decodePlayer(views[i]); return v && v.divClaimable > 0n; }).reverse().slice(0, 20);
    if (!pick.length) return toast("nothing to claim yet", false);
    let data = SEL.claimDividends + word(32) + word(pick.length);
    for (const id of pick) data += word(id);
    await tx("claiming dividends", () => send(CFG.pool, data, S.account, BigInt(120000 + 60000 * pick.length)));
  }
  const claimReferral = () => tx("claiming referral rewards", () => send(CFG.pool, SEL.claimReferral, S.account, 120000n));
  async function setCode(code) {
    code = String(code || "").trim().toLowerCase();
    if (!validCode(code)) return toast("3 to 20 letters or digits, lowercase", false);
    const taken = (await callBatch([{ to: CFG.pool, data: SEL.codeOwner + bytes32(code) }]))[0];
    if (taken && taken.length >= 66 && addr(taken, 0) !== ZERO) return toast("that name is taken", false);
    await tx("setting your link", () => send(CFG.pool, SEL.setCode + bytes32(code), S.account, 120000n));
  }
  /// the bell: the beacon from drand, straight into draw(). Anyone may.
  async function ringBell(id) {
    const r = decodeRound((await callBatch([{ to: CFG.pool, data: SEL.roundView + word(id) }]))[0]);
    if (!r) return;
    let sig = null;
    if (r.playerCount > 0) {
      outer: for (const base of DRAND) {
        for (const path of [`/v2/beacons/quicknet/rounds/${r.beaconRound}`, `/${QUICKNET}/public/${r.beaconRound}`]) {
          try {
            const res = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
            if (!res.ok) continue;
            const j = await res.json();
            if (Number(j.round) === r.beaconRound && /^[0-9a-f]{96}$/i.test(j.signature)) { sig = j.signature.toLowerCase(); break outer; }
          } catch (e) { /* next */ }
        }
      }
      if (!sig) return toast("the beacon is not out yet — try again in a moment", false);
    }
    const sigHex = sig || "";
    const data = SEL.draw + word(id) + word(64) + word(sigHex.length / 2) + (sigHex ? sigHex.padEnd(128, "0") : "");
    await tx("making it croak", () => send(CFG.pool, data, S.account, 900000n));
  }

  // ---------------------------------------------------------------- render
  let host = null, timer = null, ticker = null;
  function toast(msg, ok, ms) {
    const t = document.getElementById("op-toast");
    if (!t) return;
    t.textContent = msg; t.className = "op-toast mono on" + (ok === true ? " ok" : ok === false ? " bad" : "");
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = "op-toast mono"; }, ms || (ok === undefined ? 30000 : 6000));
  }
  /// the jackpot rolls up to its new value rather than jumping
  function countUp(el) {
    if (!el) return;
    const target = BigInt(el.dataset.pot || "0");
    const from = S.potShown && S.potShown < target ? S.potShown : target;
    S.potShown = target;
    const n = el.querySelector(".num");
    if (!n || from === target) return;
    const t0 = performance.now(), dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      const v = from + (target - from) * BigInt(Math.round(e * 1000)) / 1000n;
      n.textContent = fmt(v);
      if (k < 1 && n.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  const drandUrl = (round) => `https://api.drand.sh/v2/beacons/quicknet/rounds/${round}`;
  /// the clean URL of this page, whichever way the visitor arrived (works under a repo path and on a bare domain)
  const pageLink = () => location.origin + location.pathname.replace(/\.html$/, "").replace(/\/index$/, "/");
  function postText(code) {
    const link = `${pageLink()}?ref=${code}`;
    const r = S.cur;
    const jackpot = r ? fmt(r.pot) : "today's";
    return String(COPY.post || `toss ${SYM} in the pond before the ${CFG.bell || "4 PM New York"} croak: one takes the pond, one gets their frongs back.\n\n{link}`).replace("{link}", link).replace("{jackpot}", jackpot);
  }
  const xIntent = (code) => "https://x.com/intent/post?text=" + encodeURIComponent(postText(code));
  const tgIntent = (code) => "https://t.me/share/url?url=" + encodeURIComponent(`${pageLink()}?ref=${code}`) + "&text=" + encodeURIComponent(postText(code).replace(/\n*\{?https?:\/\/\S+\s*$/, "").replace(pageLink() + `?ref=${code}`, "").trim());
  const explorer = (a) => `${CFG.explorer}/address/${a}`;
  const refLink = (code) => `${pageLink()}?ref=${code}`;
  /// the link's code when it can actually send this wallet: registered, and not the wallet's own
  const linkCode = () => (refCode() && S.refOwner !== ZERO && !same(S.refOwner, S.account) ? refCode() : "");
  /// the sender is settled once, by the contract, at the first toss that carries a code; the
  /// page sends a code ONLY before the wallet's first toss, so a link opened later changes nothing
  const senderOpen = () => S.referrer === ZERO && !S.inBefore && !(S.me && S.me.deposited > 0n);

  // ---------------------------------------------------------------- live checks
  /// a code, a whole link with ?ref= in it, or "@name" → the code, lowercased
  function parseRef(raw) {
    let t = String(raw || "").trim();
    const m = t.match(/[?&#]ref=([A-Za-z0-9]{1,20})/);
    if (m) t = m[1];
    return t.replace(/^@/, "").replace(/\s+/g, "").toLowerCase();
  }
  async function ownerOf(code) {
    const r = (await callBatch([{ to: CFG.pool, data: SEL.codeOwner + bytes32(code) }]))[0];
    return r && r.length >= 66 ? addr(r, 0) : ZERO;
  }
  let checkT = null, checkSeq = 0;
  function refNote(code, check) {
    const pct = terms().refBps / 100;
    if (!code && refCode() && same(S.refOwner, S.account)) return { cls: "fine", html: "that is your own link · it cannot send you, share it" };
    if (!code) return { cls: "fine", html: linkCode() ? `no sender · you cleared the link's code '${esc(linkCode())}' — type it back to keep them` : `got a code from a player? put it here, or paste their link. They earn ${pct}% of everything you toss, never out of your share. Locks at your first toss.` };
    if (!validCode(code)) return { cls: "fine bad", html: "a code is 3 to 20 letters or digits" };
    if (S.code && code === S.code) return { cls: "fine bad", html: "that is your own code · it cannot send you, share it instead" };
    if (!check || check.code !== code) return { cls: "fine", html: "checking…" };
    if (check.error) return { cls: "fine", html: "could not read the chain · the code is checked again at your toss" };
    if (same(check.owner, S.account)) return { cls: "fine bad", html: "that is your own code · it cannot send you, share it instead" };
    if (check.owner === ZERO) return { cls: "fine bad", html: `'${esc(code)}' is not a registered code · check the spelling` };
    return { cls: "fine ok", html: `sent by <b>${esc(code)}</b> · locks at your first toss · they earn ${pct}% of everything you toss, never out of your share` };
  }
  function nameNote(code, check) {
    if (!code) return { cls: "fine", html: `3 to 20 lowercase letters or digits · your link will be ${esc(pageLink().replace(/^https?:\/\//, ""))}?ref=<b>yourname</b>` };
    if (!validCode(code)) return { cls: "fine bad", html: /[^a-z0-9]/.test(code) ? "lowercase letters and digits only" : code.length < 3 ? "at least 3 characters" : "at most 20 characters" };
    if (!check || check.code !== code) return { cls: "fine", html: "checking…" };
    if (check.error) return { cls: "fine", html: "could not read the chain · it is checked again when you press GET MY LINK" };
    if (check.owner !== ZERO) return { cls: "fine bad", html: `'${esc(code)}' is taken · try another` };
    return { cls: "fine ok", html: `<b>${esc(code)}</b> is free · your link will be ${esc(refLink(code).replace(/^https?:\/\//, ""))}` };
  }
  function liveCheck(input, isName) {
    const note = host.querySelector(isName ? "#op-namenote" : "#op-refnote");
    if (!note) return;
    const code = isName ? String(input.value || "").trim().toLowerCase() : parseRef(input.value);
    if (!isName && code !== input.value && /[?&#]ref=|@|\s/.test(input.value)) input.value = code; // a pasted link collapses to its code
    const slot = isName ? "nameCheck" : "refCheck";
    const paint = () => { const n = (isName ? nameNote : refNote)(code, S[slot]); note.className = n.cls; note.innerHTML = n.html; };
    clearTimeout(checkT);
    if (S[slot] && S[slot].code === code) return paint();
    S[slot] = null; paint();
    if (!validCode(code) || (!isName && S.code && code === S.code)) return;
    const seq = ++checkSeq;
    checkT = setTimeout(async () => {
      let owner = ZERO, error = false;
      try { owner = await ownerOf(code); } catch (e) { error = true; }
      if (seq !== checkSeq) return;
      S[slot] = { code, owner, error };
      if (host.querySelector(isName ? "#op-namenote" : "#op-refnote")) paint();
    }, 400);
  }
  function onInput(e) {
    const t = e.target;
    if (!t || t.tagName !== "INPUT") return;
    if (t.id === "op-ref") liveCheck(t, false);
    else if (t.id === "op-code") liveCheck(t, true);
  }
  /// GOT A CODE? at the desk: live while the sender is open, disabled with the reason once it is not
  function refField(kept) {
    const pct = terms().refBps / 100;
    if (senderOpen()) {
      const value = kept != null ? kept : (linkCode() || (refCode() && !same(S.refOwner, S.account) ? refCode() : ""));
      const n = refNote(parseRef(value), S.refCheck);
      return `<div class="lab" style="margin-top:8px">GOT A CODE?</div>
      <div class="amt"><input type="text" id="op-ref" placeholder="a code, or a link · optional" value="${esc(value)}" maxlength="200" autocapitalize="off" spellcheck="false" autocomplete="off"></div>
      <div class="${n.cls}" id="op-refnote">${n.html}</div>`;
    }
    const settled = S.referrer !== ZERO;
    const who = settled ? (S.referrerCode ? esc(S.referrerCode) : short(S.referrer)) : "";
    return `<div class="lab" style="margin-top:8px">GOT A CODE?</div>
      <div class="amt"><input type="text" id="op-ref" value="${who}" placeholder="—" disabled></div>
      <div class="fine" id="op-refnote">${settled ? `your sender was set at your first toss: <b>${who}</b> · ${pct}% of every toss you make goes to them, never out of your share` : "you tossed before without a code · a sender is set only at the first toss, so a code changes nothing now"}</div>`;
  }
  /// what the card needs to know about this pond
  const CARD = CFG.card || {};
  const cardBranch = () => ({ slug: CARD.slug || "pond", branch: CARD.name || CFG.name || "THE POND", house: CARD.house || "FIRM BROKERS", symbol: SYM, mark: CARD.mark || "", words: CARD.words || {} });

  function render() {
    if (!host) return;
    // never wipe what someone is typing: skip this paint; the next poll paints. (Only text
    // fields. And NEVER re-render on blur: the blur fires on the mouse-down of the button
    // being clicked, and a re-render before the mouse-up replaces that button.)
    const active = document.activeElement;
    if (active && host.contains(active) && active.tagName === "INPUT" && active.type === "text") return;
    const keep = { amt: (host.querySelector("#op-amt") || {}).value, code: (host.querySelector("#op-code") || {}).value, ref: (host.querySelector("#op-ref") || {}).value };

    const r = S.cur;
    const now = Math.floor(Date.now() / 1000) - S.skew;
    const left = S.closesAt - now;
    const me = S.me;
    const T = terms();
    const myW = me ? me.weight : 0n;
    const tot = r ? r.totalWeight : 0n;
    const odds = myW > 0n && tot > 0n ? (Number((tot * 10n) / myW) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 }) : null;
    const cap = T.boostCapBps;
    const multX = (n) => { const x = Math.min(10000 + T.boostBps * n, cap) / 10000; return (Number.isInteger(x) ? x : x.toFixed(1)) + "×"; };
    const bellNY = S.closesAt ? nyTime(S.closesAt) : "4:00 PM";
    const youWon = (a) => same(a, S.account);
    const buyHref = CFG.buyUrl || null;
    const codeKnown = !!linkCode();
    const ownLink = !!refCode() && !!S.account && same(S.refOwner, S.account);
    const settled = S.referrer !== ZERO;
    const sender = settled ? (S.referrerCode ? esc(S.referrerCode) : short(S.referrer)) : codeKnown && (!S.account || senderOpen()) ? esc(refCode()) : "";
    const senderNote = sender && !settled ? (S.account ? " · locks at your first toss" : " · set at your first toss") : "";
    let badCode = refCode() && !codeKnown && !ownLink && !settled && S.loaded ? `<div class="fine">link code '${esc(refCode())}' is not registered · their ${T.refBps / 100}% would go to the pond</div>` : "";
    if (ownLink && !settled) badCode = `<div class="fine">that is your own link · it cannot send you, share it</div>`;
    else if (codeKnown && S.account && !settled && !senderOpen()) badCode = `<div class="fine">link '${esc(refCode())}' changes nothing now · a sender is set at your first toss, and you are already in</div>`;
    const usdLine = (units) => usd(units);

    // ---- the results banner: from the draw until the next bell
    const last = S.history.find((h) => h.state === 2 && h.playerCount > 0 && now < h.closesAt + 86400 + 600);
    let banner = "";
    if (last) {
      const who = (a) => (youWon(a) ? `<b class="won">YOU</b>` : `<b>${short(a)}</b>`);
      banner = `<div class="last">🔔 ${now - last.closesAt < 12 * 3600 ? "today" : "yesterday"}: ${last.jackpotWinner !== ZERO ? `pond ${fmt(last.jackpotPaid)} → ${who(last.jackpotWinner)} · ` : ""}frongs back ${fmt(last.refundPaid)} → ${who(last.refundWinner)}`;
      if (S.account) {
        const mine = [];
        if (youWon(last.jackpotWinner)) mine.push(`<b class="won">YOU took the pond: ${fmt(last.jackpotPaid)} ${SYM}</b>`);
        if (youWon(last.refundWinner)) mine.push(`<b class="won">YOU got your frongs back: ${fmt(last.refundPaid)} ${SYM}</b>`);
        if (S.claimable > 0n) mine.push(`you have ${fmt(S.claimable)} in dividends to claim → <button class="chip" data-act="claimdiv" type="button">CLAIM</button>`);
        if (mine.length) banner += `<div class="mine">${mine.join(" · ")}</div>`;
      }
      if (window.__POOL_CARD) banner += ` <button class="chip mini" data-act="wincard" data-id="${last.id}" type="button">SHARE THE RESULT</button>`;
      banner += `</div>`;
    }

    // ---- the winners tape: earns its place once there is history to roll
    const tickerItems = [];
    if (r && r.pot > 0n) tickerItems.push(`<span class="up">TODAY'S POND ${fmt(r.pot)} ${SYM}</span> · croaks ${bellNY} NY`);
    for (const h of S.history.filter((x) => x.state === 2 && x.playerCount > 0).slice(0, 6)) {
      tickerItems.push(h.jackpotWinner !== ZERO ? `${nyTime(h.closesAt, true)} · pond <span class="up">${fmt(h.jackpotPaid)}</span> → ${short(h.jackpotWinner)}` : `${nyTime(h.closesAt, true)} · frongs back ${fmt(h.refundPaid)} → ${short(h.refundWinner)}`);
    }
    const tape = tickerItems.join(" &nbsp;&nbsp;·&nbsp;&nbsp; ") + " &nbsp;&nbsp;·&nbsp;&nbsp; ";
    const half = tape.repeat(Math.max(2, Math.ceil(2400 / Math.max(80, tape.replace(/<[^>]+>/g, "").length * 8))));
    const tickerHtml = tickerItems.length > 1 ? `<div class="op-ticker"><div class="tape">${half}${half}</div></div>` : "";

    const board = `<div class="cab board${me && me.deposited > 0n ? " in" : ""}"><div class="scr">${banner}<div class="hero">
      <div class="lab">${r ? "TODAY'S POND" : "THE POND"}</div>
      <div class="pot${left > 0 && left <= 600 ? " hot2" : left > 0 && left <= 3600 ? " hot1" : ""}" data-pot="${r ? r.pot.toString() : "0"}"><span class="num">${r ? fmt(S.potShown && S.potShown < r.pot ? S.potShown : r.pot) : "—"}</span>${r ? ` <span class="unit">${SYM}</span>` : ""}</div>
      <div class="one">toss a frong in before the ${bellNY} <span class="long">New York</span><span class="short">NY</span> croak · one takes the pond, one gets their frongs back<span class="long"> · ${T.divBps / 100}% of every toss is paid out to everyone already in</span></div>
      <div class="fine">${r ? (r.playerCount === 0 && r.pot === 0n ? "the pond is open and nobody is in yet — the first toss today starts it" : [`${r.playerCount} player${r.playerCount === 1 ? "" : "s"}`, `${fmt(r.deposits)}&nbsp;in`, r.seed > 0n ? `${fmt(r.seed)} seeded` : "", usdLine(r.pot)].filter(Boolean).join(" · ")) : (S.loaded ? "nobody has tossed a frong in yet today — the first one opens the pond" : "reading the chain…")}</div></div>
      <div class="row">
        <div><div class="lab">${left > 0 ? "CROAKS IN" : "CROAKED"}</div><div class="cd${left > 0 && left <= HOT_WINDOW ? " hot" : ""}">${countdown(left)}</div><div class="fine">${S.closesAt ? `<span class="long">${nyTime(S.closesAt, true)} NY${localTime(S.closesAt)} · drawn ${Math.round(S.delay / 60)} min after the croak</span><span class="short">${nyTime(S.closesAt)} NY${localTime(S.closesAt, true)} · drawn +${Math.round(S.delay / 60)} min</span>` : ""}</div></div>
        ${me && me.deposited > 0n ? `<div><div class="lab">YOU TODAY</div><div class="hi">${fmt(me.deposited)} ${SYM}</div><div class="fine">${BOOST ? `${me.brokers} counted · ${multX(me.brokers)}` : (usdLine(me.deposited) || "&nbsp;")}</div></div>
        <div><div class="lab">YOUR CHANCE AT THE POND</div><div class="hi">${odds ? "1 in " + odds : "—"}</div><div class="fine">${me.divEarned > 0n ? "earned " + fmt(me.divEarned) + " in dividends today" : "&nbsp;"}</div></div>` : ""}
      </div></div></div>`;

    // ---- the bell, for a closed pool nobody has drawn
    let bell = "";
    if (S.due.length) {
      const d = S.history.find((h) => h.id === S.due[0]);
      const when = d ? nyTime(d.closesAt, true) : "round " + S.due[0];
      bell = `<div class="cab"><div class="scr"><div class="lab">THE CROAK</div><div>${d && now - d.closesAt < 86400 ? "yesterday's" : "a"} pond (${when}) is waiting for its draw.</div>
      <button class="go" data-act="bell" data-id="${S.due[0]}" ${S.account ? "" : "disabled"} type="button">MAKE IT CROAK</button>
      <div class="fine">fetches the beacon and hands it to the contract · anyone may${S.account ? "" : " · connect a wallet first"}</div></div></div>`;
    }

    // ---- the desk
    const poor = S.account && S.balance < T.minDeposit;
    const firstTime = S.account && S.allowance < T.minDeposit;
    let deskBody;
    if (S.fatal) {
      deskBody = `<div class="err">${S.fatal}</div>`;
    } else if (!S.account) {
      deskBody = S.pickWallet
        ? `<div class="lab">WHICH WALLET?</div><div class="wallets">${S.pickWallet.map((x, i) => `<button class="go" data-act="wallet" data-i="${i}" type="button">${esc(COPY.connect || "CONNECT")} · ${esc(x.info.name).toUpperCase()}</button>`).join("")}</div><div class="fine">this browser has more than one wallet · the one you pick is remembered here until you <button class="chip" data-act="switch" type="button">SWITCH WALLET</button></div>`
        : S.wrongChain
        ? `<div class="need">that wallet cannot switch to ${esc(CFG.chainName || "this chain")} — MetaMask (or any wallet with ${esc(CFG.chainName || "the chain")} added) works</div><div class="claims"><button class="go" data-act="switch" type="button">SWITCH WALLET</button></div>`
        : `<button class="go" data-act="connect" type="button">${esc(COPY.connect || "CONNECT WALLET")}</button><div class="fine">connect a wallet on ${esc(CFG.chainName || "the chain")} to toss, claim, or make it croak${sender ? ` · sent by <b>${sender}</b>${senderNote}` : ""}</div>${badCode}`;
    } else {
      const presets = (CFG.presets || []).map((n) => `<button class="chip" data-act="preset" data-n="${n}" type="button">${n >= 1e6 ? (n / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M" : n >= 1000 ? (n / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "k" : n.toLocaleString("en-US")}</button>`).join("");
      deskBody = `
      ${me && me.deposited > 0n ? `<div class="hi inline">you're in with ${fmt(me.deposited)} · ${odds ? "1 in " + odds : "—"}</div>` : ""}
      ${poor ? `<div class="need">you need at least ${fmt(T.minDeposit)} ${SYM} to toss${buyHref ? ` · <a href="${esc(buyHref)}" target="_blank" rel="noopener">get ${SYM} →</a>` : ""}</div>` : ""}
      <div class="amt"><input type="text" inputmode="decimal" id="op-amt" placeholder="${fmtExact(T.minDeposit)} min" autocomplete="off"></div>
      <div class="presets"><button class="chip" data-act="min" type="button">MIN</button>${presets}<button class="chip" data-act="max" type="button">MAX</button></div>
      ${refField(keep.ref)}
      <button class="go" data-act="chip" type="button" ${left > 0 && !poor ? "" : "disabled"}>${left > 0 ? (me && me.deposited > 0n ? "TOSS MORE" : "TOSS A FRONG") : "CROAKED — NEXT POND AT THE CROAK"}</button>
      ${firstTime && !poor ? `<div class="fine">two wallet prompts the first time: 1) allow ${SYM} · 2) toss</div>` : ""}
      <div class="fine">balance ${fmt(S.balance)} ${SYM} · ${short(S.account)}${sender && !senderOpen() ? " · sent by <b>" + sender + "</b>" + senderNote : ""} · <button class="chip mini" data-act="disconnect" type="button">DISCONNECT</button> <button class="chip mini" data-act="switch" type="button">SWITCH WALLET</button></div>${senderOpen() ? "" : badCode}
      <div class="lab" style="margin-top:6px">YOURS TO CLAIM</div>
      <div class="claims">
        <span>dividends <b>${fmt(S.claimable)}</b></span><button class="chip" data-act="claimdiv" type="button" ${S.claimable > 0n ? "" : "disabled"}>CLAIM</button>
        ${S.refOwed > 0n ? `<span>referrals <b>${fmt(S.refOwed)}</b></span><button class="chip" data-act="claimref" type="button">CLAIM</button>` : ""}
        ${S.claimable > 0n && S.refOwed > 0n ? `<button class="chip" data-act="claimall" type="button">CLAIM ALL</button>` : ""}
      </div>`;
    }
    const desk = `<div class="cab"><div class="scr"><div class="lab">TOSS IN</div><div class="desk">${deskBody}</div></div></div>`;

    const nn = nameNote(String(keep.code || "").trim().toLowerCase(), S.nameCheck);
    const ref = S.account && !S.fatal ? `<div class="cab ref"><div class="scr"><div class="lab">${S.code ? "YOUR LINK" : "GET MY LINK"}</div>
      ${S.code ? `<div class="link"><code class="lnk">${esc(refLink(S.code))}</code><button class="chip" data-act="copy" type="button">COPY LINK</button></div>
      <div class="link"><span class="dim">code</span><code class="big">${esc(S.code)}</code><button class="chip" data-act="copycode" type="button">COPY CODE</button></div>
      <div class="share">${window.__POOL_CARD ? `<button class="go" data-act="card" type="button">MAKE MY CARD · POST ON X</button>` : `<a class="chip" href="${xIntent(S.code)}" target="_blank" rel="noopener">POST ON X</a>`}<a class="chip" href="${tgIntent(S.code)}" target="_blank" rel="noopener">SHARE ON TELEGRAM</a></div>
      <div class="fine">${T.refBps / 100}% of every toss from anyone who opens the link or types the code, for life · never out of their share</div>`
      : `<div class="fine">pick a name once — one transaction — and your link and code are yours for life: ${T.refBps / 100}% of every toss from whoever arrives through them, claimable any time.</div>
      <div class="set"><input type="text" id="op-code" maxlength="20" placeholder="yourname" autocapitalize="off" spellcheck="false" autocomplete="off"><button class="chip" data-act="setcode" type="button">GET MY LINK</button></div>
      <div class="${nn.cls}" id="op-namenote">${nn.html}</div>`}
    </div></div>` : "";

    const ranked = S.players.slice().sort((a, b) => (b.v.deposited > a.v.deposited ? 1 : b.v.deposited < a.v.deposited ? -1 : 0)).slice(0, 10);
    const lead = `<div class="cab floor"><div class="scr"><div class="lab">WHO'S IN</div>
      <div class="grid3 head"><span>player${BOOST ? `<span class="long"> · counted</span>` : ""}</span><span>tossed<span class="long"> · earned in dividends</span></span></div>
      <div class="list">${ranked.length ? ranked.map((p, i) =>
        `<div class="grid3${same(p.addr, S.account) ? " me" : ""}"><span class="who">${i + 1}. ${same(p.addr, S.account) ? "<b class='won'>YOU</b>" : `<a href="${explorer(p.addr)}" rel="noopener">${short(p.addr)}</a>`}${BOOST && p.v.brokers ? ` <span class="dim brk">+${p.v.brokers} · ${multX(p.v.brokers)}</span>` : ""}</span><span class="n">${fmt(p.v.deposited)}<span class="dim sub"><span class="dot"> · </span>earned ${fmt(p.v.divEarned)}</span></span></div>`).join("")
        : `<div class="dim">${S.loaded ? "nobody yet" : "loading…"}</div>`}</div>
      <div class="lab" style="margin-top:14px">JUST NOW</div>
      <div class="list">${S.feed.length ? S.feed.map((d, i) => `<div class="r${same(d.player, S.account) ? " me" : ""}${S.seenDeposits && S.count - i > S.seenDeposits ? " new" : ""}"><span class="who">${same(d.player, S.account) ? "you" : short(d.player)} tossed</span><span class="n">${fmt(d.amount)} <span class="dim">${ago(d.at)} ago</span></span></div>`).join("") : `<div class="dim">${S.loaded ? "quiet so far" : "loading…"}</div>`}</div></div></div>`;

    const hist = `<div class="cab hist"><div class="scr"><div class="lab">PAST PONDS</div>
      <div class="list">${S.history.length ? S.history.map((h) => {
        const st = h.state === 2 ? (h.playerCount === 0 ? "nobody came · carried" : "") : h.state === 3 ? "abandoned · refunds open" : "waiting for its croak";
        const name = (a) => (youWon(a) ? `<b class="won">YOU</b>` : `<a href="${explorer(a)}" rel="noopener">${short(a)}</a>`);
        const drawn = h.state === 2 && h.playerCount > 0;
        return `<div class="r${youWon(h.refundWinner) || youWon(h.jackpotWinner) ? " me" : ""}"><div class="line"><b>${nyTime(h.closesAt, true)}<span class="dim"> · ${h.playerCount} player${h.playerCount === 1 ? "" : "s"}</span></b>${drawn ? (h.jackpotWinner !== ZERO ? `<span>pond <b>${fmt(h.jackpotPaid)}</b> → ${name(h.jackpotWinner)}</span>` : `<span class="dim">the refund was the whole pond</span>`) : `<span>${fmt(h.pot)} ${SYM}</span>`}${st ? `<span class="dim">${st}</span>` : ""}</div>
          ${drawn ? `<div class="line"><span>frongs back ${fmt(h.refundPaid)} → ${name(h.refundWinner)}</span><a class="dim" href="${drandUrl(h.beaconRound)}" rel="noopener">beacon ${h.beaconRound} ↗</a></div>` : ""}</div>`;
      }).join("") : `<div class="dim">${S.loaded ? "none yet" : "loading…"}</div>`}</div></div></div>`;

    const rules = `<div class="cab rules"><div class="lab">HOUSE RULES</div>
      <p><b>1.</b> Toss ${SYM} in before the ${bellNY} New York croak${T.minDeposit > 0n ? ` (at least <b>${fmtExact(T.minDeposit)}</b> a toss)` : ""}. <b>${T.divBps / 100}%</b> of every toss is paid out on the spot to everyone already in that day, pro-rata; <b>${T.refBps / 100}%</b> goes to whoever sent you.</p>
      <p><b>2.</b> ${Math.round(S.delay / 60)} minutes after the croak, drand's public beacon picks two players: one takes the pond, one gets their frongs back. Your chance is what you tossed in${BOOST ? `, up to <b>${cap / 10000}×</b> with a boost` : ""}. A toss is final.</p>
      <p><b>3.</b> The contract checks the beacon itself; nobody can pick or delay it. Every past pond links its beacon above. Fine print: <a href="${esc(COPY.rulesHref || "/methodology#pond")}">how the pond works</a>.</p></div>`;

    // the bell panel (a missed draw, rare) goes after the desk: on a phone it would push CHIP IN below the first screen
    host.innerHTML = tickerHtml + board + `<div class="cols"><div>${desk}${ref}</div><div>${lead}</div></div>` + bell + hist + rules;
    countUp(host.querySelector(".board .pot"));
    S.seenDeposits = S.count;
    const a = host.querySelector("#op-amt"), c = host.querySelector("#op-code"), rf = host.querySelector("#op-ref");
    if (a && keep.amt) a.value = keep.amt;
    if (c && keep.code) c.value = keep.code;
    if (rf && keep.ref != null) rf.value = keep.ref;
  }

  // ---------------------------------------------------------------- wiring
  async function refresh() {
    try { await load(); }
    catch (e) { console.warn("pool: read failed, will retry: " + ((e && e.stack) || e)); }
    render();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    const left = S.closesAt - (Math.floor(Date.now() / 1000) - S.skew);
    timer = setTimeout(refresh, left > 0 && left <= HOT_WINDOW ? POLL_HOT : POLL_IDLE);
  }
  function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const amt = () => document.getElementById("op-amt");
    if (act === "connect") { toast("opening your wallet…", undefined, 10000); return connect().catch((err) => toast(humanError(err), false)); }
    if (act === "min") { if (amt()) amt().value = fmtExact(terms().minDeposit); return; }
    if (act === "max") { if (amt()) amt().value = fmtExact(S.balance); return; }
    if (act === "preset") { if (amt()) amt().value = Number(b.dataset.n).toLocaleString("en-US"); return; }
    if (act === "switch") return switchWallet();
    if (act === "disconnect") return disconnect();
    if (act === "wallet") { const wl = S.pickWallet && S.pickWallet[Number(b.dataset.i)]; if (wl) connect(wl).catch((err) => toast(humanError(err), false)); return; }
    if (act === "chip") {
      if (S.closesAt && Math.floor(Date.now() / 1000) - S.skew >= S.closesAt) { refresh(); return toast("croaked — the next pond opens at the croak", false); }
      const v = parseAmount(amt() && amt().value);
      if (v == null || v <= 0n) return toast(`type an amount of ${SYM}, like 1,000 or 2.5k`, false);
      if (v < terms().minDeposit) return toast(`the minimum toss today is ${fmtExact(terms().minDeposit)} ${SYM}`, false);
      if (v > S.balance) return toast("that is more than you have", false);
      return chipIn(v);
    }
    if (act === "claimdiv") return claimDividends();
    if (act === "claimref") return claimReferral();
    if (act === "claimall") return (async () => { await claimDividends(); await claimReferral(); })();
    if (act === "setcode") { const i = document.getElementById("op-code"); return setCode(i && i.value); }
    if (act === "copy") { const c = host.querySelector(".ref code.lnk"); if (c && navigator.clipboard) navigator.clipboard.writeText(c.textContent).then(() => toast("link copied", true)); return; }
    if (act === "copycode") { if (S.code && navigator.clipboard) navigator.clipboard.writeText(S.code).then(() => toast("code copied", true)); return; }
    if (act === "card") {
      const r = S.cur;
      const inToday = !!(S.me && S.me.deposited > 0n);
      const lastDrawn = S.history.find((h) => h.state === 2 && h.playerCount > 0);
      const date = S.closesAt ? new Date(S.closesAt * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "";
      window.__POOL_CARD.open(Object.assign(cardBranch(), { code: S.code, link: refLink(S.code), pot: r ? fmt(r.pot) : "today's", players: r ? r.playerCount : 0, lastPaid: lastDrawn ? fmt(lastDrawn.refundPaid + lastDrawn.jackpotPaid) : "", bell: S.closesAt ? nyTime(S.closesAt) : "4:00 PM", date, inToday, postText: postText(S.code) }));
      return;
    }
    if (act === "wincard") {
      const h = S.history.find((x) => x.id === Number(b.dataset.id));
      if (!h || !window.__POOL_CARD) return;
      const winner = h.jackpotWinner !== ZERO ? h.jackpotWinner : h.refundWinner;
      const text = String(COPY.resultPost || `the croak: {paid} {sym} paid out of the pond, drawn by drand and checked on-chain. tomorrow's pond is open.\n\n{link}`).replace("{paid}", fmt(h.jackpotPaid + h.refundPaid)).replace(/\{sym\}/g, SYM).replace("{link}", pageLink());
      window.__POOL_CARD.open(Object.assign(cardBranch(), { kind: "winner", link: pageLink(), pot: fmt(h.pot > 0n ? h.pot : h.jackpotPaid + h.refundPaid), players: h.playerCount, winner, winnerCode: same(winner, S.account) ? S.code : "", refundWinner: h.refundWinner, refundPaid: fmt(h.refundPaid), beaconRound: h.beaconRound, bell: nyTime(h.closesAt), date: new Date(h.closesAt * 1000).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }), postText: text, code: "result" }));
      return;
    }
    if (act === "bell") return ringBell(Number(b.dataset.id));
  }

  function page(mount) {
    host = mount;
    if (!CFG.pool || !/^0x[0-9a-fA-F]{40}$/.test(CFG.pool)) {
      host.innerHTML = `<div class="cab"><div class="scr"><div class="lab">${esc(CFG.name || "THE POND")}</div><div>has not opened yet. When it does, this page is where it happens.</div></div></div>`;
      return;
    }
    if (!RPCS.length || !CFG.token) { host.innerHTML = `<div class="cab"><div class="scr err">the page is not configured (rpc / token)</div></div>`; return; }
    const tg = document.getElementById("pool-tg");
    if (tg && CFG.tg) { tg.querySelector("a").href = CFG.tg; tg.hidden = false; }
    // remember who sent you, for your first chip-in
    try { const c = new URL(location.href).searchParams.get("ref"); if (c && validCode(c.toLowerCase())) localStorage.setItem(REF_KEY, c.toLowerCase()); } catch (e) {}
    host.addEventListener("click", onClick);
    host.addEventListener("input", onInput);
    render();
    refresh();
    clearInterval(ticker);
    ticker = setInterval(() => { const cd = host.querySelector(".board .cd"); if (cd && S.closesAt) { const left = S.closesAt - (Math.floor(Date.now() / 1000) - S.skew); cd.textContent = countdown(left); cd.classList.toggle("hot", left > 0 && left <= HOT_WINDOW); } }, 1000);
  }

  window.__POOL = { page, parseRef, _S: S, decodeRound, decodePlayer, decodePlayers, decodeDeposits, parseAmount, fmt, fmtExact, bytes32, fromBytes32, decodeString };
})();
