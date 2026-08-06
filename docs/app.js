'use strict';
/* Frong Ledger frontend.
 * Baseline data comes from data/data.json (cron, ~10 min).
 * Live layer (price, tape) fetches client-side from public APIs.
 */

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const DS = 'https://api.dexscreener.com/latest/dex/tokens';
const TOKEN = '0x6245e67affA44a23077f0Ea7f981a8DC743a0c47';
const SUPPLY = 1e9;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const S = {
  data: null, snaps: [], candles: [], cts: [],
  livePrice: null, liveStats: null, launch: 0,
  byAddr: new Map(), sortKey: 'balance', sortDir: -1,
  flowHours: 72, tapeFloor: 500, tapeBuf: [], tapeSeen: new Set(),
  priceFails: 0, mainLog: false,
};

/* ---------------- formatting ---------------- */
const fmtUsd = v => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e6) return s + '$' + (a/1e6).toFixed(2) + 'M';
  if (a >= 1e4) return s + '$' + (a/1e3).toFixed(1) + 'k';
  if (a >= 100) return s + '$' + Math.round(a).toLocaleString('en-US');
  return s + '$' + a.toFixed(2);
};
const fmtSigned = v => (v >= 0 ? '+' : '−') + fmtUsd(Math.abs(v)).replace(/^−/, '');
const fmtPx = v => {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(6);
};
const fmtAmt = v => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e6) return s + (a/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return s + (a/1e3).toFixed(1) + 'k';
  return s + Math.round(a).toString();
};
const short = a => a.slice(0, 6) + '…' + a.slice(-4);
const fmtDT = ts => {
  const d = new Date(ts*1000);
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ' ' +
    String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
};
const fmtT = ts => {
  const d = new Date(ts*1000);
  return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') +
    ':' + String(d.getUTCSeconds()).padStart(2,'0');
};
const fmtD = ts => { const d = new Date(ts*1000); return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
const fmtAgo = ts => {
  const s = Math.max(0, Date.now()/1000 - ts);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 5400) return Math.round(s/60) + 'm ago';
  if (s < 90000) return (s/3600).toFixed(1) + 'h ago';
  return Math.round(s/86400) + 'd ago';
};
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const $ = id => document.getElementById(id);

/* ---------------- theme ---------------- */
$('themebtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  const dark = cur ? cur === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) {}
  renderCharts(); // charts read CSS vars indirectly via classes; safe either way
});

/* ---------------- candle price lookup ---------------- */
function priceAt(ts) {
  const c = S.candles, cts = S.cts;
  if (!c.length) return S.livePrice || 0;
  let lo = 0, hi = cts.length - 1;
  if (ts >= cts[hi]) return c[hi][1];
  if (ts <= cts[0]) return c[0][1];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (cts[m] <= ts) ? lo = m : hi = m; }
  return c[lo][1];
}
const isIn = (t, addr) => t.to.toLowerCase() === addr.toLowerCase();

