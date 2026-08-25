/* Meme Pond — gallery of community FRONG memes served straight from the repo.
   Zero backend: docs/memes/manifest.json is rebuilt by pipeline/memes.py.
   Download = same-origin <a download>. Copy = PNG to clipboard (canvas-converted
   for JPEGs). Share = Web Share API with the file (phones → X / Telegram sheet). */
'use strict';

const MEME_DIR = 'memes/';
const SITE_URL = 'https://pondkeeper.github.io/frong-ledger/memes.html';
const POST_TEXT = '$FRONG 🐸';                 // prefilled text for the X composer
const SUBMIT_ALT = { label: '', href: '' };   // optional second submission route (e.g. a community group) — empty = hidden

const M = { all: [], filter: 'all', q: '', view: [], lbIndex: -1 };
const memeEl = id => document.getElementById(id);
const escH = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- capability probes ---------- */
const probeFile = (() => { try { return new File([new Blob(['x'])], 'x.png', { type: 'image/png' }); } catch { return null; } })();
const CAN_SHARE = !!(probeFile && navigator.canShare && navigator.canShare({ files: [probeFile] }));
const CAN_COPY = !!(navigator.clipboard && window.ClipboardItem);

/* ---------- toast ---------- */
let toastT;
function toast(msg, ms = 2200) {
  const t = memeEl('toast'); if (!t) return;
  t.textContent = msg; t.hidden = false; t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove('on'); setTimeout(() => { t.hidden = true; }, 250); }, ms);
}

/* ---------- image helpers ---------- */
const fmtKB = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
const isGif = m => m.fmt === 'gif';
const kindOf = m => isGif(m) ? 'gif' : (m.tags.includes('template') ? 'template' : 'meme');

async function fetchBlob(m) {
  const r = await fetch(MEME_DIR + m.file);
  if (!r.ok) throw new Error('fetch ' + r.status);
  return r.blob();
}
async function toPng(blob) {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('encode')), 'image/png'));
}
async function copyMeme(m) {
  // Safari needs the write to start inside the gesture: hand it a promise. Chrome
  // accepts promises too (and blobs); fall back to a resolved blob if it refuses.
  const pngP = fetchBlob(m).then(toPng);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngP })]);
  } catch (e) {
    const png = await pngP;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }
}
async function shareMeme(m) {
  const blob = await fetchBlob(m);
  const file = new File([blob], m.file, { type: blob.type || 'image/' + (m.fmt === 'jpg' ? 'jpeg' : m.fmt) });
  await navigator.share({ files: [file], text: POST_TEXT });
}

/* ---------- actions ---------- */
function actionsHTML(m, i) {
  const gif = isGif(m);
  return [
    `<a class="mbtn" href="${MEME_DIR}${escH(m.file)}" download="${escH(m.file)}" title="Save the original file">⬇ download</a>`,
    !gif && CAN_COPY ? `<button class="mbtn" data-act="copy" data-i="${i}" title="Copy the image — then paste it into your post">📋 copy</button>` : '',
    CAN_SHARE ? `<button class="mbtn" data-act="share" data-i="${i}" title="Share to X, Telegram, Discord…">📤 share</button>` : '',
    `<button class="mbtn x" data-act="post" data-i="${i}" title="${gif ? 'Opens the X composer — attach the downloaded GIF' : 'Copies the image and opens the X composer — just paste'}">𝕏 post</button>`,
  ].join('');
}
async function doAction(act, i, btn) {
  const m = M.view[i]; if (!m) return;
  const busy = on => { if (btn) btn.classList.toggle('busy', on); };
  try {
    if (act === 'copy') {
      busy(true); await copyMeme(m); busy(false);
      toast('copied — paste it into your post (⌘/Ctrl+V)');
    } else if (act === 'share') {
      await shareMeme(m);
    } else if (act === 'post') {
      // open synchronously (popup blockers), then copy in the background
      const url = 'https://x.com/intent/post?text=' + encodeURIComponent(POST_TEXT + ' ' + SITE_URL);
      const w = window.open(url, '_blank');   // ('noopener' as a feature makes open() return null — detach manually)
      if (w) w.opener = null;
      if (!w) { toast('popup blocked — allow popups for the X composer'); return; }
      if (isGif(m)) { toast('attach the downloaded GIF in the composer'); return; }
      if (CAN_COPY) {
        try { await copyMeme(m); toast('image copied — paste it into the post'); }
        catch { toast('couldn’t copy automatically — use ⬇ download and attach it'); }
      } else toast('use ⬇ download and attach the image');
    }
  } catch (e) {
    busy(false);
    if (e && e.name === 'AbortError') return; // user closed the share sheet
    console.error(e);
    toast(act === 'copy' ? 'copy failed — try ⬇ download' : 'that didn’t work — try ⬇ download');
  }
}

