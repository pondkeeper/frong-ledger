/* Meme Pond — community FRONG memes. The static site ships no memes of its own:
   people submit from this page (no account), the pondkeeper approves, and the
   gallery reads the approved list from the drop-box Worker (see worker/).
   Copy = PNG to clipboard (canvas-converted for JPEGs). Share = Web Share API
   with the file (phones → X / Telegram sheet). Download = worker ?dl=1. */
'use strict';

const API = '';                               // drop-box worker URL, e.g. 'https://frong-meme-pond.<acct>.workers.dev' — empty = submissions closed
const SITE_URL = 'https://pondkeeper.github.io/frong-ledger/memes.html';
const POST_TEXT = '$FRONG 🐸';                 // prefilled text for the X composer
const MAX_MB = 4;

const apiBase = (new URLSearchParams(location.search).get('api') || API).replace(/\/$/, '');
const M = { all: [], filter: 'all', q: '', view: [], lbIndex: -1, err: false };
const memeEl = id => document.getElementById(id);
const escH = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const imgUrl = m => `${apiBase}/m/${m.id}`;

/* ---------- capability probes ---------- */
const probeFile = (() => { try { return new File([new Blob(['x'])], 'x.png', { type: 'image/png' }); } catch { return null; } })();
const CAN_SHARE = !!(probeFile && navigator.canShare && navigator.canShare({ files: [probeFile] }));
const CAN_COPY = !!(navigator.clipboard && window.ClipboardItem);

/* ---------- toast ---------- */
let toastT;
function toast(msg, ms = 2400) {
  const t = memeEl('toast'); if (!t) return;
  t.textContent = msg; t.hidden = false; t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.classList.remove('on'); setTimeout(() => { t.hidden = true; }, 250); }, ms);
}

/* ---------- image helpers ---------- */
const fmtKB = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
const isGif = m => m.fmt === 'gif';
const kindOf = m => isGif(m) ? 'gif' : 'meme';
const fmtWhen = ts => { const d = new Date(ts); return d.toISOString().slice(0, 10); };

async function fetchBlob(m) {
  const r = await fetch(imgUrl(m));
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
  const file = new File([blob], `frong-meme.${m.fmt}`, { type: blob.type || m.type });
  await navigator.share({ files: [file], text: POST_TEXT });
}

/* ---------- actions ---------- */
function actionsHTML(m, i) {
  const gif = isGif(m);
  return [
    `<a class="mbtn" href="${imgUrl(m)}?dl=1" title="Save the original file">⬇ download</a>`,
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
    return (m.title + ' ' + (m.credit || '')).toLowerCase().includes(q);
  });
  renderGrid();
}
function renderGrid() {
  const g = memeEl('memegrid');
  g.innerHTML = M.view.map((m, i) => {
    const tag = isGif(m) ? '<span class="mtag">GIF</span>' : '';
    const title = m.title || 'untitled frog';
    const dims = m.w && m.h ? `${m.w}×${m.h} · ` : '';
    return `<figure class="meme" data-i="${i}">
      <button class="memepic" data-open="${i}" aria-label="Open ${escH(title)}">
        <img src="${imgUrl(m)}" alt="${escH(title)}" loading="lazy" decoding="async"
             ${m.w && m.h ? `width="${m.w}" height="${m.h}" style="aspect-ratio:${m.w}/${m.h}"` : ''}>
        ${tag}
      </button>
      <figcaption>
        <span class="memetitle">${escH(title)}</span>
        <span class="mememeta mono">${dims}${m.fmt.toUpperCase()} · ${fmtKB(m.bytes)}${m.credit ? ' · by ' + escH(m.credit) : ''} · ${fmtWhen(m.at)}</span>
        <span class="memeacts">${actionsHTML(m, i)}</span>
      </figcaption>
    </figure>`;
  }).join('');
  const n = M.all.length, v = M.view.length;
  const empty = memeEl('memeempty');
  empty.hidden = v > 0;
  empty.textContent = M.err ? 'Couldn’t reach the pond — refresh in a moment.'
    : n === 0 ? 'The pond is empty. Be the first — toss a frog in below. 🐸'
    : 'Nothing in the pond matches that. Try another word.';
  memeEl('memecount').textContent = M.err ? 'pond unreachable' : n === 0 ? 'the pond is empty' :
    (v === n ? `${n} frog${n === 1 ? '' : 's'} in the pond` : `${v} of ${n} frogs`);
}

