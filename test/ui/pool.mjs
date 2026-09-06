// THE FRONG POOL page against a mocked chain.
//
//   node test/ui/pool.mjs            (from the repo root; needs test/ui/node_modules)
//
// Serves docs/ on a port of its own (18951–18960), rewrites pool-config.js to name
// a pool, answers the page's batched eth_calls from a fixture (one open round with
// three players, a seed, a feed, a round drawn today, a due round; the token says
// FRONG / 18 decimals), routes the price API to a fixed price, and asserts what
// the board says at desk 1280×900, phone 390×844 and a short 1280×640 window; a
// human-speed click; the connected batch; the calldata of approve + deposit; a
// 6-decimal token; a decimals mismatch; the inert page. Screenshots to
// test/ui/shots/pool-*.png, judged at 1:1.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let fails = 0;
const ok = (n, c, d = '') => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'}  ${n}${d ? '   ' + d : ''}`); };

const POOL = '0x00000000000000000000000000000000000f00d1';
const TOKEN = '0x6245e67affA44a23077f0Ea7f981a8DC743a0c47';
const POLL_WAIT = 21000; // one idle poll, so a re-render happens while the amount sits in the box
const W = (x) => BigInt(x).toString(16).padStart(64, '0');
const WA = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const STR = (s) => W(32) + W(s.length) + Buffer.from(s).toString('hex').padEnd(64, '0');
const ME = '0x00000000000000000000000000000000000c0ffe';
const now = Math.floor(Date.now() / 1000);
const closesAt = now + 3 * 3600 + 17 * 60;