/* ---------------- generic charts ---------------- */
function chartW(host) {
  const w = host.clientWidth || host.parentElement?.clientWidth || 1000;
  return Math.max(480, Math.min(1000, w));
}
function drawLine(host, opts) {
  const pts = opts.points;
  if (!pts || pts.length < 2) { host.innerHTML = '<p class="cardsub">Not enough data yet — check back soon.</p>'; return; }
  const W = chartW(host), H = opts.height || 300;
  const M = { t: 12, r: 14, b: opts.xTicks === false ? 8 : 26, l: 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const log = !!opts.log;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = opts.x0 ?? xs[0], x1 = opts.x1 ?? xs[xs.length - 1];
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (opts.refY != null) { yMin = Math.min(yMin, opts.refY); yMax = Math.max(yMax, opts.refY); }
  if (log) { yMin *= 0.85; yMax *= 1.15; }
  else if (opts.zeroBase !== false) { yMin = 0; yMax *= 1.06; }
  else { const pad = (yMax - yMin) * 0.15 || yMax * 0.01; yMin -= pad; yMax += pad; }
  const X = t => M.l + (t - x0) / Math.max(1, x1 - x0) * iw;
  const Y = v => log
    ? M.t + ih - (Math.log(v) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin)) * ih
    : M.t + ih - (v - yMin) / Math.max(1e-12, yMax - yMin) * ih;
  const yFmt = opts.yFmt || (v => fmtPx(v).slice(1));

  let yTicks = [];
  if (log) {
    for (let e = -6; e <= 2; e++) for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= yMin && v <= yMax) yTicks.push(v);
    }
    if (yTicks.length > 6) yTicks = yTicks.filter((_, i) => i % 2 === 0);
  } else {
    const step = niceStep((yMax - Math.min(0, yMin)) / (opts.yTickN || 4));
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push(v);
  }
  const xTicks = [];
  const span = x1 - x0, dayStep = span > 86400 * 8 ? 2 * 86400 : 86400;
  for (let d = Math.ceil(x0 / 86400) * 86400; d < x1; d += dayStep) xTicks.push(d);

  let g = '';
  for (const v of yTicks) {
    const y = Y(v);
    g += `<line class="gridline" x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}"/>`
      + `<text class="ticktext" x="${M.l - 8}" y="${y + 3}" text-anchor="end">${yFmt(v)}</text>`;
  }
  if (opts.xTicks !== false)
    for (const t of xTicks)
      g += `<text class="ticktext" x="${X(t)}" y="${H - 8}" text-anchor="middle">${fmtD(t)}</text>`;
  g += `<line class="axisline" x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}"/>`;

  const cls = opts.lineClass || 'priceline';
  const lineD = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'chart')}">` + g;
  if (opts.area !== false && cls === 'priceline')
    svg += `<path class="pricearea" d="${lineD}L${X(x1).toFixed(1)} ${M.t + ih}L${X(x0).toFixed(1)} ${M.t + ih}Z"/>`;
  svg += `<path class="${cls}" d="${lineD}"/>`;

  if (opts.refY != null && opts.refY > yMin && opts.refY < yMax) {
    const ry = Y(opts.refY);
    svg += `<line class="refline" x1="${M.l}" y1="${ry}" x2="${W - M.r}" y2="${ry}"/>`
      + `<text class="reflbl" x="${W - M.r - 4}" y="${ry - 5}" text-anchor="end">avg entry ${fmtPx(opts.refY)}</text>`;
  }
  const mks = opts.markers || [];
  mks.forEach((m, i) => {
    const x = X(Math.max(x0, Math.min(x1, m.ts)));
    const y = Y(Math.max(yMin * 1.0001, Math.min(yMax, m.price || yMin)));
    const r = Math.max(4.5, Math.min(9, 3 + Math.sqrt(m.usd || 0) / 38));
    const tri = m.dirIn
      ? `${x},${y - r} ${x - r * .9},${y + r * .7} ${x + r * .9},${y + r * .7}`
      : `${x},${y + r} ${x - r * .9},${y - r * .7} ${x + r * .9},${y - r * .7}`;
    svg += `<polygon class="${m.dirIn ? 'mk-buy' : 'mk-sell'}" points="${tri}" data-mi="${i}"/>`;
  });
  svg += `<line class="crossline" style="display:none"/>`
    + `<circle class="crossdot" r="4.5" style="display:none"/>`
    + `<rect class="hit" x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" fill="transparent"/></svg>`
    + `<div class="tip"></div>`;
  host.innerHTML = svg;

  const svgEl = host.querySelector('svg'), tip = host.querySelector('.tip');
  const cl = svgEl.querySelector('.crossline'), cdot = svgEl.querySelector('.crossdot');
  const showTip = (html, px, py) => {
    tip.innerHTML = html; tip.style.display = 'block';
    const bw = host.clientWidth, tw = tip.offsetWidth;
    let lx = px + 14; if (lx + tw > bw - 4) lx = px - tw - 14;
    tip.style.left = Math.max(4, lx) + 'px'; tip.style.top = Math.max(0, py - 34) + 'px';
  };
  const hideTip = () => { tip.style.display = 'none'; cl.style.display = 'none'; cdot.style.display = 'none'; };
  svgEl.querySelector('.hit').addEventListener('mousemove', ev => {
    const rect = svgEl.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * (W / rect.width);
    const t = x0 + (sx - M.l) / iw * (x1 - x0);
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; (pts[m][0] < t) ? lo = m : hi = m; }
    const p = Math.abs(pts[lo][0] - t) < Math.abs(pts[hi][0] - t) ? pts[lo] : pts[hi];
    const x = X(p[0]), y = Y(p[1]);
    cl.setAttribute('x1', x); cl.setAttribute('x2', x);
    cl.setAttribute('y1', M.t); cl.setAttribute('y2', M.t + ih); cl.style.display = '';
    cdot.setAttribute('cx', x); cdot.setAttribute('cy', y); cdot.style.display = '';
    showTip(`<b>${opts.yTipFmt ? opts.yTipFmt(p[1]) : fmtPx(p[1])}</b><br><span class="t2">${fmtDT(p[0])} UTC</span>`,
      x * (rect.width / W), y * (rect.height / H));
  });
  svgEl.querySelector('.hit').addEventListener('mouseleave', hideTip);
  svgEl.querySelectorAll('polygon[data-mi]').forEach(pg => {
    pg.addEventListener('mousemove', ev => {
      ev.stopPropagation();
      const m = mks[+pg.dataset.mi];
      const rect = svgEl.getBoundingClientRect(), bb = pg.getBBox();
      showTip(`<b>${m.dirIn ? '▲ BUY' : '▼ SELL'} ${fmtAmt(m.amount)} FRONG</b><br>`
        + `<span class="t2">@ ${fmtPx(m.price)} · ${fmtUsd(m.usd)}</span><br>`
        + `<span class="t2">${fmtDT(m.ts)} UTC${m.cpName ? ' · via ' + esc(m.cpName) : ''}</span>`,
        (bb.x + bb.width / 2) * (rect.width / W), bb.y * (rect.height / H));
    });
    pg.addEventListener('mouseleave', hideTip);
  });
}

