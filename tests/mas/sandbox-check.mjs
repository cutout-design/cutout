// Mac App Store sandbox check: starts the sandboxed store build (tests/mas/build-config.js, signed by
// sign-adhoc.sh) the way Finder does and checks what the sandbox could break: opening files from Finder,
// the real Save panel (it grants one file, not its folder), saving again, JPEG, the clipboard, the network
// (Figma images) and settings kept across a relaunch. Runs on a Mac (GitHub's runner: mas-sandbox.yml).
//   node tests/mas/sandbox-check.mjs dist/mas-dev-arm64/Cutout.app
// The Save panel is driven with System Events keystrokes, so the terminal needs Accessibility access
// (GitHub's Mac runners have it). Not covered (needs a person): dragging a layer out to Finder or Figma,
// the screen color picker, drag and drop onto the window, how it looks.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const app = path.resolve(process.argv[2] || 'dist/mas-dev-arm64/Cutout.app');
if (process.platform !== 'darwin' || !fs.existsSync(app)) { console.error(`Needs a Mac and the app: ${app}`); process.exit(2); }
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`;
  results.push(line); console.log(line);
  return ok;
};

// A folder outside the app's container: the sandbox only lets the app in where the user (Finder, the
// Save panel) allows it.
const out = fs.mkdtempSync(path.join(os.homedir(), 'CutoutSandboxCheck-'));
const container = path.join(os.homedir(), 'Library', 'Containers', 'app.cutout');

/* ---------- a small PNG, written by hand (no packages) */
function png(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(rgba).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const image1 = path.join(out, 'opened.png'), image2 = path.join(out, 'second.png');
fs.writeFileSync(image1, png(64, 48, [255, 0, 0, 255]));
fs.writeFileSync(image2, png(20, 30, [0, 0, 255, 255]));

/* ---------- start the app the way Finder does (LaunchServices), and talk to its page over DevTools */
const osa = script => spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
function quitApp() {
  osa('tell application "Cutout" to quit');
  spawnSync('pkill', ['-x', 'Cutout']); // in case a "You have unsaved changes" question is up
}
async function launch(port, files = []) {
  execFileSync('open', ['-n', '-a', app, ...files, '--args', `--remote-debugging-port=${port}`]);
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) { /* not yet */ }
    if (!page) await wait(300);
  }
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', no); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result.result.value;
  };
  for (let i = 0; i < 50 && !(await ev('!!window.Cutout').catch(() => false)); i++) await wait(200);
  return { ws, ev };
}
async function until(ev, expr, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) if (await ev(expr).catch(() => false)) return true;
  return false;
}

/* ---------- the system Save panel, driven with keystrokes: Go to folder, then the file name */
function answerSavePanel(dir, name) {
  const q = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const r = osa(`
    tell application "System Events"
      tell process "Cutout"
        set frontmost to true
        repeat 50 times
          if exists sheet 1 of window 1 then exit repeat
          delay 0.2
        end repeat
        delay 1
        keystroke "g" using {command down, shift down}
        delay 1.5
        keystroke "${q(dir)}"
        delay 0.5
        key code 36
        delay 1.5
        keystroke "a" using command down
        keystroke "${q(name)}"
        delay 0.5
        key code 36
      end tell
    end tell`);
  return r.status === 0 ? '' : (r.stderr || 'osascript failed').trim();
}
// Page side: open Cutout's save dialog (Ctrl+S / Ctrl+Shift+S, ⌘ works too), pick the format, press Save.
const pressSave = (asNew, fmt, fname) => `(() => {
  const $ = s => document.querySelector(s);
  $('#toast').textContent = '';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ${asNew ? "'S'" : "'s'"}, code: 'KeyS', metaKey: true, shiftKey: ${asNew}, bubbles: true, cancelable: true }));
  if (!$('#dlgExport').open) return 'no format dialog';
  const r = $('input[name="fmt"][value="${fmt}"]'); if (r) { r.checked = true; r.dispatchEvent(new Event('change')); }
  $('#fname').value = '${fname}';
  $('#dlgExport button[value="ok"]').click();
  return 'ok';
})()`;
const toast = "document.querySelector('#toast').textContent";

/* ---------- the checks */
const magic = (file, bytes) => { try { return fs.readFileSync(file).subarray(0, bytes.length).equals(Buffer.from(bytes)); } catch (_) { return false; } };
let s = null;
try {
  quitApp(); await wait(500);
  const port = 9600 + Math.floor(Math.random() * 300);
  s = await launch(port, [image1]);
  if (!check('the sandboxed app starts and its page runs', !!s)) throw new Error('Cutout did not start');
  const { ev } = s;
  check('it runs in the sandbox (it has a container)', fs.existsSync(path.join(container, 'Data')), container);
  check('a file opened from Finder becomes a layer',
    await until(ev, 'Cutout.state.layers.length === 1 && Cutout.state.layers[0].canvas.width === 64'),
    String(await ev('Cutout.state.layers.map(l => l.canvas.width + "x" + l.canvas.height).join(", ")')));

  execFileSync('open', ['-a', app, image2]); // the app is running: macOS hands the file to it
  check('a file opened while it runs is added', await until(ev, 'Cutout.state.layers.length === 2'),
    `${await ev('Cutout.state.layers.length')} layers`);

  // Save: the real Save panel; in the sandbox it grants this one file only.
  const target = path.join(out, 'saved.png');
  check('Save opens the format dialog', (await ev(pressSave(false, 'png', 'saved'))) === 'ok');
  const panel = answerSavePanel(out, 'saved.png');
  if (panel) check('the Save panel could be answered', false, panel);
  check('Save writes the file the Save panel chose', await until(ev, `${toast}.startsWith('Saved saved.png')`, 15000) && magic(target, [137, 80, 78, 71]),
    `${await ev(toast)}; ${fs.existsSync(target) ? fs.statSync(target).size + ' bytes' : 'no file'}`);
  check('...and leaves no temp file next to it', !fs.readdirSync(out).some(f => f.includes('cutout-tmp')), fs.readdirSync(out).join(', '));

  // Save again (Ctrl+S): no panel, same file. The sandbox grant lasts until the app quits.
  const before = fs.existsSync(target) ? fs.readFileSync(target) : Buffer.alloc(0);
  await ev(`(() => { const c = Cutout.makeCanvas(10, 10), g = Cutout.ctx2d(c); g.fillStyle = '#0f0'; g.fillRect(0, 0, 10, 10); Cutout.addImageLayer(c, 'Green'); })()`);
  await wait(300);
  await ev(`(() => { document.querySelector('#toast').textContent = ''; document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true, bubbles: true, cancelable: true })); })()`);
  const resaved = await until(ev, `${toast}.startsWith('Saved saved.png')`, 10000);
  check('saving again writes the same file, silently', resaved && !(await ev("document.querySelector('#dlgExport').open")) && fs.existsSync(target) && !fs.readFileSync(target).equals(before),
    await ev(toast));

  // Save as JPEG: a second file in the same folder.
  const jpg = path.join(out, 'photo.jpg');
  check('Save as opens the format dialog', (await ev(pressSave(true, 'jpeg', 'photo'))) === 'ok');
  const panel2 = answerSavePanel(out, 'photo.jpg');
  if (panel2) check('the Save panel could be answered (Save as)', false, panel2);
  check('Save as JPEG writes a JPEG', await until(ev, `${toast}.startsWith('Saved photo.jpg')`, 15000) && magic(jpg, [0xff, 0xd8, 0xff]),
    `${await ev(toast)}; ${fs.existsSync(jpg) ? fs.statSync(jpg).size + ' bytes' : 'no file'}`);

  // Clipboard: an image put on the system clipboard reaches the app (native read).
  osa(`set the clipboard to (read (POSIX file "${image1}") as «class PNGf»)`);
  const clip = await ev('cutoutNative.readClipboard().then(r => r && r.png ? r.png.length : 0)');
  check('an image on the clipboard can be read', clip > 0, `${clip} bytes`);

  // Network: Figma image links are https downloads from the page.
  const net = await ev("fetch('https://cutout.design/', { cache: 'no-store' }).then(r => r.status, e => 'error: ' + e.message)");
  check('https downloads work (Figma images)', net === 200, String(net));

  // Settings: kept in the container across a relaunch (window.json for the theme, localStorage for prefs).
  await ev("cutoutNative.setTheme('dark'); localStorage.setItem('cutout.sandboxCheck', 'kept'); 1");
  await wait(500);
  await ev("window.onbeforeunload = null; 1");
  s.ws.close(); s = null;
  quitApp(); await wait(2000);
  const port2 = port + 1;
  s = await launch(port2);
  check('it starts again after quitting', !!s);
  if (s) {
    check('settings are kept (theme)', await until(s.ev, "matchMedia('(prefers-color-scheme: dark)').matches", 5000));
    check('settings are kept (preferences)', (await s.ev("localStorage.getItem('cutout.sandboxCheck')")) === 'kept');
    check('settings live in the container', fs.existsSync(container) && execFileSync('find', [container, '-name', 'window.json']).toString().trim() !== '');
  }
} catch (e) {
  check('the check ran to the end', false, e.message);
} finally {
  try { s && s.ws.close(); } catch (_) { /* closed */ }
  quitApp();
  fs.rmSync(out, { recursive: true, force: true });
}
const failed = results.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