/// a fixture for a token with `dec` decimals (amounts in whole tokens)
function fixture(dec, sym) {
  const U = 10n ** BigInt(dec);
  const P = [
    { a: '0x1111111111111111111111111111111111111111', dep: 250_000n * U, earned: 41_250n * U },
    { a: '0x2222222222222222222222222222222222222222', dep: 100_000n * U, earned: 12_500n * U },
    { a: '0x3333333333333333333333333333333333333333', dep: 40_000n * U, earned: 0n },
  ];
  const totalW = P.reduce((s, p) => s + p.dep, 0n);
  const deposits = totalW;
  const pot = 50_000n * U + (deposits * 60n) / 100n + 10_000n * U;
  const knobs = W(500n * U) + W(2500) + W(500) + W(1000) + W(0) + W(10000);
  const round = (o) => W(o.closesAt) + W(o.beacon) + W(o.state) + W(o.players) + W(o.deposits) + W(o.totalW) + W(o.pot) + W(o.seed) + W(0)
    + WA(o.refund || '0x' + '0'.repeat(40)) + WA(o.jackpot || '0x' + '0'.repeat(40)) + W(o.refundPaid || 0) + W(o.jackpotPaid || 0) + W(0) + knobs;
  const ROUNDS = {
    3: round({ closesAt, beacon: 31_950_000, state: 1, players: 3, deposits, totalW, pot, seed: 50_000n * U }),
    // drawn TODAY, an hour ago: the results banner shows until the next bell; the jackpot went to the mock wallet
    2: round({ closesAt: now - 3600, beacon: 31_921_200, state: 2, players: 4, deposits: 400_000n * U, totalW: 400_000n * U, pot: 0, seed: 20_000n * U,
      refund: P[1].a, jackpot: ME, refundPaid: 100_000n * U, jackpotPaid: 160_000n * U }),
    // closed two days ago and never drawn: the bell panel
    1: round({ closesAt: closesAt - 2 * 86400, beacon: 31_892_400, state: 1, players: 2, deposits: 90_000n * U, totalW: 90_000n * U, pot: 54_000n * U, seed: 0 }),
  };
  const playerView = (p) => W(1) + W(0) + W(p.dep) + W(p.dep) + W(p.earned) + W(p.earned / 2n) + W(totalW) + W(0);
  const arr = (xs) => W(32) + W(xs.length) + xs.map(W).join('');
  return { P, U, answer(to, data) {
    const sel = data.slice(0, 10);
    if (to.toLowerCase() === TOKEN.toLowerCase()) {
      if (sel === '0x313ce567') return '0x' + W(dec);
      if (sel === '0x95d89b41') return '0x' + STR(sym);
      if (sel === '0x70a08231') return '0x' + W(100_000n * U); // a 100k balance
      if (sel === '0xdd62ed3e') return '0x' + W(0); // no allowance yet
      throw new Error(`unknown token selector ${sel}`);
    }
    if (to.toLowerCase() !== POOL.toLowerCase()) throw new Error(`call to an unexpected address ${to}`);
    switch (sel) {
      case '0x062c1746': return '0x' + W(4_200n * U); // claimableDividends
      case '0x994ec7c7': return '0x' + W(0); // referralOwed
      case '0x2cfc2716': return '0x' + Buffer.from('mockname').toString('hex').padEnd(64, '0'); // codeOf: a name already set
      case '0x2cf003c2': return '0x' + W(0); // referrer
      case '0xcaeacdb9': return '0x' + (this.landed ? playerView({ dep: 25_000n * U, earned: 0n }) : playerView({ dep: 0n, earned: 0n })); // playerView: in with 25k once the deposit landed
      case '0x8820a363': return '0x' + arr([2]); // roundsOf
      case '0x11ad2f34': { // codeOwner(bytes32): "alice" is registered, anything else is not
        const code = Buffer.from(data.slice(10, 74), 'hex').toString('utf8').replace(/\0+$/, '');
        return '0x' + (code === 'alice' ? WA(P[1].a) : W(0));
      }
      case '0x8a19c8bc': return '0x' + W(3) + W(closesAt) + W(1) + W(now); // currentRound (+ chain clock)
      case '0x127f0b3f': return '0x' + W(3);
      case '0x48fe7e53': return '0x' + knobs;
      case '0x925e2416': return '0x' + W(300);
      case '0xf0c0f269': return '0x' + arr([1]); // dueForDraw
      case '0xf36ea453': return '0x' + arr([3, 2, 1]);
      case '0xdb5b4737': return '0x' + (ROUNDS[Number(BigInt('0x' + data.slice(10, 74)))] || W(0).repeat(20));
      case '0xa537f3c9': return '0x' + W(this.landed ? 6 : 5);
      case '0x1f5053a1': { // players(): (address[], PlayerView[])
        const addrs = W(P.length) + P.map((p) => WA(p.a)).join('');
        const views = W(P.length) + P.map(playerView).join('');
        return '0x' + W(64) + W(64 + addrs.length / 2) + addrs + views;
      }
      case '0x0f430645': { // deposits()
        const ds = [[P[0].a, 100_000n * U, now - 7200], [P[1].a, 100_000n * U, now - 3000], [P[2].a, 40_000n * U, now - 900], [P[0].a, 150_000n * U, now - 300]];
        return '0x' + W(32) + W(ds.length) + ds.map(([a, amt, at]) => WA(a) + W(amt) + W(at)).join('');
      }
      // an unknown selector is a page bug (a missing SEL entry reads "undefined0000…"):
      // answer with an rpc error so the page visibly fails instead of quietly rendering zeros
      default: throw new Error(`unknown selector ${sel} to ${to} (data ${data.slice(0, 20)}…)`);
    }
  } };
}

mkdirSync(path.join(ROOT, 'test/ui/shots'), { recursive: true });
const PORT = 18951 + Math.floor(Math.random() * 10);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', path.join(ROOT, 'docs')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const shot = (name) => path.join(ROOT, 'test/ui/shots', name);

