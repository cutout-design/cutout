// Update checks (main.js + electron-updater), against a local server that plays GitHub Releases: Cutout
// is started a second time with CUTOUT_UPDATE_CONFIG (an app-update.yml for that server; only read when
// running from source), so a test run never contacts GitHub. Checks what the requests carry, the
// dialogs, Skip This Version and, on Windows, the download. Run by tests/run.mjs (npm test).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function updateTests({ electron, here, wait }) {
  const results = [];
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutout-update-test-'));
  const cacheName = `cutout-test-updater-${process.pid}`;

  // The "release": version 99.0.0 with a small file in place of the installer.
  const file = 'Cutout-99.0.0.exe', bytes = Buffer.from('not really an installer\n'.repeat(500));
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const yml = `version: 99.0.0\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-11-27T00:00:00.000Z'\n`;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (/^\/latest[\w-]*\.yml/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'text/yaml' }); res.end(yml); }
    else if (req.url.startsWith('/' + file) && !req.url.includes('.blockmap')) { res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const config = path.join(tmp, 'app-update.yml');
  fs.writeFileSync(config, `provider: generic\nurl: http://127.0.0.1:${server.address().port}/\nupdaterCacheDirName: ${cacheName}\n`);

  const port = 9800 + Math.floor(Math.random() * 150);
  const args = [path.join(here, 'harness.js'), `--remote-debugging-port=${port}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = spawn(electron, args, { cwd: path.join(here, '..'), stdio: 'ignore', env: { ...process.env, CUTOUT_UPDATE_CONFIG: config } });
  let ws;
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) { /* not yet */ }
      if (!page) await wait(300);
    }
    if (!page) throw new Error('Cutout did not start');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', no); });
    let id = 0; const pending = new Map();
    ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed');
      return r.result.result.value;
    };
    const until = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr).catch(() => false)) return true; await wait(200); } return false; };
    const openDialog = () => ev(`(() => { const d = document.querySelector('dialog[open]'); return d ? d.id + ': ' + d.querySelector('h2').textContent + ' | ' + d.querySelector('.note').textContent : ''; })()`);
    const press = label => ev(`[...document.querySelectorAll('dialog[open] button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
    const menuItem = label => ev(`(async () => { document.querySelector('#appMenu').click(); await new Promise(r => setTimeout(r, 50));
      const it = [...document.querySelectorAll('#menu [role^=menuitem]')].find(b => b.textContent.includes(${JSON.stringify(label)}));
      if (it) it.click(); else document.querySelector('#appMenu').click(); return !!it; })()`);
    for (let i = 0; i < 50 && !(await ev('!!window.Cutout').catch(() => false)); i++) await wait(200);
    const version = await ev(`window.cutoutNative.getVersion()`);

    // 1. The daily check runs by itself after launch and offers the new version
    const shown = await until(`!!document.querySelector('#dlgUpdate[open]')`);
    let d = await openDialog();
    check('the launch check offers the new version', shown && d === `dlgUpdate: Cutout 99.0.0 is available | You have ${version}`, d);
    const buttons = await ev(`[...document.querySelectorAll('#dlgUpdate button')].map(b => b.textContent).join(', ')`);
    check('its buttons: Download Update (default), Later, Skip This Version', buttons === 'Download Update, Later, Skip This Version'
      && await ev(`document.querySelector('#dlgUpdate button.primary').textContent === 'Download Update'`), buttons);

    // 2. The requests carry nothing about the user: plain user agent, no ID, no cookies
    const ua = [...new Set(requests.map(r => r.headers['user-agent']))];
    const extra = requests.filter(r => r.headers['x-user-staging-id'] || r.headers.cookie || r.headers.authorization || r.headers['accept-language']);
    check('update requests send user agent "Cutout" and no ID, language or cookies', requests.length > 0 && ua.length === 1 && ua[0] === 'Cutout' && !extra.length,
      `${requests.length} requests, user agents ${JSON.stringify(ua)}, ${extra.length} with an ID or cookie`);
    check('the request names no version (the comparison happens in the app)', requests.every(r => !r.url.includes(version)), requests.map(r => r.url).join(' '));

    // 3. Skip This Version; Check for Updates still offers it (only the daily check skips it)
    await press('Skip This Version'); await wait(200);
    check('Skip This Version closes the dialog', !(await openDialog()));
    const hasItem = await menuItem('Check for Updates');
    const again = hasItem && await until(`!!document.querySelector('#dlgUpdate[open]')`, 5000);
    check('Check for Updates in the Cutout menu shows the skipped version', again, await openDialog());

    // 4. Later just closes it
    await press('Later'); await wait(200);
    check('Later closes the dialog', !(await openDialog()));

    // 5. Download Update → "ready" dialog (Windows; the Mac needs a signed app, Linux has no updater)
    if (process.platform === 'win32') {
      await menuItem('Check for Updates'); await until(`!!document.querySelector('#dlgUpdate[open]')`, 5000);
      await press('Download Update');
      const ready = await until(`!!document.querySelector('#dlgUpdateReady[open]')`, 20000);
      d = await openDialog();
      check('Download Update downloads it, then offers Restart to Update', ready && d === 'dlgUpdateReady: Cutout 99.0.0 is ready | Restart Cutout to finish updating.', d);
      check('the download came from the update server, with the same plain headers', requests.some(r => r.url.startsWith('/' + file))
        && requests.every(r => r.headers['user-agent'] === 'Cutout' && !r.headers['x-user-staging-id']));
      await press('Later'); await wait(200);
      await menuItem('Check for Updates');
      check('Check for Updates after a download offers the restart', await until(`!!document.querySelector('#dlgUpdateReady[open]')`, 5000), await openDialog());
      await press('Later');
    }
  } catch (e) {
    check('the update suite ran', false, e.message);
  } finally {
    try { ws && ws.close(); } catch (_) { /* closed */ }
    app.kill();
    server.close();
    await wait(500);
    const cacheRoot = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
    for (const dir of [tmp, cacheRoot && path.join(cacheRoot, cacheName)]) { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* in use */ } }
  }
  return results;
}
