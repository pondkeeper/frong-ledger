/* Frong Meme Pond — drop box + gallery API.
   Cloudflare Worker + KV only (files under f:<id>, metadata under m:<id>) — no R2, so
   the account never needs a payment method. No accounts for submitters.
   Nothing is served publicly until the pondkeeper approves it on /admin.

   Routes
     POST /api/submit           multipart: file, title?, credit?, w?, h?      → {ok,id}
     GET  /api/memes            approved list (cached 60s)                    → {count,memes:[…]}
     GET  /m/:id[?dl=1]         approved image (dl=1 → download)              → bytes
     GET  /admin?key=…          moderation page (HTML)
     GET  /api/admin/list       x-admin-key header                            → {pending,approved}
     POST /api/admin/moderate   x-admin-key header {id, action: approve|reject|remove, title?, credit?}
*/

const MAX_BYTES = 4 * 1024 * 1024;
const RATE_PER_HOUR = 12;          // uploads per IP per hour
const PENDING_CAP = 400;           // stop accepting when the inbox is this full
const TITLE_MAX = 80, CREDIT_MAX = 40;

const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function sniff(buf) {
  const b = new Uint8Array(buf.slice(0, 16));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

const clean = (s, n) => String(s || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, n);
const slug = s => (s || 'frong-meme').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'frong-meme';
const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

function cors(req, env) {
  const origin = req.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    'access-control-allow-origin': ok ? origin : allowed[0] || '',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-key',
    'access-control-max-age': '86400',
    'vary': 'origin',
  };
}

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const isAdmin = (req, env, url) => {
  const k = req.headers.get('x-admin-key') || url.searchParams.get('key') || '';
  return !!env.ADMIN_KEY && safeEq(k, env.ADMIN_KEY);
};

/* ---------- storage (KV) ----------
   f:<id>  → raw image bytes (KV values go up to 25 MiB; we cap uploads at 4 MB).
   m:<id>  → JSON meta; KV metadata field mirrors {s:status} so list() is enough for counts.
   approved → cached JSON array of approved metas (newest first), rebuilt on moderation. */
async function listAll(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.MEMES.list({ prefix: 'm:', cursor });
    for (const k of r.keys) out.push({ id: k.name.slice(2), s: k.metadata?.s || 'pending' });
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  return out;
}
const getMeta = (env, id) => env.MEMES.get('m:' + id, 'json');
const putMeta = (env, m) => env.MEMES.put('m:' + m.id, JSON.stringify(m), { metadata: { s: m.status } });
const publicView = m => ({ id: m.id, title: m.title, credit: m.credit, fmt: m.fmt, type: TYPES[m.fmt],
  w: m.w, h: m.h, bytes: m.bytes, at: m.approvedAt || m.at });
async function rebuildApproved(env) {
  const all = (await listAll(env)).filter(x => x.s === 'approved');
  const metas = (await Promise.all(all.map(x => getMeta(env, x.id)))).filter(Boolean);
  metas.sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0));
  const pub = metas.map(publicView);
  await env.MEMES.put('approved', JSON.stringify(pub));
  return pub;
}

/* ---------- handlers ---------- */
async function submit(req, env, url) {
  const h = cors(req, env);
  const ip = req.headers.get('cf-connecting-ip') || '0.0.0.0';
  const iph = (await sha(ip + '|' + (env.SALT || 'pond'))).slice(0, 24);
  const hour = Math.floor(Date.now() / 3600000);
  const rlKey = `rl:${iph}:${hour}`;
  const used = parseInt(await env.MEMES.get(rlKey) || '0', 10);
  if (used >= RATE_PER_HOUR) return json({ ok: false, error: 'slow down — try again in an hour' }, 429, h);

  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > MAX_BYTES + 16384) return json({ ok: false, error: 'file too big (max 4 MB)' }, 413, h);

  let form;
  try { form = await req.formData(); } catch { return json({ ok: false, error: 'bad upload' }, 400, h); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return json({ ok: false, error: 'no file' }, 400, h);
  if (file.size > MAX_BYTES) return json({ ok: false, error: 'file too big (max 4 MB)' }, 413, h);
  if (file.size < 64) return json({ ok: false, error: 'that file is empty' }, 400, h);
  const buf = await file.arrayBuffer();
  const fmt = sniff(buf);
  if (!fmt) return json({ ok: false, error: 'PNG, JPG, GIF or WebP only' }, 415, h);

  const pending = (await listAll(env)).filter(x => x.s === 'pending').length;
  if (pending >= PENDING_CAP) return json({ ok: false, error: 'the inbox is full — try again later' }, 503, h);

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const w = Math.min(20000, Math.max(0, parseInt(form.get('w') || '0', 10) || 0));
  const hh = Math.min(20000, Math.max(0, parseInt(form.get('h') || '0', 10) || 0));
  const meta = {
    id, fmt, bytes: buf.byteLength, w, h: hh,
    title: clean(form.get('title'), TITLE_MAX), credit: clean(form.get('credit'), CREDIT_MAX),
    status: 'pending', at: Date.now(), iph,
  };
  await env.MEMES.put('f:' + id, buf);
  await putMeta(env, meta);
  await env.MEMES.put(rlKey, String(used + 1), { expirationTtl: 3700 });
  return json({ ok: true, id }, 200, h);
}