/// a page wired to the fixture: the wallet (EIP-6963, one or two), the config rewrite, the mocked rpc and price
async function open(label, width, height, fx, cfgPatch, opts = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [], unknown = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning') console.log('   page warning:', m.text().slice(0, 300)); });
  await page.addInitScript(({ ME, TWO }) => {
    const post = async (method, params) => { const j = await (await fetch('https://rpc.mainnet.chain.robinhood.com/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
    const provider = { isMetaMask: true, request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ME];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_sendTransaction') { (window.__SENT = window.__SENT || []).push(params[0]); return '0x' + '11'.repeat(32); }
      if (method === 'wallet_revokePermissions') { window.__REVOKED = (window.__REVOKED || 0) + 1; return null; }
      return post(method, params);
    }, on() {}, removeListener() {} };
    const info = { uuid: 'mock-0001-0000-0000-000000000000', name: 'Mock', icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>', rdns: 'mock.wallet' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce); announce();
    if (TWO) { // a Phantom-like second wallet: on chain 0x1, refuses to switch, cannot add the chain
      const phantom = { ...provider, request: async ({ method, params }) => { if (method === 'eth_chainId') return '0x1'; if (method === 'wallet_switchEthereumChain') { const e = new Error('unrecognized chain'); e.code = 4902; throw e; } if (method === 'wallet_addEthereumChain') { const e = new Error('not supported'); e.code = 4001; throw e; } return provider.request({ method, params }); } };
      const info2 = { uuid: 'mock-0002-0000-0000-000000000000', name: 'Phantom', icon: info.icon, rdns: 'mock.phantom' }; const a2 = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: info2, provider: phantom }) })); window.addEventListener('eip6963:requestProvider', a2); a2(); }
  }, { ME, TWO: !!opts.two });
  await page.route('**/pool-config.js*', async (route) => {
    const res = await fetch(`http://localhost:${PORT}/pool-config.js`);
    let body = await res.text();
    if (!/\bpool:\s*"[^"]*"/.test(body)) throw new Error('pool-config.js has no pool key');
    body = body.replace(/\bpool:\s*"[^"]*"/, `pool: "${cfgPatch.pool === undefined ? POOL : cfgPatch.pool}"`);
    if (cfgPatch.decimals !== undefined) body = body.replace(/\bdecimals:\s*\d+/, `decimals: ${cfgPatch.decimals}`);
    if (cfgPatch.symbol !== undefined) body = body.replace(/\bsymbol:\s*"[^"]*"/, `symbol: "${cfgPatch.symbol}"`);
    if ((body.match(/\bpool:\s*"/g) || []).length !== 1) throw new Error('config rewrite: pool key count != 1');
    route.fulfill({ body, contentType: 'application/javascript' });
  });
  await page.route(/rpc\.mainnet\.chain\.robinhood\.com|robinhood-rpc\.publicnode\.com/, async (route) => {
    const req = route.request();
    let body; try { body = JSON.parse(req.postData() || 'null'); } catch (e) { body = null; }
    const one = (m) => {
      if (!m) return null;
      if (m.method === 'eth_call') {
        try { return { jsonrpc: '2.0', id: m.id, result: fx.answer(m.params[0].to, m.params[0].data) }; }
        catch (e) { unknown.push(e.message); return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e.message } }; }
      }
      if (m.method === 'eth_blockNumber') { fx.lag = (fx.lag || 0) + 1; return { jsonrpc: '2.0', id: m.id, result: fx.landed && fx.lag <= 2 ? '0x61' : '0x64' }; } // 97 twice, then 100: a replica behind the receipt
      if (m.method === 'eth_getTransactionReceipt') { fx.landed = true; fx.lag = 0; return { jsonrpc: '2.0', id: m.id, result: { status: '0x1', blockNumber: '0x64', transactionHash: m.params[0], gasUsed: '0x1', logs: [] } }; }
      if (m.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: m.id, result: '0x5f5e100' };
      if (m.method === 'eth_estimateGas') return { jsonrpc: '2.0', id: m.id, result: '0x6a9c0' }; // 436,672: a first-of-the-day deposit
      if (m.method === 'eth_chainId') return { jsonrpc: '2.0', id: m.id, result: '0x1237' };
      unknown.push('method ' + m.method);
      return { jsonrpc: '2.0', id: m.id, result: '0x' };
    };
    const out = Array.isArray(body) ? body.map(one) : one(body);
    route.fulfill({ body: JSON.stringify(out), contentType: 'application/json' });
  });
  // the ledger's live price (app.js, light mode): a fixed $0.0084 so the ≈USD line is deterministic
  await page.route(/api\.dexscreener\.com/, (route) => route.fulfill({ body: JSON.stringify({ pairs: [{ priceUsd: '0.0084', priceNative: '0.0000034', priceChange: { h24: 1.5 }, liquidity: { usd: 1000000 }, volume: { h24: 2000000 } }] }), contentType: 'application/json' }));
  await page.route('**/pond?*', async (route) => { const r = await fetch(`http://localhost:${PORT}/pond.html`); route.fulfill({ body: await r.text(), contentType: 'text/html' }); }); // the python server has no extensionless routing; Pages does
  await page.goto(`http://localhost:${PORT}/${opts.old ? 'pool.html' : 'pond.html'}${opts.query || ''}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const text = async () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  return { page, errors, unknown, text };
}

try {
  const fx = fixture(18, 'FRONG');
  // ---------------------------------------------------------------- desk 1280×900
  {
    const { page, errors, unknown, text } = await open('desk', 1280, 900, fx, {}, { query: '?ref=alice' });
    const t = await text();
    if (unknown.length) console.log('   unknown selectors:', unknown.slice(0, 3).join(' | '));
    ok('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
    if (errors.length || !/TODAY'S POND/.test(t)) console.log('TEXT:', t.slice(0, 700));
    ok("the board shows today's pond in FRONG", /TODAY'S POND 294k FRONG/.test(t), (t.match(/TODAY'S POND [^·]*/) || [''])[0]);
    ok('pond page: no tip button and no tip-jar dialog', !(await page.$('#tipbtn')) && !(await page.$('#tipjar')));
    ok('the ≈USD line comes from the price hook (294k × $0.0084)', /≈ \$2,470/.test(t), (t.match(/≈ \$[0-9,]+/) || ['(none)'])[0]);
    ok('one line under the jackpot says what the game is, and the page never mentions the house cut', /toss a frong in before the \d+:\d\d [AP]M New York croak · one takes the pond, one gets their frongs back/.test(t) && !/house/i.test(t.replace(/HOUSE RULES/, '')), (t.match(/toss a frong in before[^·]*·[^·]*/) || [''])[0]);
    ok('arriving with a REGISTERED ?ref= shows the sender before connecting', /sent by alice/.test(t), (t.match(/sent by [^ ]*/) || ['(none)'])[0]);
    ok('the seed and the players are on the board', /3 players · 390k in · 50k seeded/.test(t));
    ok('the countdown runs', /CROAKS IN 3:1\d:\d\d/.test(t), (t.match(/CROAKS IN [0-9:]+/) || [''])[0]);
    ok('the bell is offered for the due round, named by its day', /a pond \(Sep \d+, [^)]*\) is waiting for its draw/.test(t) && /MAKE IT CROAK/.test(t), (t.match(/THE CROAK [^.]*\./) || [''])[0]);
    ok("the results banner: jackpot first, money back second, from today's draw", /🔔 today: pond 160k → 0x0000…0ffe · frongs back 100k → 0x2222…2222/.test(t), (t.match(/🔔[^C]{0,120}/) || [''])[0]);
    ok('no wallet: the desk offers CONNECT WALLET', /CONNECT WALLET/.test(t) && !/CHIP IN\b.*balance/.test(t));
    ok('the leaderboard ranks by deposit with dividends earned, no broker column', /1\. 0x1111…1111 250k · earned 41\.3k/.test(t) && !/brokers/.test(t), (t.match(/1\. [^2]*/) || [''])[0].slice(0, 80));
    ok('the feed shows the last deposits newest first', /JUST NOW 0x1111…1111 tossed 150k 5m ago/.test(t));
    ok('past pools: jackpot headlined, money back second, beacon link', /· 4 players pond 160k → 0x0000…0ffe frongs back 100k → 0x2222…2222 beacon 31921200/.test(t), (t.match(/PAST PONDS.{0,140}/) || [''])[0]);
    ok('past ponds: the due round says it is waiting', /waiting for its croak/.test(t));
    ok('the rules quote the live terms and the minimum, with no boost line', /at least 500 a toss/.test(t) && /25%.*everyone already in that day/.test(t) && !/boost/.test(t), (t.match(/HOUSE RULES.{0,120}/) || [''])[0]);
    ok('the beacon link goes to api.drand.sh', (await page.$eval('.hist a[href*="drand"]', (a) => a.href)) === 'https://api.drand.sh/v2/beacons/quicknet/rounds/31921200');
    ok('RING THE BELL is disabled until a wallet is connected', await page.$eval('[data-act=bell]', (b) => b.disabled));
    ok('the winners tape shows once a pool has been drawn', !!(await page.$('.op-ticker')));
    // the format helpers on real-world sizes
    const f = await page.evaluate(() => { const P = window.__POOL; return [P.fmt(10n ** 30n), P.fmt(1234567n * 10n ** 18n), P.fmt(500n * 10n ** 18n), P.fmt(12345n * 10n ** 18n), P.fmt(5n * 10n ** 17n), P.fmtExact(500n * 10n ** 18n), P.fmtExact(1234n * 10n ** 18n + 5n * 10n ** 17n), String(P.parseAmount('2.5k')), String(P.parseAmount('12,345.5')), String(P.parseAmount('abc'))]; });
    ok('fmt survives a 1e30-wei pot and small amounts: ' + f.slice(0, 5).join(' '), f[0] === '1T' && f[1] === '1.23M' && f[2] === '500' && f[3] === '12.3k' && f[4] === '0.5');
    ok('fmtExact and parseAmount round-trip: ' + f.slice(5).join(' '), f[5] === '500' && f[6] === '1,234.5' && f[7] === '2500000000000000000000' && f[8] === '12345500000000000000000' && f[9] === 'null');
    await page.screenshot({ path: shot('pool-desk-900.png'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
    // CONNECT: the connected batch (claimable, referral, code, referrer, balance, allowance, playerView) must decode
    await page.locator('[data-act=connect]').click();
    await page.waitForTimeout(2500);
    const t2 = await text();
    ok('connected: no unknown selector reached the rpc', unknown.length === 0, unknown.join(' | ').slice(0, 200));
    const toastNow = await page.evaluate(() => document.getElementById('op-toast').textContent);
    ok('connected: the "opening your wallet…" toast is replaced by "connected · 0x…"', /^connected · 0x0000…0ffe$/.test(toastNow), toastNow);
    ok('connected: the desk shows the balance and the wallet', /balance 100k FRONG · 0x0000…0ffe · sent by alice/.test(t2), (t2.match(/balance [^·]*· 0x[^ ]* · [^ ]* [^ ]*/) || [''])[0]);
    ok('connected: YOU took the jackpot in the banner, and a CLAIM for the dividends', /YOU took the pond: 160k FRONG/.test(t2) && /you have 4,200 in dividends to claim/.test(t2), (t2.match(/YOU took[^·]*/) || [''])[0]);
    ok('connected: a known link code needs no sender field', !(await page.$('#op-ref')));
    ok('connected: dividends to claim are shown with a live CLAIM', /dividends 4,200/.test(t2) && await page.$eval('[data-act=claimdiv]', (b) => !b.disabled));
    ok('connected: the link shows with COPY, POST ON X and SHARE ON TELEGRAM', /YOUR LINK/.test(t2) && /\?ref=mockname/.test(t2) && /POST ON X/.test(t2) && /SHARE ON TELEGRAM/.test(t2));
    const xHref = await page.$eval('.ref a[href*="x.com"]', (a) => decodeURIComponent(a.href));
    ok('the X post carries the jackpot and the clean page link', /294k FRONG pond/.test(xHref) && /\/pond\?ref=mockname/.test(xHref) && !/\.html/.test(xHref), xHref.slice(0, 160));
    ok('connected: the bell button is live', await page.$eval('[data-act=bell]', (b) => !b.disabled));
    ok('the presets are the config\'s, in whole tokens', (await page.$$eval('.presets .chip', (bs) => bs.map((b) => b.textContent).join('|'))) === 'MIN|1k|2.5k|5k|10k|25k|MAX');
    await page.locator('[data-act=min]').click();
    ok('MIN fills the exact minimum', (await page.inputValue('#op-amt')) === '500');
    await page.screenshot({ path: shot('pool-desk-connected.png'), fullPage: true });
    // typing survives a re-render
    await page.fill('#op-amt', '25,000');
    await page.waitForTimeout(POLL_WAIT);
    ok('what is typed survives the poll re-render', (await page.inputValue('#op-amt')) === '25,000');
    // a HUMAN click: mouse down, a beat, mouse up — with the amount box still focused from typing
    await page.locator('[data-act=chip]').scrollIntoViewIfNeeded();
    const chipBox = await page.locator('[data-act=chip]').boundingBox();
    await page.locator('#op-amt').focus();
    await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(180);
    await page.mouse.up();
    await page.waitForTimeout(6000);
    const sentTx = await page.evaluate(() => window.__SENT || []);
    ok('ONE slow click on CHIP IN with the amount box focused is enough', sentTx.length >= 1, `${sentTx.length} tx after one click · toast: ` + (await page.evaluate(() => (document.getElementById('op-toast') || {}).textContent)));
    ok('CHIP IN below the allowance sends the approval first (max allowance to the pool)', sentTx.length >= 1 && sentTx[0].to.toLowerCase() === TOKEN.toLowerCase() && sentTx[0].data === '0x095ea7b3' + WA(POOL) + 'f'.repeat(64), sentTx.map((x) => x.data.slice(0, 10)).join(','));
    const want = '0xb927dab6' + W(25_000n * 10n ** 18n) + W(96) + Buffer.from('alice').toString('hex').padEnd(64, '0') + W(0);
    ok('…and goes straight on to deposit(25,000, [], "alice") with the exact calldata', sentTx.length >= 2 && sentTx[1].to.toLowerCase() === POOL.toLowerCase() && sentTx[1].data === want, sentTx[1] ? sentTx[1].data.slice(0, 74) : '(no second tx)');
    ok('the deposit gas is the estimate +25% (436,672 → 545,840), with a fee ceiling from the node price', sentTx.length >= 2 && parseInt(sentTx[1].gas, 16) === 545840 && sentTx[1].maxFeePerGas === '0x' + ((100000000n * 5n) / 4n).toString(16), sentTx[1] ? `gas ${parseInt(sentTx[1].gas, 16)} maxFee ${sentTx[1].maxFeePerGas}` : '');
    const t3b = await text();
    ok('the deposit shows on the desk right after the receipt — the page waited for OUR rpc to reach the receipt block (97, 97, then 100), no idle poll needed', /you're in with 25k/.test(t3b) && /YOU TODAY 25k FRONG/.test(t3b), (t3b.match(/you're in[^·]*/) || ['(not shown)'])[0] + ` · blockNumber polls ${fx.lag}`);
    await page.close();
  }
  // ---------------------------------------------------------------- short desk 1280×700 / 1280×640
  for (const h of [700, 640]) {
    const { page, errors } = await open('short', 1280, h, fx, {}, { two: h === 640 });
    ok(`short desktop window 1280×${h}: CONNECT WALLET starts inside the first screen`, (await page.$eval('[data-act=connect]', (b) => b.getBoundingClientRect().bottom)) <= h, 'bottom ' + (await page.$eval('[data-act=connect]', (b) => Math.round(b.getBoundingClientRect().bottom))));
    ok(`1280×${h}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    await page.screenshot({ path: shot(`pool-desk-${h}.png`), clip: { x: 0, y: 0, width: 1280, height: h } });
    if (h === 640) {
      // two wallets installed: CONNECT must turn into two big, obvious choices, and one click on a choice connects
      await page.locator('[data-act=connect]').click();
      await page.waitForTimeout(800);
      const choices = await page.$$eval('.go[data-act=wallet]', (bs) => bs.map((b) => b.textContent));
      ok('two wallets: CONNECT offers one big button per wallet', choices.length === 2 && /MOCK/.test(choices[0]) && /PHANTOM/.test(choices[1]), choices.join(' | '));
      // the wallet that cannot be on Robinhood Chain never looks connected: the desk says so and offers SWITCH WALLET
      await page.locator('.go[data-act=wallet]').nth(1).click();
      await page.waitForTimeout(1500);
      const t4 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
      ok('a wallet stuck on another chain: no balance line, a plain reason, SWITCH WALLET offered', !/balance 100k/.test(t4) && /cannot switch to Robinhood Chain/.test(t4) && !!(await page.$('[data-act=switch]')), (t4.match(/that wallet[^—]*—[^.]*/) || ['(none)'])[0]);
      ok('…and the toast names MetaMask', /try MetaMask/.test(await page.evaluate(() => document.getElementById('op-toast').textContent)));
      await page.locator('[data-act=switch]').click();
      await page.waitForTimeout(800);
      ok('SWITCH WALLET forgets the pick and shows the picker again', (await page.evaluate(() => localStorage.getItem('pool.wallet.v1'))) === null && (await page.$$('.go[data-act=wallet]')).length === 2);
      await page.locator('.go[data-act=wallet]').first().click();
      ok('picking the right one connects', await (async () => { for (let i = 0; i < 20; i++) { if (/balance 100k FRONG/.test(await page.evaluate(() => document.body.innerText))) return true; await page.waitForTimeout(300); } return false; })());
      ok('the remembered wallet is the picked one, and the desk carries SWITCH WALLET next to the balance', (await page.evaluate(() => localStorage.getItem('pool.wallet.v1'))) === 'mock.wallet' && !!(await page.$('.desk .chip.mini[data-act=switch]')));
      await page.locator('.desk .chip.mini[data-act=switch]').click();
      await page.waitForTimeout(800);
      ok('connected → SWITCH WALLET: forgotten again, picker back', (await page.evaluate(() => localStorage.getItem('pool.wallet.v1'))) === null && (await page.$$('.go[data-act=wallet]')).length === 2);
      await page.locator('.go[data-act=wallet]').first().click();
      await page.waitForTimeout(1500);
      await page.locator('.desk .chip.mini[data-act=disconnect]').click();
      await page.waitForTimeout(800);
      const t5 = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
      ok('DISCONNECT: back to CONNECT WALLET, nothing remembered, no balance line, no picker', /CONNECT WALLET/.test(t5) && !/balance 100k/.test(t5) && (await page.evaluate(() => localStorage.getItem('pool.wallet.v1'))) === null && (await page.$$('.go[data-act=wallet]')).length === 0, t5.match(/CHIP IN [^·]{0,60}/)?.[0]);
      ok('DISCONNECT asked the wallet to revoke permissions (best effort)', (await page.evaluate(() => (window.__REVOKED || 0))) >= 1);
    }
    await page.close();
  }
  // ---------------------------------------------------------------- phone 390×844
  {
    const { page, errors, text } = await open('phone', 390, 844, fx, {}, { query: '?ref=alicee' });
    const t = await text();
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    ok('phone 390px: no sideways overflow', sw <= 390, `scrollWidth ${sw}`);
    ok('phone: no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    ok('phone still shows the pond and the desk', /TODAY'S POND/.test(t) && /CONNECT WALLET/.test(t));
    ok('an unregistered ?ref= is called out, not shown as a sender', /link code 'alicee' is not registered/.test(t) && !/sent by alicee/.test(t), (t.match(/link code[^·]*·[^.]*/) || ['(none)'])[0]);
    ok('phone: CONNECT WALLET sits inside the first screen with room', (await page.$eval('[data-act=connect]', (b) => b.getBoundingClientRect().bottom)) < 844 - 40, 'bottom ' + (await page.$eval('[data-act=connect]', (b) => Math.round(b.getBoundingClientRect().bottom))));
    await page.screenshot({ path: shot('pool-phone-844.png'), clip: { x: 0, y: 0, width: 390, height: 844 } });
    await page.screenshot({ path: shot('pool-phone-full.png'), fullPage: true });
    await page.close();
  }
  // ---------------------------------------------------------------- a 6-decimal token
  {
    const fx6 = fixture(6, 'USDX');
    const { page, errors, text } = await open('six', 1280, 900, fx6, { decimals: 6, symbol: 'USDX' });
    const t = await text();
    ok('6 decimals: no page errors', errors.length === 0, errors.join(' | ').slice(0, 200));
    ok('6 decimals: the jackpot and the minimum read the same', /TODAY'S POND 294k USDX/.test(t) && /at least 500 a toss/.test(t), (t.match(/TODAY'S POND [^·]*/) || [''])[0]);
    await page.locator('[data-act=connect]').click();
    await page.waitForTimeout(2000);
    await page.locator('[data-act=min]').click();
    ok('6 decimals: MIN fills 500 and balance reads 100k', (await page.inputValue('#op-amt')) === '500' && /balance 100k USDX/.test(await text()));
    const p = await page.evaluate(() => String(window.__POOL.parseAmount('2.5k')));
    ok('6 decimals: parseAmount("2.5k") = 2500e6', p === '2500000000', p);
    await page.close();
  }
  // ---------------------------------------------------------------- decimals mismatch: the desk closes
  {
    const { page, text } = await open('mismatch', 1280, 900, fixture(6, 'FRONG'), {});
    const t = await text();
    ok('config 18 vs chain 6: the desk is closed with the reason, no CONNECT, no CHIP IN', /configured for FRONG with 18 decimals, the chain says 6/.test(t) && !/CONNECT WALLET/.test(t) && !/CHIP IN\b/.test(t.replace(/CHIP IN\s*this/, '')), (t.match(/configured for[^:]*/) || ['(none)'])[0]);
    await page.close();
  }
  // ---------------------------------------------------------------- the rest of the site: nav tab + hero jackpot
  for (const file of ['index.html', 'ledger.html', 'memes.html']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/pool-config.js*', async (route) => { const res = await fetch(`http://localhost:${PORT}/pool-config.js`); route.fulfill({ body: (await res.text()).replace(/\bpool:\s*"[^"]*"/, `pool: "${POOL}"`), contentType: 'application/javascript' }); });
    await page.route(/rpc\.mainnet\.chain\.robinhood\.com|robinhood-rpc\.publicnode\.com/, async (route) => {
      let body; try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) { body = null; }
      const one = (m) => { try { return { jsonrpc: '2.0', id: m.id, result: fx.answer(m.params[0].to, m.params[0].data) }; } catch (e) { return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e.message } }; } };
      route.fulfill({ body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), contentType: 'application/json' });
    });
    await page.route(/api\.dexscreener\.com/, (route) => route.fulfill({ body: JSON.stringify({ pairs: [{ priceUsd: '0.0084', priceNative: '0.0000034', priceChange: { h24: 1.5 }, liquidity: { usd: 1000000 }, volume: { h24: 2000000 } }] }), contentType: 'application/json' }));
    await page.route(/blockscout\.com|geckoterminal|dexscreener\.com\/(?!latest)/, (route) => route.fulfill({ body: '{}', contentType: 'application/json' }));
    await page.goto(`http://localhost:${PORT}/${file}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    ok(`${file}: no page errors`, errors.length === 0, errors.join(' | ').slice(0, 200));
    ok(`${file}: no tip button and no tip-jar dialog`, !(await page.$('#tipbtn')) && !(await page.$('#tipjar')) && !(await page.$('#tipline')));
    ok(`${file}: the nav has a POOL tab linking to pool.html`, (await page.$eval('.tabbar a[href="/pond"]', (a) => a.textContent.trim())) === '🎰 The Pond ↗');
    const htmlHrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /\.html/.test(h) && !/^https?:/.test(h)));
    ok(`${file}: no internal link carries .html`, htmlHrefs.length === 0, htmlHrefs.join(' '));
    if (file === 'index.html') {
      const jp = await page.$eval('#herojackpot', (a) => ({ hidden: a.hidden, text: a.innerText.replace(/\s+/g, ' '), href: a.getAttribute('href'), w: a.getBoundingClientRect().width, bottom: Math.round(a.getBoundingClientRect().bottom) }));
      ok('index hero: the Pond is the one primary CTA, full width, with the live pot', !jp.hidden && /TODAY'S POND: 294k FRONG — TOSS A FRONG BEFORE THE 4 PM NY CROAK/i.test(jp.text) && jp.href === '/pond' && jp.w > 1000, jp.text + ` w${Math.round(jp.w)}`);
      const primaries = await page.$$eval('.hero-overlay .btn:not(.hero-alt)', (bs) => bs.map((b) => b.getAttribute('href') || b.tagName));
      ok('index hero: exactly one primary button, and it links /pond; the other two are secondaries', primaries.length === 1 && primaries[0] === '/pond' && (await page.$$('.herosec .btn.hero-alt')).length === 2, primaries.join(','));
      ok('index hero: the Pond CTA is inside the first screen at 1280×900', jp.bottom <= 900, 'bottom ' + jp.bottom);
      await page.screenshot({ path: shot('index-hero.png'), clip: { x: 0, y: 0, width: 1280, height: 900 } });
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(600);
      const jpm = await page.$eval('#herojackpot', (a) => ({ w: Math.round(a.getBoundingClientRect().width), bottom: Math.round(a.getBoundingClientRect().bottom) }));
      ok('index hero on a phone: the Pond CTA is full width and inside the first screen', jpm.w >= 340 && jpm.bottom <= 844, JSON.stringify(jpm));
      await page.screenshot({ path: shot('index-hero-phone.png'), clip: { x: 0, y: 0, width: 390, height: 844 } });
    }
    await page.close();
  }
  // ---------------------------------------------------------------- an old .html link: the address bar is cleaned, the ref survives
  {
    const { page } = await open('clean', 1000, 700, fx, {}, { query: '?ref=abc', old: true });
    const loc = await page.evaluate(() => ({ p: location.pathname, s: location.search }));
    ok('arriving at the old /pool.html?ref=abc lands on /pond?ref=abc with the ref intact', loc.p === '/pond' && loc.s === '?ref=abc', JSON.stringify(loc));
    const htmlHrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter((h) => /\.html/.test(h) && !/^https?:/.test(h)));
    ok('pond page: no internal link carries .html', htmlHrefs.length === 0, htmlHrefs.join(' '));
    await page.close();
  }
  // ---------------------------------------------------------------- the inert state: no pool in config
  {
    const { page, text } = await open('inert', 1000, 700, fx, { pool: '' });
    const t = await text();
    ok('without POOL_CFG.pool the page says it has not opened and asks nothing', /has not opened yet/.test(t) && !/CONNECT WALLET/.test(t));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall good');
process.exit(fails ? 1 : 0);
