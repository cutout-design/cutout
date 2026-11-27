// Runs Cutout's tests: starts the app (tests/harness.js), drives it over the DevTools protocol, prints
// every check and exits with 1 if any failed. Usage: npm test   (or: node tests/run.mjs [suite...])
//
// Page suites (tests/page/*.js) each define window.<name>() returning ['PASS  …' | 'FAIL  …', …];
// they work on made-up images only. tests/a11y.mjs sends real key and mouse input instead.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electron = createRequire(import.meta.url)('electron'); // the path to the Electron binary
const PAGE_SUITES = [ // file → the function it defines; saveTests first (it expects a document never saved)
  ['save-tests.js', 'saveTests'], ['app-tests.js', 'appTests'], ['clip-tests.js', 'clipTests'],
  ['shrink-tests.js', 'shrinkTests'], ['scan-tests.js', 'scanTests'], ['fill-tests.js', 'fillTests'],
  ['seam-tests.js', 'seamTests'], ['layer-sel-tests.js', 'layerSelTests'], ['review-tests.js', 'reviewTests'],
  ['more-tests.js', 'moreTests'],
];
const only = process.argv.slice(2);
const wanted = name => !only.length || only.some(o => name.toLowerCase().includes(o.toLowerCase()));

const port = 9400 + Math.floor(Math.random() * 400);
const args = [path.join(here, 'harness.js'), `--remote-debugging-port=${port}`];
if (process.platform === 'linux') args.push('--no-sandbox'); // CI containers have no setuid sandbox
const app = spawn(electron, args, { cwd: path.join(here, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
let appErr = '';
app.stderr.on('data', d => { appErr += d; });

const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0, passed = 0, ws;
try {
  // the app's page, once it's up
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) { /* not yet */ }
    if (!page) await wait(300);
  }
  if (!page) throw new Error('Cutout did not start' + (appErr ? `:\n${appErr.slice(-2000)}` : ''));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', no); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    return r.result.result.value;
  };
  await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (let i = 0; i < 50 && !(await ev('!!window.Cutout').catch(() => false)); i++) await wait(200);
  await wait(1200); // the Smart fill worker warms up at idle after launch

  const report = (name, out) => {
    const lines = Array.isArray(out) ? out : String(out ?? '').split('\n').filter(Boolean); // some suites return one text block
    console.log(`\n== ${name}`);
    for (const l of lines) {
      if (l.startsWith('FAIL')) { failed++; console.log(l); } else if (l.startsWith('PASS')) { passed++; if (process.env.VERBOSE) console.log(l); } else console.log(l);
    }
    console.log(`   ${lines.filter(l => l.startsWith('PASS')).length} passed, ${lines.filter(l => l.startsWith('FAIL')).length} failed`);
  };
  for (const [file, fn] of PAGE_SUITES) {
    if (!wanted(fn)) continue;
    try {
      await ev(fs.readFileSync(path.join(here, 'page', file), 'utf8'));
      report(fn, await ev(`${fn}()`));
    } catch (e) { report(fn, [`FAIL  the suite stopped: ${e.message}`]); }
  }
  if (wanted('figma')) {
    try {
      const figma = (await import('./figma.mjs')).default;
      report('figma paste (copies built from scratch)', await figma({ ev, wait }));
    } catch (e) { report('figma', [`FAIL  the suite stopped: ${e.message}`]); }
  }
  if (wanted('a11y')) {
    try {
      const a11y = (await import('./a11y.mjs')).default;
      report('a11y (real key and mouse input)', await a11y({ send, ev, wait }));
    } catch (e) { report('a11y', [`FAIL  the suite stopped: ${e.message}`]); }
  }
  if (wanted('updates')) { // starts a Cutout of its own, with a local update server
    try {
      const updates = (await import('./updates.mjs')).default;
      report('updates (local update server)', await updates({ electron, here, wait }));
    } catch (e) { report('updates', [`FAIL  the suite stopped: ${e.message}`]); }
  }
} catch (e) {
  failed++; console.error(e.message);
} finally {
  try { ws && ws.close(); } catch (_) { /* closed */ }
  app.kill();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
