/* ===========================================================================
   A QR encoder in one file, for the referral card. Byte mode, versions 1–10,
   error correction M, the mask chosen by the standard's penalty score. No
   library and no CDN: the card is drawn on a canvas in the browser and the
   QR goes onto it as squares.

   Registers window.__QR = { encode }: encode(text) → { size, get(row, col) }
   with get() true for a dark module. Verified module-for-module against the
   `qrcode` npm package and read back by `jsqr` in test/ui/qr.mjs.
   =========================================================================== */
(function () {
  "use strict";

  // ---- GF(256), the field every error-correction byte lives in (poly 0x11d)
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  /// the generator polynomial for n error-correction codewords
  function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
      g = next;
    }
    return g;
  }
  function ecBytes(data, n) {
    const g = generator(n);
    const out = new Array(n).fill(0);
    for (const d of data) {
      const f = d ^ out.shift(); out.push(0);
      if (f) for (let j = 0; j < n; j++) out[j] ^= mul(g[j + 1], f);
    }
    return out;
  }

  // ---- level M, versions 1–10: [ec per block, [count, dataCodewords] ...]
  const BLOCKS = {
    1: [10, [1, 16]], 2: [16, [1, 28]], 3: [26, [1, 44]], 4: [18, [2, 32]], 5: [24, [2, 43]],
    6: [16, [4, 27]], 7: [18, [4, 31]], 8: [22, [2, 38], [2, 39]], 9: [22, [3, 36], [2, 37]], 10: [26, [4, 43], [1, 44]],
  };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const dataCapacity = (v) => BLOCKS[v].slice(1).reduce((s, [c, d]) => s + c * d, 0);

  /// BCH remainder: the value shifted up by the generator's degree, reduced
  /// modulo the generator, for the format (5 bits, 0x537) and version (6 bits, 0x1f25) strings
  function bch(value, poly, bits) {
    const deg = (32 - Math.clz32(poly)) - 1;
    let v = value << deg;
    for (let i = bits - 1; i >= deg; i--) if (v & (1 << i)) v ^= poly << (i - deg);
    return v;
  }

  function encode(text) {
    const bytes = [];
    for (const ch of unescape(encodeURIComponent(String(text)))) bytes.push(ch.charCodeAt(0));
    let version = 0;
    for (let v = 1; v <= 10; v++) { const overhead = v >= 10 ? 3 : 2; if (bytes.length <= dataCapacity(v) - overhead) { version = v; break; } }
    if (!version) throw new Error("qr: too long");

    // ---- the bit stream: mode, count, bytes, terminator, pad
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, version >= 10 ? 16 : 8);
    for (const b of bytes) push(b, 8);
    const cap = dataCapacity(version) * 8;
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let p = 0xec; words.length < dataCapacity(version); p ^= 0xec ^ 0x11) words.push(p);

    // ---- blocks and interleaving
    const [ecn, ...groups] = BLOCKS[version];
    const blocks = [];
    let at = 0;
    for (const [count, len] of groups) for (let i = 0; i < count; i++) { const d = words.slice(at, at + len); at += len; blocks.push({ d, e: ecBytes(d, ecn) }); }
    const seq = [];
    const maxD = Math.max(...blocks.map((b) => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) seq.push(b.d[i]);
    for (let i = 0; i < ecn; i++) for (const b of blocks) seq.push(b.e[i]);

    // ---- the matrix: function patterns first, so the data walk knows what to skip
    const size = version * 4 + 17;
    const m = new Uint8Array(size * size); // 0 light, 1 dark
    const reserved = new Uint8Array(size * size);
    const set = (r, c, dark) => { m[r * size + c] = dark ? 1 : 0; reserved[r * size + c] = 1; };
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const al = ALIGN[version];
    for (const r of al) for (const c of al) {
      // the three that would sit on a finder are left out; the ones on the
      // timing lines are drawn (their middle row agrees with the timing pattern)
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
    set(size - 8, 8, true); // the dark module
    // format areas reserved now, written after the mask is chosen
    for (let i = 0; i < 8; i++) { reserved[8 * size + i] = 1; reserved[i * size + 8] = 1; reserved[8 * size + size - 1 - i] = 1; reserved[(size - 1 - i) * size + 8] = 1; }
    reserved[8 * size + 8] = 1;
    if (version >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i * size + size - 11 + j] = 1; reserved[(size - 11 + j) * size + i] = 1; }

    // ---- the data walk: two-column strips, up then down, skipping column 6
    const data = new Uint8Array(size * size);
    let bi = 0;
    const total = seq.length * 8;
    for (let right = size - 1, up = true; right > 0; right -= 2, up = !up) {
      if (right === 6) right--;
      for (let k = 0; k < size; k++) {
        const r = up ? size - 1 - k : k;
        for (const c of [right, right - 1]) {
          if (reserved[r * size + c]) continue;
          const bit = bi < total ? (seq[bi >> 3] >> (7 - (bi & 7))) & 1 : 0;
          bi++;
          data[r * size + c] = bit;
        }
      }
    }

    const MASK = [
      (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
    ];
    const build = (mask) => {
      const out = new Uint8Array(m);
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r * size + c]) out[r * size + c] = data[r * size + c] ^ (MASK[mask](r, c) ? 1 : 0);
      // format: level M = 00, then the mask, BCH(15,5) with generator 0x537, xor 0x5412
      const fmtData = (0b00 << 3) | mask;
      const fmt = ((fmtData << 10) | bch(fmtData, 0x537, 15)) ^ 0x5412;
      const fb = (i) => (fmt >> i) & 1;
      for (let i = 0; i < 6; i++) out[8 * size + i] = fb(14 - i);
      out[8 * size + 7] = fb(8); out[8 * size + 8] = fb(7); out[7 * size + 8] = fb(6);
      for (let i = 0; i < 6; i++) out[(5 - i) * size + 8] = fb(5 - i);
      for (let i = 0; i < 8; i++) out[(size - 1 - i) * size + 8] = fb(14 - i);
      for (let i = 0; i < 8; i++) out[8 * size + size - 8 + i] = fb(7 - i);
      out[(size - 8) * size + 8] = 1;
      if (version >= 7) {
        const ver = (version << 12) | bch(version, 0x1f25, 18);
        for (let i = 0; i < 18; i++) { const b = (ver >> i) & 1; out[Math.floor(i / 3) * size + size - 11 + (i % 3)] = b; out[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] = b; }
      }
      return out;
    };
    const penalty = (g) => {
      let p = 0;
      const at = (r, c) => g[r * size + c];
      // runs of 5+ in a row or column
      for (let r = 0; r < size; r++) { let run = 1; for (let c = 1; c < size; c++) { if (at(r, c) === at(r, c - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      for (let c = 0; c < size; c++) { let run = 1; for (let r = 1; r < size; r++) { if (at(r, c) === at(r - 1, c)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
      // 2×2 blocks
      for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = at(r, c); if (v === at(r + 1, c) && v === at(r, c + 1) && v === at(r + 1, c + 1)) p += 3; }
      // finder-like 1011101 with four light on one side
      const pat = [1, 0, 1, 1, 1, 0, 1];
      const check = (get) => {
        for (let i = 0; i < size - 6; i++) {
          let hit = true; for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) { hit = false; break; }
          if (!hit) continue;
          let before = true, after = true;
          for (let k = 1; k <= 4; k++) { if (i - k < 0 || get(i - k) !== 0) before = false; if (i + 6 + k >= size || get(i + 6 + k) !== 0) after = false; }
          if (before || after) p += 40;
        }
      };
      for (let r = 0; r < size; r++) check((c) => at(r, c));
      for (let c = 0; c < size; c++) check((r) => at(r, c));
      // dark proportion
      let dark = 0; for (let i = 0; i < g.length; i++) dark += g[i];
      const pct = (dark * 100) / g.length;
      p += Math.min(Math.floor(Math.abs(pct - 50) / 5), Math.floor(Math.abs(pct - 50) / 5)) * 10;
      return p;
    };
    let best = null, bestScore = Infinity, bestMask = 0;
    for (let mask = 0; mask < 8; mask++) { const g = build(mask); const s = penalty(g); if (s < bestScore) { bestScore = s; best = g; bestMask = mask; } }
    return { size, version, mask: bestMask, get: (r, c) => best[r * size + c] === 1, matrix: best };
  }

  window.__QR = { encode };
})();
