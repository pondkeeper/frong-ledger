'use strict';
/* Frong Ledger frontend.
 * Baseline data comes from data/data.json (cron, ~10 min).
 * Live layer (price) fetches client-side from public APIs.
 */

const BS = 'https://robinhoodchain.blockscout.com/api/v2';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const DS = 'https://api.dexscreener.com/latest/dex/tokens';
const TOKEN = '0x6245e67affA44a23077f0Ea7f981a8DC743a0c47';
const SUPPLY = 1e9;
const TIP_ADDR = ''; // anon tip wallet — leave empty to hide the footer link
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const S = {
  data: null, snaps: [], candles: [], cts: [],
  livePrice: null, liveStats: null, launch: 0,
  byAddr: new Map(), sortKey: 'balance', sortDir: -1,
  flowHours: 72, priceFails: 0, mainLog: false,
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

/* ---------------- hero video: respect reduced motion, rescue mobile autoplay ---------------- */
{
  const v = $('camvid');
  if (v && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    v.removeAttribute('autoplay'); v.pause();
  } else if (v) {
    // iOS/Android sometimes block or delay autoplay (low-power mode, data saver):
    // retry when playable and again on the first user gesture.
    const tryPlay = () => { if (v.paused) v.play().catch(() => {}); };
    v.addEventListener('canplay', tryPlay, { once: true });
    ['touchstart', 'pointerdown', 'scroll'].forEach(e =>
      document.addEventListener(e, tryPlay, { once: true, passive: true }));
  }
  const hc = $('hudclock');
  if (hc) {
    const tick = () => { hc.textContent = fmtT(Math.floor(Date.now() / 1000)); };
    tick(); setInterval(tick, 1000);
  }
}

/* ---------------- tabs ---------------- */
const PANES = ['signal', 'scanner', 'diamond', 'flywheel'];
const PANE_ALIAS = { lookup: 'scanner', whales: 'signal' };
function setTab(name, updateHash) {
  name = PANE_ALIAS[name] || name;
  if (!PANES.includes(name)) name = 'signal';
  if (!$('pane-' + name)) return;
  document.querySelectorAll('.tabpane').forEach(p =>
    p.classList.toggle('active', p.id === 'pane-' + name));
  document.querySelectorAll('[data-tab]').forEach(b => {
    const on = b.dataset.tab === name;
    if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', String(on));
  });
  if (updateHash !== false) history.replaceState(null, '', '#' + name);
  if (S.data) {
    if (name === 'signal') renderSignal();
    if (name === 'flywheel') { renderFlywheel(); renderBurn(); }
    if (name === 'scanner') { const i = $('lookupaddr'); if (i) i.focus({ preventScroll: true }); }
  }
}
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-tab]');
  if (!b) return;
  ev.preventDefault();
  setTab(b.dataset.tab);
  if (b.dataset.scroll) {
    const t = $(b.dataset.scroll);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
window.addEventListener('hashchange', () => setTab(location.hash.slice(1), false));
if ($('pane-signal')) setTab(location.hash.slice(1) || 'signal', false);

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
let GID = 0; // unique ids for per-chart svg defs
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
  let yTicks = [], tickDec = 4;
  if (log) {
    for (let e = -6; e <= 2; e++) for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= yMin && v <= yMax) yTicks.push(v);
    }
    if (yTicks.length > 6) yTicks = yTicks.filter((_, i) => i % 2 === 0);
  } else {
    const lo = opts.zeroBase === false ? yMin : Math.min(0, yMin);
    const step = niceStep((yMax - lo) / (opts.yTickN || 4));
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) yTicks.push(v);
    tickDec = Math.max(0, Math.ceil(-Math.log10(step)));
    if (step * Math.pow(10, tickDec) % 1 > 1e-9) tickDec++;
    tickDec = Math.min(6, tickDec);
  }
  const yFmt = opts.yFmt || (log
    ? (v => parseFloat(v.toPrecision(2)).toString())
    : (v => v.toFixed(tickDec)));
  const xTicks = xTickList(x0, x1);
  const gid = ++GID;

  let g = '';
  for (const [t] of xTicks) {
    const x = X(t);
    g += `<line class="gridline" x1="${x.toFixed(1)}" y1="${M.t}" x2="${x.toFixed(1)}" y2="${M.t + ih}"/>`;
  }
  for (const v of yTicks) {
    const y = Y(v);
    g += `<line class="gridline" x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}"/>`
      + `<text class="ticktext" x="${M.l - 8}" y="${y + 3}" text-anchor="end">${yFmt(v)}</text>`;
  }
  if (opts.xTicks !== false)
    for (const [t, lbl] of xTicks)
      g += `<text class="ticktext" x="${X(t)}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
  g += `<line class="axisline" x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}"/>`;

  const cls = opts.lineClass || 'priceline';
  const lineD = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'chart')}">`;
  // no-data region: hatched "NO FEED" zone (tracking hasn't covered this span yet)
  if (opts.noDataBefore && opts.noDataBefore > x0 + (x1 - x0) * 0.04) {
    const nx = X(Math.min(opts.noDataBefore, x1));
    svg += `<defs><pattern id="hp${gid}" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(214,228,200,.09)" stroke-width="2.5"/></pattern></defs>`
      + `<rect x="${M.l}" y="${M.t}" width="${(nx - M.l).toFixed(1)}" height="${ih}" fill="url(#hp${gid})"/>`;
    if (nx - M.l > 150)
      svg += `<text class="nofeed" x="${(M.l + (nx - M.l) / 2).toFixed(1)}" y="${M.t + ih / 2 + 3}" text-anchor="middle">`
        + `NO FEED — TRACKING SINCE ${esc(fmtDT(opts.noDataBefore).toUpperCase())} UTC</text>`;
  }
  svg += g;
  if (opts.area !== false && cls === 'priceline') {
    svg += `<defs><linearGradient id="ag${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>`
      + `<path fill="url(#ag${gid})" d="${lineD}L${X(pts[pts.length - 1][0]).toFixed(1)} ${M.t + ih}L${X(pts[0][0]).toFixed(1)} ${M.t + ih}Z"/>`;
  }
  svg += `<path class="${cls}" d="${lineD}"/>`;
  if (opts.endDot) {
    const lp = pts[pts.length - 1];
    const ex = Math.min(X(lp[0]), W - M.r - 3), ey = Y(lp[1]);
    const ly = Math.max(M.t + 14, ey - 11);
    svg += `<circle class="enddot-halo" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="7"/>`
      + `<circle class="enddot" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5"/>`
      + `<text class="endlbl" x="${(ex - 10).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end">${esc((opts.endFmt || fmtPx)(lp[1]))}</text>`;
  }

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
  const M = { t: 10, r: 14, b: opts.xTicks === false ? 8 : 24, l: 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const x0 = opts.x0 ?? bk[0].ts, x1 = opts.x1 ?? (bk[bk.length - 1].ts + opts.bucketSec);
  const maxPos = Math.max(...bk.map(b => b.val), 0);
  const maxNeg = Math.max(...bk.map(b => -b.val), 0);
  const diverging = opts.diverging !== false && maxNeg > 0;
  const yMax = (Math.max(maxPos, maxNeg) || 1e-9) * 1.12;
  const yMin = diverging ? -Math.max(maxNeg * 1.12, yMax * 0.14) : 0;
  const X = t => M.l + (t - x0) / Math.max(1, x1 - x0) * iw;
  const Y = v => M.t + ih - (v - yMin) / (yMax - yMin) * ih;
  const bw = Math.max(1.5, iw / Math.max(1, (x1 - x0) / opts.bucketSec) - 2);
  const yFmt = opts.yFmt || fmtAmt;
  const gid = ++GID;

  let g = '';
  for (const [t] of xTickList(x0, x1)) {
    const x = X(t);
    g += `<line class="gridline" x1="${x.toFixed(1)}" y1="${M.t}" x2="${x.toFixed(1)}" y2="${M.t + ih}"/>`;
  }
  const step = niceStep((yMax - yMin) / 3);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
    const y = Y(v);
    g += `<line class="gridline" x1="${M.l}" y1="${y}" x2="${W - M.r}" y2="${y}"/>`
      + `<text class="ticktext" x="${M.l - 8}" y="${y + 3}" text-anchor="end">${yFmt(v)}</text>`;
  }
  if (opts.xTicks !== false)
    for (const [t, lbl] of xTickList(x0, x1))
      g += `<text class="ticktext" x="${X(t)}" y="${H - 6}" text-anchor="middle">${lbl}</text>`;
  g += `<line class="zeroline" x1="${M.l}" y1="${Y(0)}" x2="${W - M.r}" y2="${Y(0)}"/>`;

  const defs = `<defs>
    <linearGradient id="gp${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#68e372"/><stop offset="1" stop-color="#0d840d"/></linearGradient>
    <linearGradient id="gn${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a84444"/><stop offset="1" stop-color="#f28f8f"/></linearGradient>
    <linearGradient id="ga${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cdf381"/><stop offset="1" stop-color="#7fae40"/></linearGradient>
  </defs>`;

  let bars = '';
  bk.forEach((b, i) => {
    if (Math.abs(b.val) < 1e-12) return;
    const x = X(b.ts) + 1, y0 = Y(0);
    const pos = b.val >= 0;
    const h = Math.max(2, Math.abs(y0 - Y(b.val)));
    const r = Math.min(3, bw / 2, h / 2);
    const cls = pos || opts.barClass ? 'glow-pos' : 'glow-neg';
    let d;
    if (pos || opts.barClass) {
      const yt = y0 - h;
      d = `M${x.toFixed(1)} ${y0.toFixed(1)}V${(yt + r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${-r}h${(bw - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${r}V${y0.toFixed(1)}Z`;
    } else {
      const yb = y0 + h;
      d = `M${x.toFixed(1)} ${y0.toFixed(1)}V${(yb - r).toFixed(1)}a${r} ${r} 0 0 0 ${r} ${r}h${(bw - 2 * r).toFixed(1)}a${r} ${r} 0 0 0 ${r} ${-r}V${y0.toFixed(1)}Z`;
    }
    bars += `<path class="${cls}" style="fill:url(#${opts.barClass ? 'ga' : pos ? 'gp' : 'gn'}${gid})" d="${d}" data-bi="${i}"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || 'bar chart')}">${defs}${g}${bars}</svg><div class="tip"></div>`;

  const svgEl = host.querySelector('svg'), tip = host.querySelector('.tip');
  svgEl.querySelectorAll('[data-bi]').forEach(r => {
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
function xTickList(x0, x1) {
  const span = x1 - x0;
  const step = span > 86400 * 8 ? 2 * 86400 : span > 86400 * 2.5 ? 86400 : 21600;
  const out = [];
  for (let t = Math.ceil(x0 / step) * step; t < x1; t += step) {
    const d = new Date(t * 1000);
    out.push([t, step < 86400
      ? String(d.getUTCHours()).padStart(2, '0') + ':00'
      : fmtD(t)]);
  }
  return out;
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
  const st = $('stats');
  if (st) st.innerHTML = [
    ['Price · live', fmtPx(px) + (chg != null ? `<span class="delta ${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% 24h</span>` : '')],
    ['FDV', fmtUsd(px * SUPPLY)],
    ['Liquidity · main pool', fmtUsd(ls.liq ?? t.liq_main)],
    ['24h volume', fmtUsd(ls.vol24 ?? t.vol24_all)],
    ['Holders', (ls.holders ?? t.holders_count).toLocaleString('en-US')],
  ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  const lp = $('liveprice');
  if (lp) lp.textContent = 'FRONG ' + fmtPx(px);
}

function mainChartPoints() {
  const pts = S.candles.slice();
  if (S.livePrice) pts.push([Math.floor(Date.now() / 1000), S.livePrice]);
  return pts;
}

/* The Signal: price + whale net flow + holders on one shared time axis */
function renderSignal() {
  if (!$('sigprice')) return;
  const now = Math.floor(Date.now() / 1000);
  const h = S.flowHours, x0 = h ? now - h * 3600 : S.launch, x1 = now;

  const all = mainChartPoints();
  let pts = all.filter(p => p[0] >= x0 - 1800);
  if (pts.length < 2) pts = all.slice(-2);
  drawLine($('sigprice'), { points: pts, height: 240, x0, x1,
    xTicks: false, zeroBase: false, endDot: true, label: 'FRONG price' });
  const cm = $('chartmeta');
  if (cm) cm.textContent = 'whale data updated ' + fmtAgo(S.data.generated_at) + ' · price line is live';

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
  drawBars($('sigflow'), { buckets, bucketSec: B, height: 180, x0, x1,
    label: 'Net whale flow per hour',
    tipFmt: b => `<b>${b.val >= 0 ? '+' : ''}${fmtAmt(b.val)} net</b><br>` +
      `<span class="t2">▲ ${fmtAmt(b.buy)} bought · ▼ ${fmtAmt(b.sell)} sold</span><br>` +
      `<span class="t2">${fmtDT(b.ts)} UTC</span>` });

  setupSigCross();
}

/* one crosshair spanning all three signal panels */
function setupSigCross() {
  const sig = document.querySelector('.sig');
  if (!sig || sig.dataset.cross) return;
  sig.dataset.cross = '1';
  const line = document.createElement('div');
  line.className = 'sigcross';
  sig.appendChild(line);
  sig.addEventListener('mousemove', ev => {
    const svg = sig.querySelector('svg');
    if (!svg) return;
    const r = sig.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    const vw = svg.viewBox.baseVal.width || sr.width;
    const scale = sr.width / vw;
    const left = sr.left - r.left + 56 * scale;
    const right = sr.left - r.left + sr.width - 14 * scale;
    const x = ev.clientX - r.left;
    if (x < left || x > right) { line.style.display = 'none'; return; }
    line.style.left = x + 'px';
    line.style.display = 'block';
  });
  sig.addEventListener('mouseleave', () => { line.style.display = 'none'; });
}

function renderAggr() {
  if (!$('aggr')) return;
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

function renderVerdict() {
  const el = $('verdict');
  if (!el) return;
  const px = S.livePrice || S.data.token.price;
  const now = Math.floor(Date.now() / 1000), x0 = now - 86400;
  let net = 0, buyers = 0, sellers = 0;
  for (const w of S.data.wallets) {
    if (!w.in_top) continue;
    let n = 0;
    for (const t of w.txs) if (t.ts >= x0) n += isIn(t, w.addr) ? t.amount : -t.amount;
    net += n;
    if (n > 50000) buyers++; else if (n < -50000) sellers++;
  }
  const thr = SUPPLY * 0.0002;
  const [head, cls] =
    net > thr ? ['▲ WHALES ARE ACCUMULATING', 'up'] :
    net < -thr ? ['▼ WHALES ARE DISTRIBUTING', 'dn'] :
    ['● WHALES ARE HOLDING', 'mid'];
  el.className = 'verdict ' + cls;
  el.innerHTML = `<span class="vmain">${head}</span>
    <span class="vsub">${net >= 0 ? '+' : ''}${fmtAmt(net)} FRONG net in 24h (≈${fmtUsd(Math.abs(net) * px)})
      · ${buyers} buying vs ${sellers} selling
      · <a href="#signal" data-tab="signal" data-scroll="signal">see the tape ↓</a></span>`;
}

function renderMovers() {
  const host = $('movers');
  if (!host) return;
  const mv = ((S.data.stats && S.data.stats.movers) || []).slice()
    .sort((a, b) => Math.abs(b.net24) - Math.abs(a.net24)).slice(0, 6);
  if (!mv.length) {
    host.innerHTML = '<p class="cardsub">No large whale moves in the last 24h — quiet pond.</p>';
    return;
  }
  const max = Math.max(...mv.map(m => Math.abs(m.net24)), 1);
  host.innerHTML = '<div class="mvlist">' + mv.map(m => {
    const pos = m.net24 >= 0;
    const r = S.byAddr.get(m.addr.toLowerCase());
    const w = Math.max(3, Math.abs(m.net24) / max * 100);
    return `<div class="mvitem">
      <div class="mvrow">
        <span class="mvside ${pos ? 'b' : 's'}">${pos ? '▲' : '▼'}</span>
        <div class="mvwho">
          <a class="mvaddr" href="ledger.html" title="open the ledger">${short(m.addr)}</a>
          <span class="mvtags">${r ? `whale #${r.rank}` : 'whale'}${m.cohort === 'day_one' || m.cohort === 'sniper' ? ' · day one og' : ''}
            · <a href="${EXPLORER}/address/${m.addr}" target="_blank" rel="noopener">explorer ↗</a></span>
        </div>
        <div class="mvdata">
          <span class="mvamt ${pos ? 'pnl-pos' : 'pnl-neg'}">${pos ? '+' : '−'}${fmtAmt(Math.abs(m.net24))} FRONG</span>
          <span class="mvusd">≈ ${fmtUsd(Math.abs(m.usd24))}</span>
        </div>
      </div>
      <div class="mvbar"><i class="${pos ? 'pos' : 'neg'}" style="width:${w.toFixed(1)}%"></i></div>
    </div>`;
  }).join('') + '</div>';
}

function renderTable() {
  if (!$('tbody')) return;
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

function topDiamond() {
  const px = S.livePrice || S.data.token.price;
  const day1 = S.data.wallets.filter(w => w.in_top && w.first_ts && w.first_ts - S.launch < 86400 && w.avg_entry);
  day1.forEach(w => { w._mult = px / w.avg_entry; });
  return day1.sort((a, b) => b._mult - a._mult);
}

function renderApex() {
  const host = $('apexbody');
  if (!host) return;
  const px = S.livePrice || S.data.token.price;
  const day1 = topDiamond();
  const card = host.closest('.card');
  if (!day1.length) { if (card) card.style.display = 'none'; return; }
  if (card) card.style.display = '';
  const w = day1[0];
  const bought = w.txs.filter(t => isIn(t, w.addr)).reduce((s, t) => s + t.amount, 0);
  const held = bought > 0 ? Math.min(100, w.balance / bought * 100) : 0;
  const never = w.sell_usd < 1;
  const days = Math.max(1, Math.floor((Date.now() / 1000 - w.first_ts) / 86400));
  host.innerHTML = `
    <div class="axrank">SPECIMEN 01 · APEX</div>
    <div class="axaddr"><a href="${EXPLORER}/address/${w.addr}" target="_blank" rel="noopener">${short(w.addr)}</a>
      ${never ? '<span class="badge og">never sold</span>' : ''}</div>
    <div class="axmult">×${w._mult >= 100 ? w._mult.toFixed(0) : w._mult.toFixed(1)}</div>
    <div class="axline">bought day one at ${fmtPx(w.avg_entry)} —
      ${never ? 'has never sold a single FRONG' : 'still holding ' + held.toFixed(0) + '% of every buy'}</div>
    <div class="heldbar"><i style="width:${held.toFixed(0)}%"></i></div>
    <div class="axrows">
      <div class="drow"><span>position now</span><b>${fmtUsd(w.balance * px)}</b></div>
      <div class="drow"><span>in the pond</span><b>${days} days</b></div>
    </div>
    <button class="btn axbtn" data-tab="diamond">meet all the diamond hands →</button>`;
}

function renderDiamond() {
  if (!$('dgrid')) return;
  const px = S.livePrice || S.data.token.price;
  const top = topDiamond().slice(0, 6);
  $('dgrid').innerHTML = top.map((w, i) => {
    const bought = w.txs.filter(t => isIn(t, w.addr)).reduce((s, t) => s + t.amount, 0);
    const held = bought > 0 ? Math.min(100, w.balance / bought * 100) : 0;
    const never = w.sell_usd < 1;
    const days = Math.max(1, Math.floor((Date.now() / 1000 - w.first_ts) / 86400));
    return `<div class="dcard${i === 0 ? ' apex' : ''}">
      <span class="dbr b1"></span><span class="dbr b2"></span>
      <span class="dbr b3"></span><span class="dbr b4"></span>
      <div class="dtop"><span class="drank">SPECIMEN ${String(i + 1).padStart(2, '0')}</span>
        <span class="dsince">in the pond ${days}d</span></div>
      <div class="daddr"><a href="${EXPLORER}/address/${w.addr}" target="_blank" rel="noopener">${short(w.addr)}</a>
        ${never ? '<span class="badge og">never sold</span>' : ''}
        ${i === 0 ? '<span class="badge apexbadge">apex</span>' : ''}</div>
      <div class="dmult">×${w._mult >= 100 ? w._mult.toFixed(0) : w._mult.toFixed(1)}</div>
      <div class="dsub">entered ${fmtPx(w.avg_entry)} · now ${fmtPx(px)}</div>
      <div class="heldbar"><i style="width:${held.toFixed(0)}%"></i></div>
      <div class="drow"><span>still holding</span><b>${held.toFixed(0)}% of all buys</b></div>
      <div class="drow"><span>position</span><b>${fmtUsd(w.balance * px)}</b></div>
      <div class="drow"><span>first entry</span><b>${fmtDT(w.first_ts)} UTC</b></div>
    </div>`;
  }).join('') || '<p class="cardsub">No day-one wallets in the top 50 right now.</p>';
}

function renderFlywheel() {
  if (!$('fwtiles')) return;
  const hv = (S.data.harvests || []).slice().sort((a, b) => a.ts - b.ts);
  const px = S.livePrice || S.data.token.price;
  const tot = hv.reduce((s, h) => s + h.frong, 0);
  const last = hv.length ? hv[hv.length - 1].ts : null;
  $('fwtiles').innerHTML = [
    ['Locked so far', fmtAmt(tot) + `<span class="delta">${(tot / SUPPLY * 100).toFixed(1)}% of supply</span>`],
    ['Worth right now', fmtUsd(tot * px)],
    ['Harvests', String(hv.length)],
    ['Last harvest', last ? fmtAgo(last) : '—'],
  ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  if (!hv.length) { $('fwchart').innerHTML = ''; return; }
  let cum = 0;
  const pts = hv.map(h => (cum += h.frong, [h.ts, cum]));
  pts.push([Math.floor(Date.now() / 1000), cum]);
  if (pts.length >= 2)
    drawLine($('fwchart'), { points: pts, height: 200,
      yFmt: fmtAmt, endDot: true, endFmt: v => fmtAmt(v) + ' FRONG',
      yTipFmt: v => fmtAmt(v) + ' FRONG locked forever',
      label: 'Cumulative FRONG locked into the pool' });
}

function renderBurn() {
  if (!$('burntiles')) return;
  const bv = (S.data.burns || []).slice().sort((a, b) => a.ts - b.ts);
  const px = S.livePrice || S.data.token.price;
  const tot = bv.reduce((s, b) => s + b.frong, 0);
  const machine = bv.filter(b => b.machine).length;
  const last = bv.length ? bv[bv.length - 1].ts : null;
  $('burntiles').innerHTML = [
    ['Burned so far', fmtAmt(tot) + `<span class="delta">${(tot / SUPPLY * 100).toFixed(2)}% of supply</span>`],
    ['Worth right now', fmtUsd(tot * px)],
    ['Burns', String(bv.length) + (machine ? `<span class="delta">${machine} by the machine</span>` : '')],
    ['Last burn', last ? fmtAgo(last) : '—'],
  ].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('');
  if (!bv.length) { $('burnchart').innerHTML = ''; return; }
  let cum = 0;
  const pts = bv.map(b => (cum += b.frong, [b.ts, cum]));
  pts.push([Math.floor(Date.now() / 1000), cum]);
  if (pts.length >= 2)
    drawLine($('burnchart'), { points: pts, height: 200,
      yFmt: fmtAmt, endDot: true, endFmt: v => fmtAmt(v) + ' FRONG',
      yTipFmt: v => fmtAmt(v) + ' FRONG burned forever',
      label: 'Cumulative FRONG burned' });
}

function renderInfra() {
  if (!$('infra')) return;
  $('infra').innerHTML = (S.data.contracts_top || []).map(c => {
    const nm = c.name ? esc(c.name) : short(c.addr);
    return `<span title="${esc(c.addr)}"><a href="${EXPLORER}/address/${c.addr}" target="_blank" rel="noopener">${nm}</a> ${fmtAmt(c.balance)} (${(c.balance / SUPPLY * 100).toFixed(2)}%)</span>`;
  }).join('');
}

function renderCharts() { renderSignal(); renderFlywheel(); renderBurn(); }

/* live-price refresh of computed cells without rebuilding the table */
function refreshLiveCells() {
  S.data.wallets.forEach(liveCalc);
  renderStats(); renderAggr(); renderVerdict(); renderMovers();
  if (!$('tbody')) return;
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
    refreshLiveCells(); renderSignal(); renderDiamond(); renderApex();
  } catch (e) {
    if (++S.priceFails > 2) { $('livedot').classList.add('stale'); $('livedot').classList.remove('on'); }
  }
}

/* ---------------- lookup ---------------- */
/* An address with no FRONG history can still show up as the "maker" of big
   FRONG trades on DEX trackers: every Robinhood in-app trade is submitted
   on-chain by an ERC-4337 relayer (bundler), so trackers attribute the trade
   to the relayer instead of the actual wallet. Identify those on lookup. */
/* Blockscout intermittently returns 500s on address endpoints — retry a couple
   of times before falling back, or bundlers would randomly classify as unknown. */
async function bsJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const d = await (await fetch(url)).json();
      if (d && typeof d === 'object') return d;
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 700));
  }
  return null;
}

async function classifyEmpty(addr) {
  const fallback = 'No FRONG history found for this wallet.';
  const a = await bsJson(`${BS}/addresses/${addr}`);
  if (a && a.proxy_type === 'eip7702')
    return 'This is a Robinhood app wallet (EIP-7702 smart account) — no FRONG history yet.';
  const d = await bsJson(`${BS}/addresses/${addr}/transactions`);
  const items = (d && d.items) || [];
  const ops = items.filter(t => t.method === 'handleOps' &&
    t.from && t.from.hash && t.from.hash.toLowerCase() === addr.toLowerCase()).length;
  if (ops >= 3 && ops >= items.length / 2)
    return 'This address is a transaction relayer (ERC-4337 bundler), not a trader. ' +
      'It submits other wallets’ trades, so DEX trackers list it as the “maker” — ' +
      'but it never holds or trades FRONG itself.';
  if (a && a.is_contract === true) return 'Smart contract — no FRONG history.';
  return fallback;
}

async function lookup(raw) {
  raw = (raw || '').trim();
  const msg = $('lookupmsg'), out = $('lookupresult');
  out.innerHTML = '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) { msg.textContent = 'That doesn’t look like an address — expected 0x followed by 40 hex characters.'; return; }
  const btn = $('lookupbtn'); if (btn) btn.disabled = true;
  const tracked = S.byAddr.get(raw.toLowerCase());
  try {
    let w;
    if (tracked) {
      w = tracked.w;
      msg.textContent = `Tracked whale — rank #${tracked.rank} by balance.` +
        (w.aa ? ' Robinhood app wallet (EIP-7702).' : '');
    }
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
      if (!txs.length) {
        msg.textContent = 'No FRONG history — identifying the address…';
        msg.textContent = await classifyEmpty(raw);
        if (btn) btn.disabled = false; return;
      }
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
      const ainfo = await bsJson(`${BS}/addresses/${raw}`, 2);
      const aaNote = (ainfo && ainfo.proxy_type === 'eip7702') ? 'Robinhood app wallet (EIP-7702). ' : '';
      msg.textContent = aaNote + (truncated ? 'Showing the most recent 400 transfers — older history omitted, so cost basis is approximate.' : '');
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
  if (btn) btn.disabled = false;
}
if ($('lookupbtn')) {
  $('lookupbtn').addEventListener('click', () => lookup($('lookupaddr').value));
  $('lookupaddr').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') lookup($('lookupaddr').value);
  });
}

/* ---------------- controls ---------------- */
if ($('flowrange'))
  $('flowrange').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    S.flowHours = +b.dataset.h;
    $('flowrange').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    renderSignal();
  }));

/* ---------------- boot ---------------- */
async function boot() {
  const cb = Math.floor(Date.now() / 300000); // 5-min bucket busts the Pages CDN cache
  const [dr, sr] = await Promise.all([
    fetch('data/data.json?t=' + cb), fetch('data/snapshots.jsonl?t=' + cb),
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

  renderStats(); renderVerdict(); renderSignal(); renderMovers(); renderApex();
  renderAggr(); renderTable(); renderDiamond(); renderFlywheel(); renderBurn(); renderInfra();
  $('gen').textContent = 'baseline refreshed ' + fmtAgo(S.data.generated_at);

  if (TIP_ADDR && $('tipline')) {
    $('tipline').hidden = false;
    const tl = $('tiplink');
    tl.href = EXPLORER + '/address/' + TIP_ADDR;
    tl.title = TIP_ADDR;
    tl.addEventListener('click', ev => {
      ev.preventDefault();
      navigator.clipboard?.writeText(TIP_ADDR);
      tl.textContent = 'address copied 🐸';
      setTimeout(() => { tl.textContent = 'tip the pondkeeper'; }, 1600);
    });
  }

  pollPrice();
  setInterval(pollPrice, 30000);
  setInterval(() => { $('gen').textContent = 'baseline refreshed ' + fmtAgo(S.data.generated_at); }, 30000);
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderCharts, 200); });

  const bt = $('boot');
  if (bt) { bt.style.opacity = '0'; setTimeout(() => bt.remove(), 350); }
}
boot().catch(e => {
  const bb = document.querySelector('#boot .bootbox');
  if (bb) bb.innerHTML = 'SIGNAL LOST — <a href="javascript:location.reload()">retry</a>';
  console.error(e);
});
