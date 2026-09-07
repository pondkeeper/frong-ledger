/* ===========================================================================
   THE BRANCH OFFICES — the referral card, and the winner card.

   The card is the ad: it is what a player posts on X, so it carries the
   pot, the bell, the branch's mark, the player's face, their code and a QR
   of their link. Drawn on a canvas in the browser at 1200×628 (X's large
   image box), pixel-art on the site's own palette, every string kept at a
   size that survives the timeline's half-scale render. It travels INSIDE the
   post — the share sheet on phones, the clipboard on desktop, a download as
   the last fallback — while the post text carries the link, so the sender
   gets their 5%.

   Generic: takes { branch, house, symbol, pot, bell, date, code, link,
   handle, mark, inToday } and draws any branch, not only $9TO5. The mark is
   drawn through window.__BRANCHES.drawMark when the building is loaded
   (same image as the counters), else a pixel coin with the symbol's first
   two letters. The QR comes from qr.js (window.__QR); without it the stub
   simply has no QR.

   Registers window.__POOL_CARD = { open, drawCard, drawWinner, pixelPfp }.
   pool.js calls it guarded. drawWinner(canvas, d) is exported for the
   keeper / the building to draw the daily result card.
   =========================================================================== */
(function () {
  "use strict";
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const W = 1200, H = 628;
  const FD = "'Press Start 2P', monospace", FB = "'VT323', ui-monospace, monospace";
  const C = { ink: "#06080c", rim: "#3a4148", crt: "#06110b", crt2: "#0b1a11", green: "#67b184", bright: "#b6ffcf", gold: "#ffc933", goldDeep: "#8a6d35", cream: "#fff3dc", grey: "#c6d1da", dim: "#8fa0b0", white: "#ffffff" };

  /// unavatar sends CORS (verified for the application card); null → silhouette
  function loadPfp(handle) {
    if (!handle) return Promise.resolve(null);
    return new Promise((res) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const t = setTimeout(() => res(null), 3000); // slow avatar: the silhouette, silently
      img.onload = () => { clearTimeout(t); res(img); };
      img.onerror = () => { clearTimeout(t); res(null); };
      img.src = "https://unavatar.io/x/" + encodeURIComponent(handle) + "?fallback=false";
    });
  }
  function loadImg(src) {
    if (!src) return Promise.resolve(null);
    return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }

  /// the player's picture as pixel art: down to a 64-cell grid, then up 4×
  /// with no smoothing, so any photo sits on the card like a sprite
  function pixelPfp(img, cells) {
    // the collection's own busts are 48 cells at 10px: keep their grid exact; a photo gets 64
    const nw = img.naturalWidth || img.width;
    cells = cells || (nw % 48 === 0 && nw <= 960 ? 48 : 64);
    const small = document.createElement("canvas"); small.width = small.height = cells;
    const sx = small.getContext("2d");
    sx.imageSmoothingEnabled = true; sx.imageSmoothingQuality = "high";
    const s = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const ox = ((img.naturalWidth || img.width) - s) / 2, oy = ((img.naturalHeight || img.height) - s) / 2;
    sx.drawImage(img, ox, oy, s, s, 0, 0, cells, cells);
    return small;
  }

  // ---------------------------------------------------------------- pieces
  /// text at the largest size in [from, to] that fits `max`; returns the size used
  function fit(x, text, px, py, opt) {
    const { font = FD, color = C.cream, max = 700, from = 24, to = 12, align = "left" } = opt || {};
    x.textAlign = align; x.textBaseline = "alphabetic"; x.fillStyle = color;
    let size = from;
    for (; size > to; size -= 2) { x.font = size + "px " + font; if (x.measureText(text).width <= max) break; }
    x.font = size + "px " + font;
    x.fillText(text, px, py);
    return size;
  }
  /// a pixel frame: ink border, gold corner studs
  function frame(x, px, py, w, h, gold) {
    x.fillStyle = gold ? C.goldDeep : C.rim; x.fillRect(px - 14, py - 14, w + 28, h + 28);
    x.fillStyle = C.ink; x.fillRect(px - 6, py - 6, w + 12, h + 12);
    if (gold) { x.fillStyle = C.gold; for (const [cx, cy] of [[px - 14, py - 14], [px + w + 2, py - 14], [px - 14, py + h + 2], [px + w + 2, py + h + 2]]) x.fillRect(cx, cy, 12, 12); }
  }
  function silhouette(x, px, py, s) {
    x.fillStyle = "#0f2418"; x.fillRect(px, py, s, s);
    x.fillStyle = "#2f6b47";
    const u = s / 64; // the same shape at any size, on a 64-cell grid
    x.fillRect(px + 22 * u, py + 12 * u, 20 * u, 20 * u);           // head
    x.fillRect(px + 12 * u, py + 36 * u, 40 * u, 28 * u);           // shoulders
    x.fillStyle = "#1c4a2e"; x.fillRect(px + 29 * u, py + 36 * u, 6 * u, 12 * u); // the tie
  }
  /// the branch's mark: the building's drawMark when loaded, else a pixel coin
  function drawMark(x, d, px, py, size) {
    x.imageSmoothingEnabled = false;
    if (window.__BRANCHES && window.__BRANCHES.drawMark && d.branchObj) { try { window.__BRANCHES.drawMark(x, d.branchObj, px, py, size); return; } catch (e) { /* the coin */ } }
    if (d.markImg) { x.drawImage(d.markImg, px, py, size, size); return; }
    // the coin: a gold disc on a 12-cell grid, ink rim, two letters
    const u = size / 12;
    const rows = [[3, 6], [2, 8], [1, 10], [1, 10], [0, 12], [0, 12], [0, 12], [0, 12], [1, 10], [1, 10], [2, 8], [3, 6]];
    rows.forEach(([o, n], r) => { x.fillStyle = C.ink; x.fillRect(px + o * u, py + r * u, n * u, u); });
    rows.forEach(([o, n], r) => { if (r > 0 && r < 11) { x.fillStyle = r < 6 ? C.gold : "#e0ac2b"; x.fillRect(px + (o + 1) * u, py + r * u, (n - 2) * u, u); } });
    const letters = String(d.symbol || "??").replace(/^\$/, "").slice(0, 2).toUpperCase();
    x.fillStyle = C.ink; x.textAlign = "center"; x.textBaseline = "middle"; x.font = Math.round(size / 3.2) + "px " + FD;
    x.fillText(letters, px + size / 2, py + size / 2 + u / 2);
    x.textBaseline = "alphabetic";
  }
  /// the QR of the link, white quiet zone, integer modules
  function drawQr(x, text, px, py, box) {
    if (!window.__QR) return false;
    let q; try { q = window.__QR.encode(text); } catch (e) { return false; }
    const quiet = 2;
    const mod = Math.floor(box / (q.size + quiet * 2));
    const side = mod * (q.size + quiet * 2);
    const ox = px + Math.floor((box - side) / 2), oy = py + Math.floor((box - side) / 2);
    x.fillStyle = C.white; x.fillRect(ox, oy, side, side);
    x.fillStyle = C.ink;
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) if (q.get(r, c)) x.fillRect(ox + (c + quiet) * mod, oy + (r + quiet) * mod, mod, mod);
    return true;
  }
  function backdrop(x) {
    x.fillStyle = C.crt; x.fillRect(0, 0, W, H);
    // a faint grid, the pool page's wall
    x.fillStyle = "rgba(255,255,255,0.025)";
    for (let gx = 24; gx < W; gx += 24) x.fillRect(gx, 0, 1, H);
    for (let gy = 24; gy < H; gy += 24) x.fillRect(0, gy, W, 1);
    x.fillStyle = C.ink; x.fillRect(0, 0, W, 16); x.fillRect(0, H - 16, W, 16); x.fillRect(0, 0, 16, H); x.fillRect(W - 16, 0, 16, H);
    x.fillStyle = C.rim; x.fillRect(20, 20, W - 40, 4); x.fillRect(20, H - 24, W - 40, 4); x.fillRect(20, 20, 4, H - 40); x.fillRect(W - 24, 20, 4, H - 40);
  }
  function scanlines(x) {
    x.fillStyle = "rgba(0,0,0,0.12)";
    for (let sy = 26; sy < H - 26; sy += 4) x.fillRect(26, sy, W - 52, 2);
  }
  /// a pixel bell, 9 cells wide, `u` px a cell
  function bell(x, px, py, u, color) {
    const rows = ["....#....", "...###...", "..#####..", "..#####..", "..#####..", "..#####..", ".#######.", "#########", "....#...."];
    x.fillStyle = color;
    rows.forEach((row, r) => { for (let c = 0; c < 9; c++) if (row[c] === "#") x.fillRect(px + c * u, py + r * u, u, u); });
  }
  /// the header: the mark, the branch, the house; the date and the bell at the right
  function header(x, d) {
    drawMark(x, d, 48, 44, 96);
    fit(x, String(d.branch || "THE OFFICE POOL").toUpperCase(), 168, 84, { color: C.gold, from: 26, to: 16, max: 700 });
    fit(x, words(d).subtitle.replace("{sym}", d.symbol || "$9TO5"), 168, 122, { font: FB, color: C.green, from: 28, to: 24, max: 900 });
    bell(x, 1114, 48, 4, C.gold);
    fit(x, String(d.date || "").toUpperCase(), 1098, 66, { color: C.grey, from: 16, to: 16, max: 220, align: "right" });
    fit(x, `BELL ${d.bell || "4:00 PM"} NY`, 1098, 92, { color: C.gold, from: 16, to: 16, max: 220, align: "right" });
  }
  /// the left column: the face in its frame, the handle, one line under it
  function face(x, d, line) {
    const PX = 48, PY = 168, PS = 256;
    frame(x, PX, PY, PS, PS, true);
    if (d.pfp) { x.imageSmoothingEnabled = false; x.drawImage(pixelPfp(d.pfp), PX, PY, PS, PS); }
    else silhouette(x, PX, PY, PS);
    // the handle when there is one (the code is on the stub, once); the state line alone otherwise
    if (d.handle) {
      fit(x, "@" + d.handle, PX + PS / 2, PY + PS + 52, { color: C.cream, from: 22, to: 16, max: PS + 24, align: "center" });
      fit(x, line, PX + PS / 2, PY + PS + 88, { font: FB, color: C.green, from: 26, to: 20, max: PS + 40, align: "center" });
    } else fit(x, line.toUpperCase(), PX + PS / 2, PY + PS + 52, { color: C.green, from: 20, to: 16, max: PS + 24, align: "center" });
    fit(x, `a ${d.house || "FIRM BROKERS"} branch`, PX + PS / 2, PY + PS + 134, { font: FB, color: C.dim, from: 26, to: 20, max: PS + 40, align: "center" });
  }

  // ---------------------------------------------------------------- the cards
  /// d: { branch, house, symbol, pot, bell, date, code, link, handle, pfp, inToday, hero: "pot"|"code" }
  const WORDS = { pot: "pot", potLabel: "TODAY'S POT", subtitle: "one pot a day in {sym} · drawn by drand, checked on-chain", take: "one takes the pot · one gets their money back", before: "chip in before the {bell} New York bell", in: "is in today's pool", plays: "plays the pool", type: "type the code at your first chip-in, open the link", chipIn: "chip-in", tomorrow: "tomorrow's pot is open" };
  const words = (d) => Object.assign({}, WORDS, d.words || {});
  function drawCard(canvas, d) {
    canvas.width = W; canvas.height = H;
    const x = canvas.getContext("2d");
    const hero = d.hero === "code" ? "code" : "pot";
    const wd = words(d);
    backdrop(x); header(x, d);
    face(x, d, d.inToday ? wd.in : wd.plays);
    const RX = 352, RW = 1150 - RX;
    const sizes = {};
    if (hero === "pot") {
      fit(x, wd.potLabel, RX, 172, { color: C.green, from: 18, to: 16, max: RW });
      // the social proof, right-aligned under the bell: who is in, what was paid
      const n = Number(d.players || 0);
      fit(x, n > 0 ? `${n} in today` : "be the first in today", 1150, 176, { font: FB, color: C.cream, from: 30, to: 24, max: 300, align: "right" });
      if (d.lastPaid) fit(x, `last bell ${d.lastPaid} ${d.symbol || "$9TO5"} paid`, 1150, 210, { font: FB, color: C.green, from: 30, to: 24, max: 300, align: "right" });
      x.save(); x.shadowColor = C.bright; x.shadowBlur = 28;
      sizes.pot = fit(x, String(d.pot), RX - 4, 278, { color: C.bright, from: 84, to: 48, max: 560 });
      x.restore();
      x.font = sizes.pot + "px " + FD;
      const potW = x.measureText(String(d.pot)).width;
      fit(x, d.symbol || "$9TO5", RX + potW + 24, 278, { color: C.green, from: 30, to: 18, max: RW - potW - 24 });
      fit(x, wd.take, RX, 318, { font: FB, color: C.cream, from: 32, to: 24, max: RW });
      fit(x, wd.before.replace("{bell}", d.bell || "4:00 PM"), RX, 352, { font: FB, color: C.grey, from: 32, to: 24, max: RW });
      // the stub: the code and the QR
      const SY = 384, SH = 200;
      x.fillStyle = C.crt2; x.fillRect(RX, SY, RW, SH);
      x.fillStyle = C.goldDeep; x.fillRect(RX, SY, RW, 4); x.fillRect(RX, SY + SH - 4, RW, 4);
      for (let dx = RX + 8; dx < RX + RW; dx += 16) { x.fillStyle = C.goldDeep; x.fillRect(dx, SY + 10, 8, 2); x.fillRect(dx, SY + SH - 12, 8, 2); }
      const hasQr = drawQr(x, d.link, 960, SY + 10, 180);
      const TW = hasQr ? 960 - RX - 24 : RW - 32;
      fit(x, "SENT BY", RX + 16, SY + 40, { color: C.green, from: 16, to: 16, max: TW });
      x.save(); x.shadowColor = C.gold; x.shadowBlur = 18;
      sizes.code = fit(x, String(d.code), RX + 16, SY + 108, { color: C.gold, from: 56, to: 28, max: TW });
      x.restore();
      fit(x, String(d.link).replace(/^https?:\/\//, ""), RX + 16, SY + 148, { font: FB, color: C.cream, from: 30, to: 22, max: TW });
      fit(x, `${wd.type}${hasQr ? ", or scan" : ""}`, RX + 16, SY + 182, { font: FB, color: C.grey, from: 26, to: 20, max: TW });
    } else {
      fit(x, "SENT BY · TYPE THIS CODE AT YOUR FIRST CHIP-IN", RX, 172, { color: C.green, from: 18, to: 16, max: RW });
      x.save(); x.shadowColor = C.gold; x.shadowBlur = 28;
      sizes.code = fit(x, String(d.code), RX - 4, 278, { color: C.gold, from: 84, to: 40, max: RW });
      x.restore();
      fit(x, String(d.link).replace(/^https?:\/\//, ""), RX, 318, { font: FB, color: C.cream, from: 32, to: 24, max: RW });
      fit(x, `TODAY'S POT${d.date ? " · " + String(d.date).toUpperCase() : ""}`, RX, 372, { color: C.green, from: 18, to: 14, max: RW });
      const SY = 384, SH = 200;
      x.fillStyle = C.crt2; x.fillRect(RX, SY, RW, SH);
      x.fillStyle = C.goldDeep; x.fillRect(RX, SY, RW, 4); x.fillRect(RX, SY + SH - 4, RW, 4);
      const hasQr = drawQr(x, d.link, 960, SY + 10, 180);
      const TW = hasQr ? 960 - RX - 24 : RW - 32;
      x.save(); x.shadowColor = C.bright; x.shadowBlur = 24;
      sizes.pot = fit(x, `${d.pot} ${d.symbol || "$9TO5"}`, RX + 16, SY + 84, { color: C.bright, from: 56, to: 32, max: TW });
      x.restore();
      fit(x, "one takes the pot · one gets their money back", RX + 16, SY + 128, { font: FB, color: C.cream, from: 30, to: 22, max: TW });
      fit(x, `chip in before the ${d.bell || "4:00 PM"} New York bell${hasQr ? " · scan to play" : ""}`, RX + 16, SY + 164, { font: FB, color: C.grey, from: 30, to: 22, max: TW });
    }
    scanlines(x);
    return sizes;
  }

  /// the result card, after the bell: { branch, house, symbol, pot, date, bell, winner, winnerCode, refundWinner, refundPaid, beaconRound, link, players }
  function drawWinner(canvas, d) {
    canvas.width = W; canvas.height = H;
    const x = canvas.getContext("2d");
    backdrop(x); header(x, d);
    // the mark, big, where the face goes on the referral card
    const PX = 48, PY = 168, PS = 256;
    frame(x, PX, PY, PS, PS, true);
    x.fillStyle = C.crt2; x.fillRect(PX, PY, PS, PS);
    drawMark(x, d, PX + 32, PY + 32, 192);
    fit(x, "THE BELL RANG", PX + PS / 2, PY + PS + 52, { color: C.gold, from: 20, to: 16, max: PS + 24, align: "center" });
    fit(x, `${d.date || ""} · ${d.bell || "4:00 PM"} New York`, PX + PS / 2, PY + PS + 88, { font: FB, color: C.green, from: 26, to: 20, max: PS + 40, align: "center" });
    fit(x, `a ${d.house || "FIRM BROKERS"} branch`, PX + PS / 2, PY + PS + 134, { font: FB, color: C.dim, from: 26, to: 20, max: PS + 40, align: "center" });
    const RX = 352, RW = 1150 - RX;
    fit(x, `THE POT${d.players ? " · " + d.players + " PLAYERS" : ""}`, RX, 172, { color: C.green, from: 18, to: 16, max: RW });
    x.save(); x.shadowColor = C.bright; x.shadowBlur = 28;
    const ps = fit(x, String(d.pot), RX - 4, 278, { color: C.bright, from: 84, to: 48, max: 560 });
    x.restore();
    x.font = ps + "px " + FD;
    const potW = x.measureText(String(d.pot)).width;
    fit(x, d.symbol || "$9TO5", RX + potW + 24, 278, { color: C.green, from: 30, to: 18, max: RW - potW - 24 });
    const who = (a, code) => (code ? code : a ? String(a).slice(0, 6) + "…" + String(a).slice(-4) : "—");
    fit(x, "goes to", RX, 336, { font: FB, color: C.grey, from: 30, to: 22, max: 200 });
    x.save(); x.shadowColor = C.gold; x.shadowBlur = 18;
    fit(x, who(d.winner, d.winnerCode), RX + 110, 340, { color: C.gold, from: 40, to: 20, max: RW - 110 });
    x.restore();
    const SY = 384, SH = 200;
    x.fillStyle = C.crt2; x.fillRect(RX, SY, RW, SH);
    x.fillStyle = C.goldDeep; x.fillRect(RX, SY, RW, 4); x.fillRect(RX, SY + SH - 4, RW, 4);
    const hasQr = drawQr(x, d.link, 960, SY + 10, 180);
    const TW = hasQr ? 960 - RX - 24 : RW - 32;
    fit(x, "MONEY BACK", RX + 16, SY + 44, { color: C.green, from: 16, to: 12, max: TW });
    fit(x, `${d.refundPaid || "—"} ${d.symbol || "$9TO5"} to ${who(d.refundWinner, d.refundCode)}`, RX + 16, SY + 84, { font: FB, color: C.cream, from: 32, to: 22, max: TW });
    fit(x, `drand beacon #${d.beaconRound || "—"} · checked by the contract itself`, RX + 16, SY + 128, { font: FB, color: C.grey, from: 28, to: 20, max: TW });
    fit(x, words(d).tomorrow + (hasQr ? " · scan to play" : ""), RX + 16, SY + 168, { font: FB, color: C.gold, from: 30, to: 22, max: TW });
    scanlines(x);
  }

  // ---------------------------------------------------------------- the modal
  let modal = null, state = null;
  function close() { if (modal) modal.remove(); modal = null; document.removeEventListener("keydown", onKey); }
  function onKey(e) { if (e.key === "Escape") close(); }

  /// a tainted canvas (an avatar without CORS) throws on export: draw again without it
  const cardBlob = () => new Promise((res) => {
    const cv = document.createElement("canvas");
    const draw = state.kind === "winner" ? drawWinner : drawCard;
    draw(cv, state);
    try { cv.toBlob(res, "image/png"); }
    catch (e) { state.pfp = null; draw(cv, state); try { cv.toBlob(res, "image/png"); } catch (e2) { res(null); } }
  });
  /// a PHONE (or tablet), not merely a touch screen: a Windows laptop with a
  /// touch screen reports maxTouchPoints 10 and has navigator.share, and its
  /// share sheet lists Mail and friends — a tester got "email options" instead
  /// of X. Phones say so in the UA; iPadOS hides as a Mac but has a coarse
  /// pointer with no hover, which a mouse-driven laptop never has.
  const mq = (q) => { try { return window.matchMedia(q).matches; } catch (e) { return false; } };
  const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && mq("(pointer: coarse)") && mq("(hover: none)"));
  const isTouch = isPhone;
  const fonts = () => Promise.all([document.fonts.load("20px 'Press Start 2P'"), document.fonts.load("20px 'VT323'")]).catch(() => {});

  /// d: { branch, house, symbol, slug, mark (url), branchObj, code, link, pot (formatted), bell ("4:00 PM"), date, inToday, postText }
  async function open(d) {
    close();
    state = Object.assign({ handle: "", pfp: null, hero: "pot" }, d);
    try { state.handle = (localStorage.getItem("firmbrokers.pool.handle") || "").replace(/^@/, ""); } catch (e) {}
    await fonts();
    if (window.__BRANCHES && window.__BRANCHES.marksReady) { try { await window.__BRANCHES.marksReady(); } catch (e) { /* the coin */ } }
    else if (!state.markImg && state.mark) state.markImg = await loadImg(state.mark);
    const winner = state.kind === "winner";
    const file = () => `${state.slug || "office-pool"}-${winner ? "result" : state.code}.png`;
    modal = el("div", "pc-overlay");
    modal.innerHTML = `<div class="pc-box"><div class="pc-head"><span class="lab">YOUR CARD</span><button class="chip pc-x" type="button">CLOSE</button></div>
      ${winner ? "" : `<div class="pc-row"><span class="dim">your X handle</span><input type="text" class="pc-handle" placeholder="optional · puts your picture on it" value="${esc(state.handle)}" autocapitalize="off" spellcheck="false"></div>`}
      <div class="pc-card"><canvas></canvas></div>
      <div class="pc-post"><div class="dim">the post</div><div class="pc-text"></div></div>
      <div class="pc-actions"><button class="go pc-share" type="button">POST ON X</button><button class="chip pc-dl" type="button">DOWNLOAD</button><button class="chip pc-copy" type="button">COPY LINK</button></div>
      <div class="fine pc-hint">${isTouch() ? "the card goes with the post" : "the card goes with the post: it is copied when the post box opens — press ⌘V (ctrl+V) to attach it."}</div></div>`;
    document.body.appendChild(modal);
    document.addEventListener("keydown", onKey);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    modal.querySelector(".pc-x").addEventListener("click", close);
    const canvas = modal.querySelector("canvas");
    const textEl = modal.querySelector(".pc-text");
    const hint = modal.querySelector(".pc-hint");
    const paint = () => { (winner ? drawWinner : drawCard)(canvas, state); textEl.textContent = state.postText; };
    paint();
    if (state.handle && !winner) loadPfp(state.handle).then((img) => { state.pfp = img; paint(); });
    const input = modal.querySelector(".pc-handle");
    let t = null;
    if (input) input.addEventListener("input", () => {
      state.handle = input.value.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 15);
      try { localStorage.setItem("firmbrokers.pool.handle", state.handle); } catch (e) {}
      state.pfp = null; paint();
      clearTimeout(t); t = setTimeout(() => loadPfp(state.handle).then((img) => { if (img) { state.pfp = img; paint(); } }), 500);
    });
    modal.querySelector(".pc-copy").addEventListener("click", () => { if (navigator.clipboard) navigator.clipboard.writeText(state.link).then(() => { hint.textContent = "link copied"; }); });
    /// desktop: a download link (in the document — some browsers ignore a detached one)
    const downloadLink = (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = file(); a.rel = "noopener"; a.style.display = "none";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    /// phones: wallet in-app browsers and iOS ignore a[download] (nothing happens —
    /// the tester's report). Offer the share sheet with the file when the browser
    /// has one (Save Image is on it); otherwise swap the canvas for an <img> of the
    /// PNG, which every phone browser saves on a long press.
    const showForLongPress = (blob) => {
      const holder = modal.querySelector(".pc-card"); if (!holder) return;
      let img = holder.querySelector("img.pc-img");
      if (!img) { img = document.createElement("img"); img.className = "pc-img"; img.alt = "your card"; holder.appendChild(img); }
      img.src = URL.createObjectURL(blob);
      canvas.hidden = true;
      hint.innerHTML = "<b>press and hold the card</b>, then <b>Save Image</b> (Add to Photos).";
    };
    const saveOnPhone = async (blob) => {
      const f = new File([blob], file(), { type: "image/png" });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
        try { await navigator.share({ files: [f] }); hint.textContent = "saved? pick Save Image on the sheet if not."; return true; }
        catch (e) { if (e && e.name === "AbortError") return true; /* no files on this sheet: fall through */ }
      }
      showForLongPress(blob);
      return false;
    };
    modal.querySelector(".pc-dl").addEventListener("click", async () => {
      const blob = await cardBlob(); if (!blob) return;
      if (isPhone()) await saveOnPhone(blob); else downloadLink(blob);
    });
    modal.querySelector(".pc-share").addEventListener("click", () => {
      const blobP = cardBlob();
      const intent = "https://x.com/intent/post?text=" + encodeURIComponent(state.postText);
      const fallbackDownload = (blob) => {
        if (!blob) return;
        downloadLink(blob);
        hint.innerHTML = "your card just <b>downloaded</b> — attach it to the post with the image button, then post.";
      };
      if (isPhone()) {
        // second tap after the card was shown for saving: straight to X (synchronous, no popup block)
        if (state.savedForPost) { window.open(intent, "_blank", "noopener"); return; }
        (async () => {
          const blob = await blobP;
          const f = blob && new File([blob], file(), { type: "image/png" });
          if (f && navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
            try { await navigator.share({ text: state.postText, files: [f] }); hint.textContent = "posted? your link is in it — 5% of every chip-in from whoever arrives is yours."; return; }
            catch (e) { if (e && e.name === "AbortError") return; /* sheet dismissed */ }
          }
          // no share sheet with files (wallet browsers): show the card to save, X on the next tap
          if (blob) { showForLongPress(blob); state.savedForPost = true; hint.innerHTML = "<b>press and hold the card</b> to save it, then tap <b>POST ON X</b> again and attach it."; }
          else window.open(intent, "_blank", "noopener");
        })();
        return;
      }
      let wrote = null;
      try { if (navigator.clipboard && window.ClipboardItem) wrote = navigator.clipboard.write([new ClipboardItem({ "image/png": blobP })]); } catch (e) { wrote = null; }
      window.open(intent, "_blank", "noopener");
      if (wrote) { hint.innerHTML = "your card is <b>copied</b> — in the post box, press <b>⌘V</b> (ctrl+V) to attach it, then post."; wrote.catch(async () => fallbackDownload(await blobP)); }
      else blobP.then(fallbackDownload);
    });
  }

  window.__POOL_CARD = { open, drawCard, drawWinner, pixelPfp, loadPfp, isPhone };
})();