/* ---------- gallery ---------- */
function applyFilter() {
  const q = M.q.trim().toLowerCase();
  M.view = M.all.filter(m => {
    if (M.filter !== 'all' && kindOf(m) !== M.filter) return false;
    if (!q) return true;
    return (m.title + ' ' + m.file + ' ' + m.tags.join(' ') + ' ' + (m.credit || '')).toLowerCase().includes(q);
  });
  renderGrid();
}
function renderGrid() {
  const g = memeEl('memegrid');
  g.innerHTML = M.view.map((m, i) => {
    const kind = kindOf(m);
    const tag = kind === 'gif' ? '<span class="mtag">GIF</span>' : kind === 'template' ? '<span class="mtag">TEMPLATE</span>'
      : m.tags.includes('pfp') ? '<span class="mtag">PFP</span>' : '';
    return `<figure class="meme" data-i="${i}">
      <button class="memepic" data-open="${i}" aria-label="Open ${escH(m.title)}">
        <img src="${MEME_DIR}${escH(m.file)}" alt="${escH(m.title)}" loading="lazy" decoding="async"
             width="${m.w}" height="${m.h}" style="aspect-ratio:${m.w}/${m.h}">
        ${tag}
      </button>
      <figcaption>
        <span class="memetitle">${escH(m.title)}</span>
        <span class="mememeta mono">${m.w}×${m.h} · ${m.fmt.toUpperCase()} · ${fmtKB(m.bytes)}${m.credit ? ' · by ' + escH(m.credit) : ''}</span>
        <span class="memeacts">${actionsHTML(m, i)}</span>
      </figcaption>
    </figure>`;
  }).join('');
  memeEl('memeempty').hidden = M.view.length > 0;
  const n = M.all.length, v = M.view.length;
  memeEl('memecount').textContent = n === 0 ? 'the pond is empty' :
    (v === n ? `${n} frog${n === 1 ? '' : 's'} in the pond` : `${v} of ${n} frogs`);
}

/* ---------- lightbox ---------- */
function openLB(i) {
  const lb = memeEl('lightbox'), m = M.view[i]; if (!m) return;
  M.lbIndex = i;
  memeEl('lb-title').textContent = m.title;
  memeEl('lb-meta').textContent = `${m.w}×${m.h} · ${m.fmt.toUpperCase()} · ${fmtKB(m.bytes)}${m.credit ? ' · by ' + m.credit : ''}`;
  const img = memeEl('lb-img'); img.src = MEME_DIR + m.file; img.alt = m.title;
  memeEl('lb-acts').innerHTML = actionsHTML(m, i);
  memeEl('lb-prev').disabled = i <= 0; memeEl('lb-next').disabled = i >= M.view.length - 1;
  if (!lb.open) lb.showModal();
}

/* ---------- boot ---------- */
async function bootMemes() {
  const grid = memeEl('memegrid'); if (!grid) return;
  try {
    const cb = Math.floor(Date.now() / 300000);
    const r = await fetch(MEME_DIR + 'manifest.json?t=' + cb);
    const d = await r.json();
    M.all = (d.memes || []).map(m => ({ ...m, tags: m.tags || [] }));
    const gen = memeEl('gen'); if (gen && d.generated) gen.textContent = 'pond restocked ' + d.generated.slice(0, 10);
  } catch (e) {
    console.error(e);
    memeEl('memecount').textContent = 'couldn’t load the pond — refresh';
    return;
  }
  applyFilter();

  document.querySelectorAll('.memetools .pills button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.memetools .pills button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    M.filter = b.dataset.filter; applyFilter();
  }));
  memeEl('memesearch').addEventListener('input', e => { M.q = e.target.value; applyFilter(); });

  document.addEventListener('click', ev => {
    const act = ev.target.closest('[data-act]');
    if (act) { doAction(act.dataset.act, +act.dataset.i, act); return; }
    const op = ev.target.closest('[data-open]');
    if (op) openLB(+op.dataset.open);
  });

  const lb = memeEl('lightbox');
  memeEl('lb-close').addEventListener('click', () => lb.close());
  memeEl('lb-prev').addEventListener('click', () => openLB(M.lbIndex - 1));
  memeEl('lb-next').addEventListener('click', () => openLB(M.lbIndex + 1));
  lb.addEventListener('click', ev => { if (ev.target === lb) lb.close(); });
  document.addEventListener('keydown', ev => {
    if (!lb.open) return;
    if (ev.key === 'ArrowLeft') openLB(M.lbIndex - 1);
    if (ev.key === 'ArrowRight') openLB(M.lbIndex + 1);
  });

  const alt = memeEl('submitalt');
  if (alt && SUBMIT_ALT.href) { alt.href = SUBMIT_ALT.href; alt.textContent = SUBMIT_ALT.label + ' ↗'; alt.hidden = false; }
}
bootMemes();