async function listMemes(req, env) {
  const h = cors(req, env);
  let pub = await env.MEMES.get('approved', 'json');
  if (!pub) pub = await rebuildApproved(env);
  return json({ count: pub.length, memes: pub }, 200, { ...h, 'cache-control': 'public, max-age=60' });
}

async function serveImage(req, env, url, id) {
  const h = cors(req, env);
  const meta = await getMeta(env, id);
  if (!meta) return new Response('not found', { status: 404, headers: h });
  if (meta.status !== 'approved' && !isAdmin(req, env, url)) return new Response('not found', { status: 404, headers: h });
  // approved images are immutable → let the edge cache absorb repeat reads (KV free tier = 100k reads/day)
  const cacheable = meta.status === 'approved';
  const cache = caches.default;
  const ckey = new Request(url.origin + '/m/' + id + (url.searchParams.get('dl') ? '?dl=1' : ''), { method: 'GET' });
  if (cacheable) { const hit = await cache.match(ckey); if (hit) { const r = new Response(hit.body, hit); Object.entries(h).forEach(([k, v]) => r.headers.set(k, v)); return r; } }
  const buf = await env.MEMES.get('f:' + id, 'arrayBuffer');
  if (!buf) return new Response('gone', { status: 404, headers: h });
  const name = `${slug(meta.title)}-${id.slice(0, 6)}.${meta.fmt}`;
  const headers = {
    ...h,
    'content-type': TYPES[meta.fmt],
    'content-length': String(buf.byteLength),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': meta.status === 'approved' ? 'public, max-age=31536000, immutable' : 'no-store',
    'content-disposition': (url.searchParams.get('dl') ? 'attachment' : 'inline') + `; filename="${name}"`,
  };
  const res = new Response(buf, { headers });
  if (cacheable) await cache.put(ckey, res.clone());
  return res;
}

async function adminList(env) {
  const all = await listAll(env);
  const metas = (await Promise.all(all.map(x => getMeta(env, x.id)))).filter(Boolean);
  const pending = metas.filter(m => m.status === 'pending').sort((a, b) => a.at - b.at);
  const approved = metas.filter(m => m.status === 'approved').sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0));
  const strip = m => ({ id: m.id, title: m.title, credit: m.credit, fmt: m.fmt, w: m.w, h: m.h, bytes: m.bytes, at: m.at, approvedAt: m.approvedAt });
  return { pending: pending.map(strip), approved: approved.map(strip) };
}

async function moderate(req, env) {
  let body; try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const id = String(body.id || '').replace(/[^a-z0-9]/g, '');
  const meta = id && await getMeta(env, id);
  if (!meta) return json({ ok: false, error: 'unknown id' }, 404);
  if (body.action === 'approve') {
    if (body.title != null) meta.title = clean(body.title, TITLE_MAX);
    if (body.credit != null) meta.credit = clean(body.credit, CREDIT_MAX);
    meta.status = 'approved'; meta.approvedAt = Date.now();
    await putMeta(env, meta);
  } else if (body.action === 'reject' || body.action === 'remove') {
    await env.MEMES.delete('f:' + id);
    await env.MEMES.delete('m:' + id);
  } else return json({ ok: false, error: 'bad action' }, 400);
  await rebuildApproved(env);
  return json({ ok: true });
}