function drawBars(host, opts) {
  const bk = opts.buckets;
  if (!bk || !bk.length) { host.innerHTML = '<p class="cardsub">No activity in this window.</p>'; return; }
  const W = chartW(host), H = opts.height || 200;
  const M = { t: 10, r: 14, b: 24, l: 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const x0 = opts.x0 ?? bk[0].ts, x1 = opts.x1 ?? (bk[bk.length - 1].ts + opts.bucketSec);
  const maxAbs = Math.max(...bk.map(b => Math.abs(b.val)), 1e-9) * 1.08;
  const diverging = opts.diverging !== false && bk.some(b => b.val < 0);
  const yMin = diverging ? -maxAbs : 0, yMax = maxAbs;
  const X = t => M.l + (t - x0) / Math.max(1, x1 - x0) * iw;
  const Y = v => M.t + ih - (v - yMin) / (yMax - yMin) * ih;
  const bw = Math.max(1.5, iw / Math.max(1, (x1 - x0) / opts.bucketSec) - 2);
  const yFmt = opts.yFmt || fmtAmt;

  let g = '';
  const step = niceStep(maxAbs / 2);
  for (let v = diverging ? -Math.floor(maxAbs / step) * step : 0; v <= maxAbs; v += step) {
    const y = Y(v);
    g += `<line class="gridline" x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}"/>`
      + `<text class="ticktext" x="${M.l - 8}" y="${y + 3}" text-anchor="end">${yFmt(v)}</text>`;
  }
  const span = x1 - x0, dayStep = span > 86400 * 8 ? 2 * 86400 : 86400;
  for (let d = Math.ceil(x0 / 86400) * 86400; d < x1; d += dayStep)
    g += `<text class="ticktext" x="${X(d)}" y="${H - 6}" text-anchor="middle">${fmtD(d)}</text>`;
  g += `<line class="axisline" x1="${M.l}" y1="${Y(0)}" x2="${W - M.r}" y2="${Y(0)}"/>`;

  let bars = '';
  bk.forEach((b, i) => {
    if (Math.abs(b.val) < 1e-12) return;
    const x = X(b.ts) + 1, y0 = Y(0), y1v = Y(b.val);
    const yTop = Math.min(y0, y1v), h = Math.max(1.2, Math.abs(y0 - y1v));
    const cls = opts.barClass || (b.val >= 0 ? 'bar-pos' : 'bar-neg');
    bars += `<rect class="${cls}" x="${x.toFixed(1)}" width="${bw.toFixed(1)}" y="${yTop.toFixed(1)}" height="${h.toFixed(1)}" rx="2" data-bi="${i}"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'bar chart')}">${g}${bars}</svg><div class="tip"></div>`;

  const svgEl = host.querySelector('svg'), tip = host.querySelector('.tip');
  svgEl.querySelectorAll('rect[data-bi]').forEach(r => {
    r.addEventListener('mousemove', () => {
      const b = bk[+r.dataset.bi];
      const rect = svgEl.getBoundingClientRect(), bb = r.getBBox();
      tip.innerHTML = opts.tipFmt ? opts.tipFmt(b) : `<b>${fmtAmt(b.val)}</b><br><span class="t2">${fmtDT(b.ts)} UTC</span>`;
      tip.style.display = 'block';
      const px = (bb.x + bb.width / 2) * (rect.width / W);
      const bw2 = host.clientWidth, tw = tip.offsetWidth;
      let lx = px + 10; if (lx + tw > bw2 - 4) lx = px - tw - 10;
      tip.style.left = Math.max(4, lx) + 'px';
      tip.style.top = Math.max(0, bb.y * (rect.height / H) - 30) + 'px';
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}
function niceStep(raw) {
  if (!isFinite(raw) || raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/* ---------------- badges ---------------- */
function badges(w) {
  const out = [];
  if (w.first_ts != null) {
    if (w.first_ts - S.launch < 600) out.push(['sniper', 'og', 'bought within 10 minutes of pool creation']);
    else if (w.first_ts - S.launch < 86400) out.push(['day one', 'og', 'first buy within 24h of launch']);
  }
  if (w.n_txs >= 300) out.push(['bot', '', 'high-frequency: ' + w.n_txs + ' transfers']);
  const via = w.txs.filter(t => (t.from_name || t.to_name || '').startsWith('RobinHoodSettler')).length;
  if (via > w.n_txs / 2) out.push(['RH app', '', 'majority of flow routed through Robinhood app order flow']);
  const xferIn = w.txs.filter(t => isIn(t, w.addr) && !t.from_c).reduce((s, t) => s + t.usd, 0);
  if (w.buy_usd > 0 && xferIn > w.buy_usd / 2) out.push(['xfer-in', '', 'position mostly received from another wallet, priced at market on receipt']);
  if (w.truncated) out.push(['partial', '', 'history truncated — cost basis approximate']);
  if (w.balance_mismatch) out.push(['reconciling', '', 'balance moved during last refresh; resolves next cycle']);
  return out.map(([t, c, tip]) => `<span class="badge ${c}" title="${esc(tip)}">${t}</span>`).join('');
}

/* ---------------- live PnL ---------------- */
function liveCalc(w) {
  const px = S.livePrice || S.data.token.price;
  w._value = w.balance * px;
  w._unreal = w.avg_entry ? (px - w.avg_entry) * w.balance : null;
  w._upct = w.avg_entry ? (px / w.avg_entry - 1) * 100 : null;
}

/* ---------------- sections ---------------- */
function renderStats() {
  const t = S.data.token, px = S.livePrice || t.price;
  const ls = S.liveStats || {};
  const chg = ls.chg24 ?? t.chg24;
  $('stats').innerHTML = [
    ['Price · live', fmtPx(px) + (chg != null ? `<span class="delta ${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h</span>` : '')],
    ['FDV', fmtUsd(px * SUPPLY)],
    ['Main-pool liquidity', fmtUsd(ls.liq ?? t.liq_main)],
    ['24h volume · all pools', fmtUsd(ls.vol24 ?? t.vol24_all)],
    ['Holders', (ls.holders ?? t.holders_count).toLocaleString('en-US')],
  ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  $('liveprice').textContent = 'FRONG ' + fmtPx(px);
}

function mainChartPoints() {
  const pts = S.candles.slice();
  if (S.livePrice) pts.push([Math.floor(Date.now() / 1000), S.livePrice]);
  return pts;
}
function renderMainChart() {
  drawLine($('mainchart'), { points: mainChartPoints(), height: 300, log: S.mainLog,
    label: 'FRONG price since launch' });
  $('chartmeta').textContent = 'baseline ' + fmtAgo(S.data.generated_at) + ' · live point appended';
}

function renderFlow() {
  const now = Math.floor(Date.now() / 1000);
  const h = S.flowHours, x0 = h ? now - h * 3600 : S.launch, x1 = now;
  const B = 3600;
  const map = new Map();
  for (const w of S.data.wallets) {
    if (!w.in_top) continue;
    for (const t of w.txs) {
      if (t.ts < x0) continue;
      const b = t.ts - t.ts % B;
      const e = map.get(b) || { ts: b, val: 0, buy: 0, sell: 0 };
      if (isIn(t, w.addr)) { e.val += t.amount; e.buy += t.amount; }
      else { e.val -= t.amount; e.sell += t.amount; }
      map.set(b, e);
    }
  }
  const buckets = [...map.values()].sort((a, b) => a.ts - b.ts);
  drawBars($('flowchart'), { buckets, bucketSec: B, height: 190, x0, x1,
    label: 'Net whale flow per hour',
    tipFmt: b => `<b>${b.val >= 0 ? '+' : ''}${fmtAmt(b.val)} net</b><br>` +
      `<span class="t2">▲ ${fmtAmt(b.buy)} · ▼ ${fmtAmt(b.sell)}</span><br>` +
      `<span class="t2">${fmtDT(b.ts)} UTC</span>` });
  const hs = S.snaps.filter(s => s.ts >= x0).map(s => [s.ts, s.holders]);
  if (hs.length >= 2)
    drawLine($('holderchart'), { points: hs, height: 90, zeroBase: false, area: false,
      lineClass: 'holderline', x0, x1, yTickN: 2, xTicks: false,
      yFmt: v => Math.round(v).toLocaleString('en-US'),
      yTipFmt: v => Math.round(v).toLocaleString('en-US') + ' holders',
      label: 'Holder count' });
  else $('holderchart').innerHTML =
    '<p class="cardsub">Holder-count trend appears here as snapshots accumulate (one every 10 min).</p>';
}

function renderAggr() {
  const ws = S.data.wallets.filter(w => w.in_top);
  const bal = ws.reduce((s, w) => s + w.balance, 0);
  const val = ws.reduce((s, w) => s + w._value, 0);
  const unr = ws.reduce((s, w) => s + (w._unreal || 0), 0);
  const inP = ws.filter(w => (w._unreal || 0) > 0).length;
  $('aggr').innerHTML = [
    ['Share of supply', (bal / SUPPLY * 100).toFixed(1) + '%'],
    ['Combined value', fmtUsd(val)],
    ['Combined unrealized', `<span class="${unr >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtSigned(unr)}</span>`],
    ['In profit', `${inP} <span class="delta">vs ${ws.length - inP} under</span>`],
  ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
}

function rowHTML(w, pos) {
  const mult = w.avg_entry ? (S.livePrice || S.data.token.price) / w.avg_entry : null;
  const multTxt = mult == null ? '' :
    (mult >= 5 ? '×' + mult.toFixed(1) + ' vs now' : (mult - 1 >= 0 ? '+' : '') + ((mult - 1) * 100).toFixed(0) + '% vs now');
  const u = w._unreal, uc = u == null ? '' : (u >= 0 ? 'pnl-pos' : 'pnl-neg');
  const r = w.realized, rc = Math.abs(r) < 1 ? '' : (r >= 0 ? 'pnl-pos' : 'pnl-neg');
  return `
  <tr class="hrow" data-a="${w.addr}" tabindex="0" role="button" aria-expanded="false"
      aria-label="Wallet ${short(w.addr)}, expand trade history">
    <td class="l rank">${pos}</td>
    <td class="l"><span class="addr">${short(w.addr)}</span>${badges(w)}</td>
    <td>${fmtAmt(w.balance)}<span class="subcell">${(w.balance / SUPPLY * 100).toFixed(2)}% supply</span></td>
    <td data-c="val">${fmtUsd(w._value)}</td>
    <td>${fmtPx(w.avg_entry)}<span class="subcell">${multTxt}</span></td>
    <td class="${uc}" data-c="unreal">${u == null ? '—' : fmtSigned(u)}<span class="subcell">${w._upct == null ? '' : (w._upct >= 0 ? '+' : '−') + Math.abs(w._upct).toFixed(0) + '%'}</span></td>
    <td class="${rc}">${Math.abs(r) < 1 ? '—' : fmtSigned(r)}</td>
    <td>${w.first_ts ? fmtDT(w.first_ts) : '—'}<span class="subcell">UTC</span></td>
    <td><span class="chev">▶</span></td>
  </tr>
  <tr class="detail" hidden><td colspan="9"></td></tr>`;
}

function renderTable() {
  const key = { balance: 'balance', value_usd: '_value', avg_entry: 'avg_entry',
    unrealized: '_unreal', realized: 'realized', first_ts: 'first_ts' }[S.sortKey];
  const ws = S.data.wallets.filter(w => w.in_top).slice();
  ws.sort((a, b) => {
    const va = a[key], vb = b[key];
    return ((va == null) - (vb == null)) || S.sortDir * ((va > vb) - (va < vb));
  });
  $('tbody').innerHTML = ws.map((w, i) => rowHTML(w, i + 1)).join('');
  document.querySelectorAll('#tbl thead .arr').forEach(s => s.textContent = '');
  const th = document.querySelector(`#tbl thead button[data-sort="${S.sortKey}"] .arr`);
  if (th) th.textContent = S.sortDir < 0 ? '↓' : '↑';
  $('tbody').querySelectorAll('tr.hrow').forEach(tr => {
    const open = () => toggleRow(tr);
    tr.addEventListener('click', ev => { if (!ev.target.closest('a')) open(); });
    tr.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
    });
  });
}
document.querySelectorAll('#tbl thead button[data-sort]').forEach(b => {
  b.addEventListener('click', () => {
    const k = b.dataset.sort;
    if (S.sortKey === k) S.sortDir *= -1; else { S.sortKey = k; S.sortDir = -1; }
    renderTable();
  });
});

function toggleRow(tr) {
  const det = tr.nextElementSibling;
  const isOpen = tr.getAttribute('aria-expanded') === 'true';
  tr.setAttribute('aria-expanded', String(!isOpen));
  det.hidden = isOpen;
  if (!isOpen && !det.dataset.built) {
    const w = S.data.wallets.find(x => x.addr === tr.dataset.a);
    det.firstElementChild.appendChild(buildPanel(w));
    det.dataset.built = '1';
  }
}

function buildPanel(w) {
  const el = document.createElement('div');
  el.className = 'panel';
  const buys = w.txs.filter(t => isIn(t, w.addr)), sells = w.txs.filter(t => !isIn(t, w.addr));
  el.innerHTML = `
    <div class="pstats">
      <span>bought <b>${fmtAmt(buys.reduce((s, t) => s + t.amount, 0))} · ${fmtUsd(w.buy_usd)}</b></span>
      <span>sold <b>${fmtAmt(sells.reduce((s, t) => s + t.amount, 0))} · ${fmtUsd(w.sell_usd)}</b></span>
      <span>transfers <b>${w.n_txs}</b></span>
      <span>realized <b class="${w.realized >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtSigned(w.realized)}</b></span>
      <span><a href="${EXPLORER}/address/${w.addr}" target="_blank" rel="noopener">Blockscout ↗</a></span>
    </div>
    <div class="chartbox mini"></div>
    <div class="legend">
      <span class="key"><svg width="12" height="10"><polygon points="6,1 1,9 11,9" class="mk-buy" style="stroke-width:1.5"/></svg> buy</span>
      <span class="key"><svg width="12" height="10"><polygon points="6,9 1,1 11,1" class="mk-sell" style="stroke-width:1.5"/></svg> sell</span>
      <span class="key">marker size ∝ trade USD · thin rule = avg entry</span>
    </div>
    <div class="txwrap tblwrap">
      <table>
        <thead><tr><th class="l">Time (UTC)</th><th class="l">Side</th><th>FRONG</th><th>Price</th><th>USD</th><th class="l">Counterparty</th><th class="l">Tx</th></tr></thead>
        <tbody>${w.txs.slice().reverse().map(t => {
          const inn = isIn(t, w.addr);
          const cp = inn ? t.from : t.to, cpn = inn ? t.from_name : t.to_name, cpc = inn ? t.from_c : t.to_c;
          return `<tr>
            <td class="l">${fmtDT(t.ts)}</td>
            <td class="l"><span class="side ${inn ? 'b' : 's'}">${inn ? '▲ BUY' : '▼ SELL'}</span></td>
            <td>${fmtAmt(t.amount)}</td><td>${fmtPx(t.price)}</td><td>${fmtUsd(t.usd)}</td>
            <td class="l cp">${cpn ? esc(cpn) : short(cp)}${cpc && !cpn ? ' <span class="cptag">contract</span>' : ''}</td>
            <td class="l"><a href="${EXPLORER}/tx/${t.tx}" target="_blank" rel="noopener">${t.tx ? t.tx.slice(0, 10) + '…' : ''} ↗</a></td>
          </tr>`; }).join('')}
        </tbody>
      </table>
    </div>`;
  const markers = w.txs.map(t => ({ ts: t.ts, price: t.price, usd: t.usd, amount: t.amount,
    dirIn: isIn(t, w.addr), cpName: isIn(t, w.addr) ? t.from_name : t.to_name }));
  drawLine(el.querySelector('.mini'), { points: mainChartPoints(), height: 220,
    refY: w.avg_entry, markers, label: 'Price with this wallet’s trades' });
  return el;
}

function renderDiamond() {
  const px = S.livePrice || S.data.token.price;
  const day1 = S.data.wallets.filter(w => w.in_top && w.first_ts && w.first_ts - S.launch < 86400 && w.avg_entry);
  day1.forEach(w => { w._mult = px / w.avg_entry; });
  const top = day1.sort((a, b) => b._mult - a._mult).slice(0, 9);
  $('dgrid').innerHTML = top.map((w, i) => {
    const bought = w.txs.filter(t => isIn(t, w.addr)).reduce((s, t) => s + t.amount, 0);
    const held = bought > 0 ? Math.min(100, w.balance / bought * 100) : 0;
    const never = w.sell_usd < 1;
    return `<div class="dcard">
      <div class="drank">#${i + 1} · entered ${fmtDT(w.first_ts)} UTC</div>
      <div class="daddr"><a href="${EXPLORER}/address/${w.addr}" target="_blank" rel="noopener">${short(w.addr)}</a>
        ${never ? '<span class="badge og">never sold</span>' : ''}</div>
      <div class="dmult">×${w._mult >= 100 ? w._mult.toFixed(0) : w._mult.toFixed(1)}</div>
      <div class="heldbar"><i style="width:${held.toFixed(0)}%"></i></div>
      <div class="drow"><span>still holding</span><b>${held.toFixed(0)}%</b></div>
      <div class="drow"><span>avg entry</span><b>${fmtPx(w.avg_entry)}</b></div>
      <div class="drow"><span>position</span><b>${fmtUsd(w.balance * px)}</b></div>
    </div>`;
  }).join('') || '<p class="cardsub">No day-one wallets in the top 50 right now.</p>';
}

function renderFlywheel() {
  const hv = S.data.harvests || [];
  const px = S.livePrice || S.data.token.price;
  const tot = hv.reduce((s, h) => s + h.frong, 0);
  const last = hv.length ? hv[hv.length - 1].ts : null;
  $('fwtiles').innerHTML = [
    ['FRONG recycled', fmtAmt(tot) + `<span class="delta">${(tot / SUPPLY * 100).toFixed(2)}% of supply</span>`],
    ['≈ value at current price', fmtUsd(tot * px)],
    ['Harvests', String(hv.length)],
    ['Last harvest', last ? fmtAgo(last) : '—'],
  ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  const map = new Map();
  for (const h of hv) {
    const d = h.ts - h.ts % 86400;
    map.set(d, (map.get(d) || 0) + h.frong);
  }
  const buckets = [...map.entries()].map(([ts, val]) => ({ ts, val })).sort((a, b) => a.ts - b.ts);
  let cum = 0; buckets.forEach(b => { cum += b.val; b.cum = cum; });
  drawBars($('fwchart'), { buckets, bucketSec: 86400, height: 170, diverging: false,
    barClass: 'bar-acc', label: 'FRONG recycled into locked liquidity per day',
    tipFmt: b => `<b>${fmtAmt(b.val)} FRONG</b> recycled<br><span class="t2">${fmtD(b.ts)} · cumulative ${fmtAmt(b.cum)}</span>` });
}

function renderInfra() {
  $('infra').innerHTML = (S.data.contracts_top || []).map(c => {
    const nm = c.name ? esc(c.name) : short(c.addr);
    return `<span title="${esc(c.addr)}"><a href="${EXPLORER}/address/${c.addr}" target="_blank" rel="noopener">${nm}</a> ${fmtAmt(c.balance)} (${(c.balance / SUPPLY * 100).toFixed(2)}%)</span>`;
  }).join('');
}

function renderCharts() { renderMainChart(); renderFlow(); renderFlywheel(); }

/* live-price refresh of computed cells without rebuilding the table */
function refreshLiveCells() {
  S.data.wallets.forEach(liveCalc);
  renderStats(); renderAggr();
  $('tbody').querySelectorAll('tr.hrow').forEach(tr => {
    const w = S.data.wallets.find(x => x.addr === tr.dataset.a);
    if (!w) return;
    const val = tr.querySelector('[data-c="val"]'), un = tr.querySelector('[data-c="unreal"]');
    if (val) val.textContent = fmtUsd(w._value);
    if (un && w._unreal != null) {
      un.className = w._unreal >= 0 ? 'pnl-pos' : 'pnl-neg';
      un.innerHTML = fmtSigned(w._unreal) +
        `<span class="subcell">${(w._upct >= 0 ? '+' : '−') + Math.abs(w._upct).toFixed(0)}%</span>`;
    }
  });
}

/* ---------------- live layer ---------------- */
async function pollPrice() {
  try {
    const r = await fetch(`${DS}/${TOKEN}`);
    const d = await r.json();
    const p = d.pairs.reduce((a, b) => a.liquidity.usd > b.liquidity.usd ? a : b);
    S.livePrice = parseFloat(p.priceUsd);
    S.liveStats = { chg24: p.priceChange?.h24, liq: p.liquidity.usd,
      vol24: d.pairs.reduce((s, x) => s + x.volume.h24, 0) };
    S.priceFails = 0;
    $('livedot').classList.add('on'); $('livedot').classList.remove('stale');
    refreshLiveCells(); renderMainChart(); renderDiamond();
  } catch (e) {
    if (++S.priceFails > 2) { $('livedot').classList.add('stale'); $('livedot').classList.remove('on'); }
  }
}

async function pollTape() {
  try {
    const r = await fetch(`${BS}/tokens/${TOKEN}/transfers`);
    const d = await r.json();
    const px = S.livePrice || S.data.token.price;
    const fresh = [];
    for (const it of (d.items || [])) {
      if (it.from.is_contract && it.to.is_contract) continue; // internal routing legs, not trades
      const key = (it.transaction_hash || it.tx_hash || '') + ':' + (it.log_index ?? '') + ':' + it.from.hash + it.to.hash + it.total.value;
      if (S.tapeSeen.has(key)) continue;
      S.tapeSeen.add(key);
      const amt = parseInt(it.total.value) / 1e18;
      fresh.push({
        ts: Math.floor(new Date(it.timestamp).getTime() / 1000),
        from: it.from.hash, from_c: !!it.from.is_contract, from_name: it.from.name,
        to: it.to.hash, to_c: !!it.to.is_contract, to_name: it.to.name,
        amount: amt, usd: amt * px,
        tx: it.transaction_hash || it.tx_hash, isNew: S.tapeBuf.length > 0,
      });
    }
    fresh.sort((a, b) => b.ts - a.ts);
    S.tapeBuf = fresh.concat(S.tapeBuf).slice(0, 150);
    if (S.tapeSeen.size > 2000) S.tapeSeen = new Set(S.tapeBuf.map(t =>
      t.tx + ':' + t.from + t.to + t.amount));
    renderTape();
    $('tapemeta').textContent = 'updated ' + fmtT(Math.floor(Date.now() / 1000)) + ' UTC';
  } catch (e) {
    $('tapemeta').textContent = 'reconnecting…';
  }
}

function renderTape() {
  const px = S.livePrice || S.data.token.price;
  const rows = S.tapeBuf.filter(t => t.amount * px >= S.tapeFloor).slice(0, 80);
  $('tapebody').innerHTML = rows.map(t => {
    let side, actor, actorName, cls;
    if (t.from_c && !t.to_c) { side = '▲ BUY'; cls = 'b'; actor = t.to; actorName = t.to_name; }
    else if (!t.from_c && t.to_c) { side = '▼ SELL'; cls = 's'; actor = t.from; actorName = t.from_name; }
    else { side = '⇄ XFER'; cls = 'x'; actor = t.from; actorName = t.from_name; }
    const tracked = S.byAddr.get(actor.toLowerCase());
    return `<tr class="${t.isNew ? 'fresh' : ''}">
      <td class="l">${fmtT(t.ts)}</td>
      <td class="l"><span class="side ${cls}">${side}</span></td>
      <td>${fmtAmt(t.amount)}</td>
      <td>${fmtUsd(t.amount * px)}</td>
      <td class="l"><a href="${EXPLORER}/address/${actor}" target="_blank" rel="noopener">${actorName ? esc(actorName) : short(actor)}</a>${tracked ? ` <span class="whotag">#${tracked.rank}</span>` : ''}</td>
      <td class="l"><a href="${EXPLORER}/tx/${t.tx}" target="_blank" rel="noopener">↗</a></td>
    </tr>`;
  }).join('') || `<tr><td class="l" colspan="6" style="color:var(--muted)">No trades above the current size filter yet.</td></tr>`;
  S.tapeBuf.forEach(t => t.isNew = false);
}

/* ---------------- lookup ---------------- */
async function lookup() {
  const raw = $('lookupaddr').value.trim();
  const msg = $('lookupmsg'), out = $('lookupresult');
  out.innerHTML = '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) { msg.textContent = 'That doesn’t look like an address — expected 0x followed by 40 hex characters.'; return; }
  const btn = $('lookupbtn'); btn.disabled = true;
  const tracked = S.byAddr.get(raw.toLowerCase());
  try {
    let w;
    if (tracked) { w = tracked.w; msg.textContent = `Tracked whale — rank #${tracked.rank} by balance.`; }
    else {
      msg.textContent = 'Fetching transfer history…';
      const txs = []; let truncated = false;
      let url = `${BS}/addresses/${raw}/token-transfers?token=${TOKEN}`;
      for (let p = 0; p < 8; p++) {
        const r = await fetch(url); if (!r.ok) throw new Error('indexer ' + r.status);
        const d = await r.json();
        for (const it of (d.items || [])) {
          txs.push({ ts: Math.floor(new Date(it.timestamp).getTime() / 1000),
            from: it.from.hash, from_c: !!it.from.is_contract, from_name: it.from.name,
            to: it.to.hash, to_c: !!it.to.is_contract, to_name: it.to.name,
            amount: parseInt(it.total.value) / 1e18,
            tx: it.transaction_hash || it.tx_hash });
        }
        if (!d.next_page_params) break;
        if (p === 7) { truncated = true; break; }
        url = `${BS}/addresses/${raw}/token-transfers?token=${TOKEN}&` +
          Object.entries(d.next_page_params).map(([k, v]) => `${k}=${v}`).join('&');
      }
      if (!txs.length) { msg.textContent = 'No FRONG history found for this wallet.'; btn.disabled = false; return; }
      txs.sort((a, b) => a.ts - b.ts);
      let bal = 0;
      try {
        const br = await (await fetch(`${BS}/addresses/${raw}/token-balances`)).json();
        for (const tb of br) if (tb.token.address_hash.toLowerCase() === TOKEN.toLowerCase())
          bal = parseInt(tb.value) / 1e18;
      } catch (e) {
        bal = txs.reduce((s, t) => s + (t.to.toLowerCase() === raw.toLowerCase() ? t.amount : -t.amount), 0);
      }
      let qty = 0, cost = 0, realized = 0, buy_usd = 0, sell_usd = 0;
      for (const t of txs) {
        const p = priceAt(t.ts); t.price = p; t.usd = t.amount * p;
        if (t.to.toLowerCase() === raw.toLowerCase()) { cost += t.usd; qty += t.amount; buy_usd += t.usd; }
        else {
          const avg = qty > 0 ? cost / qty : p;
          const take = Math.min(t.amount, qty);
          realized += take * (p - avg); cost -= take * avg;
          qty = Math.max(0, qty - t.amount); sell_usd += t.usd;
        }
      }
      const avg_entry = qty > 0 ? cost / qty : null;
      w = { addr: raw, balance: bal, avg_entry, realized, buy_usd, sell_usd,
        n_txs: txs.length, txs, truncated, first_ts: txs[0].ts,
        balance_mismatch: false, in_top: false };
      msg.textContent = truncated ? 'Showing the most recent 400 transfers — older history omitted, so cost basis is approximate.' : '';
    }
    liveCalc(w);
    const px = S.livePrice || S.data.token.price;
    const head = document.createElement('div');
    head.className = 'stats';
    head.style.marginTop = '14px';
    head.innerHTML = [
      ['Balance', fmtAmt(w.balance) + `<span class="delta">${(w.balance / SUPPLY * 100).toFixed(3)}%</span>`],
      ['Value', fmtUsd(w.balance * px)],
      ['Avg entry', fmtPx(w.avg_entry)],
      ['Unrealized PnL', w._unreal == null ? '—' : `<span class="${w._unreal >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtSigned(w._unreal)}</span>`],
      ['Realized', `<span class="${w.realized >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtSigned(w.realized)}</span>`],
    ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
    out.appendChild(head);
    out.appendChild(buildPanel(w));
  } catch (e) {
    msg.textContent = 'Couldn’t reach the chain indexer — try again in a few seconds.';
  }
  btn.disabled = false;
}
$('lookupbtn').addEventListener('click', lookup);
$('lookupaddr').addEventListener('keydown', ev => { if (ev.key === 'Enter') lookup(); });

/* ---------------- controls ---------------- */
$('sc-lin').addEventListener('click', () => { S.mainLog = false; syncScale(); renderMainChart(); });
$('sc-log').addEventListener('click', () => { S.mainLog = true; syncScale(); renderMainChart(); });
function syncScale() {
  $('sc-lin').setAttribute('aria-pressed', String(!S.mainLog));
  $('sc-log').setAttribute('aria-pressed', String(S.mainLog));
}
$('flowrange').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  S.flowHours = +b.dataset.h;
  $('flowrange').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderFlow();
}));
$('tapefloor').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  S.tapeFloor = +b.dataset.f;
  $('tapefloor').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderTape();
}));

/* ---------------- boot ---------------- */
async function boot() {
  const [dr, sr] = await Promise.all([
    fetch('data/data.json'), fetch('data/snapshots.jsonl'),
  ]);
  S.data = await dr.json();
  const stext = await sr.text();
  S.snaps = stext.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  S.candles = (S.data.candles1h || []).concat(S.data.candles5 || []);
  S.cts = S.candles.map(c => c[0]);
  S.launch = S.candles.length ? S.candles[0][0] : S.data.wallets[0].txs[0].ts;
  const ranked = S.data.wallets.filter(w => w.in_top).slice().sort((a, b) => b.balance - a.balance);
  ranked.forEach((w, i) => S.byAddr.set(w.addr.toLowerCase(), { rank: i + 1, w }));
  S.data.wallets.forEach(liveCalc);

  renderStats(); renderMainChart(); renderFlow(); renderAggr(); renderTable();
  renderDiamond(); renderFlywheel(); renderInfra();
  $('gen').textContent = 'baseline refreshed ' + fmtAgo(S.data.generated_at);

  pollPrice(); pollTape();
  setInterval(pollPrice, 30000);
  setInterval(pollTape, 25000);
  setInterval(() => { $('gen').textContent = 'baseline refreshed ' + fmtAgo(S.data.generated_at); }, 30000);
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderCharts, 200); });
}
boot().catch(e => {
  document.querySelector('.hero p').textContent = 'Failed to load data — refresh the page to retry.';
  console.error(e);
});