/* ---------- lightbox ---------- */
function openLB(i) {
  const lb = memeEl('lightbox'), m = M.view[i]; if (!m) return;
  M.lbIndex = i;
  const title = m.title || 'untitled frog';
  memeEl('lb-title').textContent = title;
  memeEl('lb-meta').textContent = `${m.w && m.h ? m.w + '×' + m.h + ' · ' : ''}${m.fmt.toUpperCase()} · ${fmtKB(m.bytes)}${m.credit ? ' · by ' + m.credit : ''}`;
  const img = memeEl('lb-img'); img.src = imgUrl(m); img.alt = title;
  memeEl('lb-acts').innerHTML = actionsHTML(m, i);
  memeEl('lb-prev').disabled = i <= 0; memeEl('lb-next').disabled = i >= M.view.length - 1;
  if (!lb.open) lb.showModal();
}

/* ---------- uploader ---------- */
const U = { file: null, w: 0, h: 0, busy: false };
function setStatus(msg, cls = '') { const s = memeEl('upstatus'); s.textContent = msg; s.className = 'upstatus mono ' + cls; }
function pickFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { setStatus('PNG, JPG, GIF or WebP only', 'bad'); return; }
  if (file.size > MAX_MB * 1048576) { setStatus(`too big — max ${MAX_MB} MB (it's ${fmtKB(file.size)})`, 'bad'); return; }
  U.file = file; U.w = U.h = 0;
  const url = URL.createObjectURL(file);
  const pv = memeEl('uppreview'); pv.src = url; pv.hidden = false;
  pv.onload = () => { U.w = pv.naturalWidth; U.h = pv.naturalHeight; };
  memeEl('drop').classList.add('has');
  memeEl('upform').hidden = false;
  memeEl('upsend').disabled = false;
  setStatus(`${file.name} · ${fmtKB(file.size)} — add a title if you want, then toss it in`);
}
function resetUpload() {
  U.file = null;
  const pv = memeEl('uppreview'); pv.hidden = true; pv.removeAttribute('src');
  memeEl('drop').classList.remove('has');
  memeEl('upform').hidden = true;
  memeEl('file').value = '';
  memeEl('uptitle').value = ''; memeEl('upcredit').value = '';
}
async function sendUpload() {
  if (!U.file || U.busy) return;
  U.busy = true; memeEl('upsend').disabled = true;
  setStatus('tossing…');
  const fd = new FormData();
  fd.append('file', U.file, U.file.name);
  fd.append('title', memeEl('uptitle').value.slice(0, 80));
  fd.append('credit', memeEl('upcredit').value.slice(0, 40));
  fd.append('w', String(U.w)); fd.append('h', String(U.h));
  try {
    const r = await fetch(apiBase + '/api/submit', { method: 'POST', body: fd });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) throw new Error(d.error || 'upload failed (' + r.status + ')');
    resetUpload();
    setStatus('🐸 it’s in the inbox — the pondkeeper waves memes through in a few hours. Toss another?', 'good');
    toast('in the inbox — thanks for feeding the pond');
  } catch (e) {
    console.error(e);
    setStatus((e.message || 'upload failed') + ' — try again', 'bad');
    memeEl('upsend').disabled = false;
  }
  U.busy = false;
}
function wireUpload() {
  const drop = memeEl('drop'), file = memeEl('file');
  if (!drop) return;
  if (!apiBase) {
    drop.classList.add('closed');
    drop.querySelector('.dropcopy').textContent = 'submissions open shortly — the pond is being dug';
    return;
  }
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  file.addEventListener('change', () => pickFile(file.files[0]));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => pickFile(e.dataTransfer.files[0]));
  document.addEventListener('paste', e => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
    if (f) { pickFile(f); memeEl('submit').scrollIntoView({ behavior: 'smooth' }); }
  });
  memeEl('upsend').addEventListener('click', sendUpload);
  memeEl('upcancel').addEventListener('click', () => { resetUpload(); setStatus(''); });
}

/* ---------- boot ---------- */
async function bootMemes() {
  const grid = memeEl('memegrid'); if (!grid) return;
  wireUpload();
  if (apiBase) {
    try {
      const r = await fetch(apiBase + '/api/memes?t=' + Math.floor(Date.now() / 60000)); // minute bucket: fresh after approvals, still cacheable
      const d = await r.json();
      M.all = (d.memes || []);
    } catch (e) {
      console.error(e); M.err = true;
    }
  } else memeEl('memecount').textContent = 'the pond is being dug';
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
}
bootMemes();