const adminPage = () => new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req, env) });

    if (p === '/api/submit' && req.method === 'POST') return submit(req, env, url);
    if (p === '/api/memes' && req.method === 'GET') return listMemes(req, env);
    const m = p.match(/^\/m\/([a-z0-9]{6,32})$/);
    if (m && req.method === 'GET') return serveImage(req, env, url, m[1]);

    if (p === '/admin') return isAdmin(req, env, url) ? adminPage() : new Response('not found', { status: 404 });
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req, env, url)) return json({ ok: false, error: 'nope' }, 401);
      if (p === '/api/admin/list' && req.method === 'GET') return json(await adminList(env), 200, { 'cache-control': 'no-store' });
      if (p === '/api/admin/moderate' && req.method === 'POST') return moderate(req, env);
    }
    if (p === '/') return new Response('frong meme pond api', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },
};

/* ---------- moderation page (served only with the admin key) ---------- */
const ADMIN_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>pond inbox</title>
<style>
body{margin:0;background:#070a06;color:#d6e4c8;font:14px/1.5 ui-monospace,Menlo,monospace;padding:16px}
h1{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:#a8e05a;margin:0 0 14px}
h2{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#9db38a;margin:26px 0 10px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.c{background:#0d120b;border:1px solid rgba(214,228,200,.12);border-radius:5px;overflow:hidden}
.c img{display:block;width:100%;height:220px;object-fit:contain;background:#000}
.b{padding:10px;display:flex;flex-direction:column;gap:6px}
input{font:inherit;background:#131a10;color:#d6e4c8;border:1px solid rgba(214,228,200,.15);border-radius:3px;padding:5px 8px;width:100%;box-sizing:border-box}
.r{display:flex;gap:6px;margin-top:4px}
button{font:inherit;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:11px;border:0;border-radius:3px;padding:8px 10px;cursor:pointer;flex:1}
.ok{background:#a8e05a;color:#0b1105}.no{background:#1c2616;color:#e66767}.rm{background:#1c2616;color:#9db38a}
.m{font-size:11px;color:#6f8060}
#s{color:#6f8060;font-size:12px;margin-bottom:8px}
.empty{color:#6f8060;font-size:12px}
</style>
<h1>pond inbox</h1><div id="s">loading…</div>
<h2>Pending <span id="np"></span></h2><div class="g" id="pending"></div>
<h2>Live in the pond <span id="na"></span></h2><div class="g" id="approved"></div>
<script>
const KEY=new URLSearchParams(location.search).get('key')||'';
const esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const kb=b=>b>=1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' KB';
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{'x-admin-key':KEY,'content-type':'application/json',...(opt.headers||{})}});return r.json()}
function card(m,pending){return '<div class="c" data-id="'+m.id+'"><img src="/m/'+m.id+'?key='+encodeURIComponent(KEY)+'" alt=""><div class="b">'
 +'<input class="t" value="'+esc(m.title)+'" placeholder="title (optional)"><input class="cr" value="'+esc(m.credit)+'" placeholder="credit (optional)">'
 +'<span class="m">'+m.fmt.toUpperCase()+' · '+(m.w?m.w+'×'+m.h+' · ':'')+kb(m.bytes)+' · '+new Date(m.at).toISOString().slice(0,16).replace('T',' ')+'Z</span>'
 +'<div class="r">'+(pending?'<button class="ok" data-a="approve">approve</button><button class="no" data-a="reject">reject</button>':'<button class="rm" data-a="remove">remove</button>')+'</div></div></div>'}
async function load(){const d=await api('/api/admin/list');if(!d.pending){document.getElementById('s').textContent='auth failed';return}
 document.getElementById('s').textContent=new Date().toISOString().slice(11,19)+'Z';
 document.getElementById('np').textContent='('+d.pending.length+')';document.getElementById('na').textContent='('+d.approved.length+')';
 document.getElementById('pending').innerHTML=d.pending.map(m=>card(m,true)).join('')||'<p class="empty">inbox empty — nothing to review</p>';
 document.getElementById('approved').innerHTML=d.approved.map(m=>card(m,false)).join('')||'<p class="empty">nothing live yet</p>'}
document.addEventListener('click',async e=>{const b=e.target.closest('button[data-a]');if(!b)return;const c=b.closest('.c');
 if(b.dataset.a!=='approve'&&!confirm(b.dataset.a+' this one? (deletes the file)'))return;
 b.disabled=true;const r=await api('/api/admin/moderate',{method:'POST',body:JSON.stringify({id:c.dataset.id,action:b.dataset.a,title:c.querySelector('.t').value,credit:c.querySelector('.cr').value})});
 if(!r.ok)alert(r.error||'failed');load()});
load();setInterval(load,60000);
</script></html>`;
