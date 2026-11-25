// Extra spec checks for ARENA-TMA-01 (beyond bench/tma-01/verify_tma01.mjs).
// Zero dependencies: Node 22+ (built-in WebSocket) + headless Chromium over CDP.
// usage: CHROMIUM_BIN=/usr/bin/chromium node tests/spec_check.mjs [gameDir]
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
const dir = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'));
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
const lines = []; let fails = 0;
const ok = (name, pass, info) => { lines.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); if (!pass) fails++; };

function walk(root, rel = '') { const out = []; for (const e of readdirSync(join(root, rel), { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const p = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) out.push(...walk(root, p)); else out.push(p); } return out; }
const allFiles = walk(dir);
const allBytes = allFiles.reduce((s, f) => s + statSync(join(dir, f)).size, 0);
const bundle = allFiles.filter(f => !f.startsWith('tests/') && /\.(html|js|mjs|css|wasm|json|svg)$/i.test(f));
let total = 0; const h = createHash('sha256');
for (const f of bundle.sort()) { const b = readFileSync(join(dir, f)); total += b.length; h.update(b); }
const src = bundle.map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
ok('game bundle <= 262144 bytes', total <= 262144, `game_bytes=${total} files=${bundle.join(',')}`);
ok('whole folder (as walked by verify_tma01) <= 262144 bytes', allBytes <= 262144, `folder_bytes=${allBytes} files=${allFiles.length}`);
const everything = allFiles.filter(f => /\.(html|js|mjs|css|json|svg)$/i.test(f)).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
ok('zero http(s) URLs in any scanned file of the folder', !/https?:\/\//i.test(everything));
ok('zero http(s) URL strings in game bundle', !/https?:\/\//i.test(src), `matches=${(src.match(/https?:\/\//gi) || []).length}`);
ok('no Math.random anywhere', !/Math\s*\.\s*random/.test(src));
ok('no external audio/image files, WebAudio synth present', !/\.(mp3|ogg|wav|m4a|png|jpg)\b/i.test(src) && /createOscillator/.test(src) && /createBiquadFilter/.test(src));
ok('no fetch/XHR/WebSocket/import()', !/\bfetch\(|XMLHttpRequest|WebSocket|import\(/.test(src));


// ---- minimal CDP page driver
const reqs = [];
async function launch() {
  const profile = `/tmp/tma01-spec-${process.pid}-${Date.now()}`;
  mkdirSync(profile, { recursive: true });
  const proc = spawn(CHROMIUM_BIN, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-background-networking',
    '--hide-scrollbars', '--window-size=390,844', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let err = ''; const t = setTimeout(() => rej(new Error('chromium_start_timeout')), 15000);
    proc.stderr.on('data', c => { err += c; const m = err.match(/DevTools listening on (ws:[^\s]+)/); if (m) { clearTimeout(t); res(m[1]); } });
    proc.on('exit', c => { clearTimeout(t); rej(new Error('chromium_exited:' + c)); });
  });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    const list = await (await fetch(wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*/, '/json/list'))).json();
    target = list.find(t => t.type === 'page');
    if (!target) await new Promise(r => setTimeout(r, 50));
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    else if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (!/^(file|data|about):/.test(u)) reqs.push(u); }
    else if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const page = {
    errs,
    async goto(url) { const t0 = Date.now(); await send('Page.navigate', { url });
      for (let i = 0; i < 100; i++) { const r = await send('Runtime.evaluate', { expression: 'document.readyState==="complete" && !!window.__GAME', returnByValue: true }); if (r.result.value) break; await new Promise(r => setTimeout(r, 20)); }
      page.loadMs = Date.now() - t0; },
    async evaluate(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    async close() { ws.close(); proc.kill('SIGKILL'); rmSync(profile, { recursive: true, force: true }); },
  };
  return page;
}
async function fresh() { const p = await launch(); await p.goto(pathToFileURL(join(dir, 'index.html')).href); return p; }
const BOT = `(seed, maxT, opts) => {
  const g = window.__GAME; g.noDraw = !!opts.noDraw; g.reset(seed);
  let s = seed * 7 + 1; const r = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  const hash = []; const phases = {}; let t = 0, sawRevive = false, sawOverAfterRevive = false, draftCards = 0, maxWave = 1;
  while (t < maxT) {
    const st = g.state(); phases[st.phase] = (phases[st.phase] || 0) + 1; maxWave = Math.max(maxWave, st.wave);
    if (st.phase === 'draft' && st.cards.length === 3) draftCards++;
    if (st.game_over) { if (sawRevive) sawOverAfterRevive = true; if (opts.stopOnOver) break; }
    if (st.awaiting_revive) sawRevive = true;
    let inp;
    if (st.phase === 'aim') { const x = .05 + .9 * r(), y = .2 + .45 * r(); for (let k = 0; k < 3; k++) { g.step(16.6667, { x, y, down: true, tap: false, choice: null }); t++; } inp = { x, y, down: false, tap: false, choice: null }; }
    else if (st.phase === 'draft') inp = { x: .5, y: .5, down: false, tap: false, choice: Math.floor(r() * 3) };
    else if (st.phase === 'awaiting_revive') inp = { x: .5, y: .6, down: false, tap: !!opts.revive, choice: null };
    else inp = { x: .5, y: .5, down: false, tap: false, choice: null };
    g.step(16.6667, inp); t++;
    if (t % 97 === 0) hash.push(JSON.stringify(g.state()));
  }
  g.noDraw = false;
  return { final: g.state(), hash: hash.join('|'), phases, sawRevive, sawOverAfterRevive, draftCards, maxWave, t };
}`;

{
  const p = await fresh();
  const st = await p.evaluate('window.__GAME.reset(1), window.__GAME.state()');
  const fired = await p.evaluate(`(()=>{const g=window.__GAME; g.reset(1); for(let i=0;i<5;i++) g.step(16.6667,{x:.3,y:.4,down:true}); g.step(16.6667,{x:.3,y:.4,down:false}); for(let i=0;i<20;i++) g.step(16.6667,{x:.3,y:.4}); return g.state();})()`);
  ok('1.5s hook: load < 1500ms, phase=aim at tick 0, drag+release fires within 6 ticks', p.loadMs < 1500 && st.phase === 'aim' && fired.phase === 'fire' && fired.flying > 0, `load=${p.loadMs}ms phase0=${st.phase} after=${fired.phase} flying=${fired.flying}`);
  ok('state() has required keys', ['phase','wave','score','entities','combo','game_over','awaiting_revive'].every(k => k in st), Object.keys(st).join(','));
  ok('no page errors', p.errs.length === 0, p.errs.join(';'));
  await p.close();
}
{
  const hs = [];
  for (let i = 0; i < 3; i++) {
    const p = await fresh();
    const r = await p.evaluate(`(${BOT})(1234, 6000, {revive:true, noDraw:false})`);
    hs.push(createHash('sha256').update(r.hash + JSON.stringify(r.final)).digest('hex'));
    if (i === 0) lines.push(`      det-trace final: ${JSON.stringify(r.final)}`);
    await p.close();
  }
  ok('determinism: 3 fresh page loads, seed=1234, 6000 ticks, identical state hash', hs[0] === hs[1] && hs[1] === hs[2], hs.map(x => x.slice(0, 16)).join(' '));
  lines.push(`      det-trace sha256 ${hs[0]}`);
  const p = await fresh();
  const other = await p.evaluate(`(${BOT})(1235, 6000, {revive:true, noDraw:true})`);
  const ho = createHash('sha256').update(other.hash + JSON.stringify(other.final)).digest('hex');
  ok('different seed -> different trace', ho !== hs[0], 'seed1235=' + ho.slice(0, 16));
  await p.close();
}
{
  const p = await fresh();
  let best = null;
  for (const seed of [2, 3, 5, 8, 13, 21, 34]) {
    const r = await p.evaluate(`(${BOT})(${seed}, 60*60*20, {revive:true, noDraw:true, stopOnOver:true})`);
    if (!best || r.maxWave > best.maxWave) best = { seed, ...r };
    if (r.maxWave >= 11) break;
  }
  ok('3-card draft offered between waves', best.draftCards > 0, `draft frames=${best.draftCards}`);
  ok('random-aim bot reaches wave 10+ (scaling 1..10+)', best.maxWave >= 10, `seed=${best.seed} maxWave=${best.maxWave} score=${best.final.score} balls=${best.final.balls} upgrades=${JSON.stringify(best.final.upgrades)}`);
  let r2 = null;
  for (const seed of [4, 1, 6, 7, 9]) { r2 = await p.evaluate(`(${BOT})(${seed}, 60*60*30, {revive:true, noDraw:true, stopOnOver:true})`); r2.seed = seed; if (r2.sawRevive && r2.sawOverAfterRevive) break; }
  ok('defeat -> awaiting_revive:true -> tap Continue -> later game_over:true', r2.sawRevive && r2.sawOverAfterRevive, `seed=${r2.seed} wave=${r2.maxWave} score=${r2.final.score}`);
  const reach = `const g=window.__GAME; g.noDraw=true; g.reset(4); let s=29; const r=()=>(s=(s*1103515245+12345)>>>0)/4294967296;
    for(let t=0;t<400000;t++){const st=g.state(); if(st.awaiting_revive) break; if(st.phase==='aim'){const x=.05+.9*r(),y=.2+.45*r(); g.step(16.6667,{x,y,down:true}); g.step(16.6667,{x,y,down:false}); continue;} g.step(16.6667,{choice:Math.floor(r()*3)});}`;
  const r3 = await p.evaluate(`(()=>{${reach} const a=g.state(); for(let i=0;i<25;i++) g.step(16.6667,{x:.5,y:.6}); g.step(16.6667,{x:.5,y:.6,tap:true}); const b=g.state(); g.noDraw=false; return [a,b];})()`);
  ok('Continue tap grants shield + row clear', r3[0].awaiting_revive && !r3[1].awaiting_revive && r3[1].shield >= 1 && r3[1].blocks < r3[0].blocks, `blocks ${r3[0].blocks}->${r3[1].blocks} shield=${r3[1].shield} phase=${r3[1].phase}`);
  const r4 = await p.evaluate(`(()=>{${reach} for(let i=0;i<380;i++) g.step(16.6667,{x:.5,y:.5}); const b=g.state(); g.noDraw=false; return b;})()`);
  ok('ignored revive times out to game_over:true', r4.game_over === true && r4.awaiting_revive === false, `phase=${r4.phase}`);
  ok('upgrade pool has split-shot, gravity well, chain arc, pierce, merge multiplier', ['SPLIT SHOT','GRAVITY WELL','CHAIN ARC','PIERCE','MERGE MULTIPLIER'].every(n => src.includes(`'${n}'`)));
  ok('juice present: hit-stop, trauma shake, particles, combo text', /hitStop/.test(src) && /trauma/.test(src) && /function burst/.test(src) && /'COMBO '/.test(src));
  await p.close();
}
{
  const p = await fresh();
  const r = await p.evaluate(`(()=>{const g=window.__GAME; const run=(a)=>{g.reset(42); for(let i=0;i<180;i++){const ph=i%36; g.step(16.6667, a?{x:.2+.6*((i*37%100)/100),y:.72,down:ph<18,tap:ph===18,choice:i%3}:{x:.5,y:.5,down:false,tap:false,choice:null});} return g.state();}; return [run(true), run(false)];})()`);
  ok('input causality: active trace scores, idle does not', r[0].score > 0 && r[1].score === 0, `active=${r[0].score} idle=${r[1].score}`);
  await p.close();
}
ok('zero network requests made by page', reqs.length === 0, reqs.join(','));
lines.push(`bundle_sha256 ${h.digest('hex')}`);
lines.push(fails ? `RESULT FAIL (${fails})` : 'RESULT ALL PASS');
console.log(lines.join('\n'));
process.exit(fails ? 1 : 0);
