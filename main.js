'use strict';
/*
 * Cutout desktop app (Electron). Loads the same cutout/ web app and adds native behavior
 * through preload.js → window.cutoutNative, which cutout/app.js uses via its Platform object:
 * clipboard reads, native Save dialog, themed title bar, Open with, drag a layer out as a file.
 */
const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeTheme, nativeImage, Menu, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ID = 'app.cutout'; // same as build.appId in package.json (taskbar icon + grouping)
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const THEMES = ['system', 'light', 'dark'];

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) { app.quit(); return; } // a second launch hands its files to the first

/* ---------- small settings file (theme for the title bar before the page loads, window size) */
const settingsFile = () => path.join(app.getPath('userData'), 'window.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (_) { /* first run */ }
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (_) { /* ignore */ }
}

/* ---------- files passed on the command line / Open with / second launch */
function filesFromArgv(argv, cwd = process.cwd()) {
  return argv.slice(1)
    .filter(a => !a.startsWith('-') && IMAGE_EXT.test(a))
    .map(a => path.resolve(cwd, a))
    .filter(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
}
function readEntry(p) {
  try {
    const ext = path.extname(p).slice(1).toLowerCase();
    return { name: path.basename(p), type: MIME[ext] || 'application/octet-stream', data: fs.readFileSync(p) };
  } catch (_) { return null; }
}
let pendingFiles = filesFromArgv(process.argv);
let rendererReady = false;
function openPaths(paths) {
  if (!paths.length) return;
  if (!win || !rendererReady) {
    pendingFiles.push(...paths);
    // Mac: the app keeps running with no window; opening a file brings one back (it picks the file up)
    if (!win && app.isReady()) createWindow();
    return;
  }
  win.webContents.send('files:open', paths.map(readEntry).filter(Boolean));
}
function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}
app.on('second-instance', (_e, argv, cwd) => { openPaths(filesFromArgv(argv, cwd)); focusWindow(); });
app.on('open-file', (e, p) => { e.preventDefault(); openPaths([p]); }); // macOS

/* ---------- window */
let win = null;
function createWindow() {
  const b = settings.bounds;
  const onScreen = b && screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + 40 > a.y;
  });
  win = new BrowserWindow({
    ...(onScreen ? b : { width: 1400, height: 900 }),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Cutout',
    icon: path.join(__dirname, 'cutout', 'icons', 'icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2b2b2b' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (onScreen && settings.maximized) win.maximize();
  win.loadFile(path.join(__dirname, 'cutout', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const wc = win.webContents;
  wc.setVisualZoomLevelLimits(1, 1); // no pinch zoom of the whole UI (Cutout zooms the canvas itself)
  // Never navigate away from the app (e.g. a file dropped outside the canvas); links open in the browser.
  wc.on('will-navigate', e => e.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Developer tools (F12 / Ctrl+Shift+I) only when running from source.
  wc.on('before-input-event', (e, input) => {
    if (app.isPackaged || input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      wc.toggleDevTools();
      e.preventDefault();
    }
  });
  // The page asks before closing with unsaved changes (beforeunload). Electron doesn't show a
  // dialog for that by itself, so show one here.
  wc.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Cutout',
      message: 'You have unsaved changes',
      buttons: ['Close without saving', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) e.preventDefault(); // close anyway
  });

  win.on('close', () => {
    settings.maximized = win.isMaximized();
    settings.bounds = win.getNormalBounds();
    saveSettings();
  });
  win.on('closed', () => { win = null; rendererReady = false; });
}

/* ---------- IPC (see preload.js) */
// Electron 45+ clipboard: W3C-style read() → ClipboardItem[] with getType(mime) → Blob.
ipcMain.handle('clipboard:read', async () => {
  const items = await clipboard.read();
  const bytes = async (item, type) => Buffer.from(await (await item.getType(type)).arrayBuffer());
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'));
    if (!type) continue;
    const data = await bytes(item, type);
    return { png: type === 'image/png' ? data : nativeImage.createFromBuffer(data).toPNG() };
  }
  const text = async type => {
    for (const item of items) if (item.types.includes(type)) return (await bytes(item, type)).toString('utf8');
    return '';
  };
  return { text: await text('text/plain'), html: await text('text/html') };
});

const savePaths = new Set(); // only files the user picked in a Save dialog can be written
ipcMain.handle('file:save-dialog', async (_e, suggestedName) => {
  const png = { name: 'PNG image', extensions: ['png'] };
  const jpg = { name: 'JPEG image', extensions: ['jpg', 'jpeg'] };
  const dir = settings.saveDir && fs.existsSync(settings.saveDir) ? settings.saveDir : app.getPath('desktop');
  const name = String(suggestedName || 'cutout.png').replace(/[\\/:*?"<>|]/g, '-');
  const r = await dialog.showSaveDialog(win, {
    // Mac App Store build (sandboxed): the folder saved last may not be readable after a relaunch, so
    // pass only the name and let the system's Save panel open in the folder it remembers.
    defaultPath: process.mas ? name : path.join(dir, name),
    filters: /\.jpe?g$/i.test(name) ? [jpg, png] : [png, jpg],
  });
  if (r.canceled || !r.filePath) return null;
  settings.saveDir = path.dirname(r.filePath);
  saveSettings();
  savePaths.add(r.filePath);
  return r.filePath;
});
ipcMain.handle('file:write', async (_e, filePath, bytes) => {
  if (!savePaths.has(filePath)) throw new Error('Not a chosen save location');
  const data = Buffer.from(bytes);
  // Mac App Store build (sandboxed): the Save panel grants this one file, not its folder, so a temp file
  // next to it can't be created. Write the file itself (tests/mas/sandbox-check.mjs checks this).
  if (process.mas) { await fs.promises.writeFile(filePath, data); return; }
  const tmp = `${filePath}.cutout-tmp`;
  await fs.promises.writeFile(tmp, data);
  // Replace in one step, so a failed save never leaves half a file. Right after a write, Dropbox,
  // antivirus or Explorer thumbnails can hold either file for a moment (EPERM/EBUSY), so retry briefly.
  for (let i = 0; ; i++) {
    try { await fs.promises.rename(tmp, filePath); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { await fs.promises.rm(tmp, { force: true }); throw e; }
      if (i < 8) { await new Promise(r => setTimeout(r, 50 * (i + 1))); continue; }
      // Still locked: write straight to the file instead.
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      await fs.promises.writeFile(filePath, data);
      return;
    }
  }
});

ipcMain.on('theme:set', (_e, pref) => {
  if (!THEMES.includes(pref) || nativeTheme.themeSource === pref) return;
  nativeTheme.themeSource = pref;
  settings.theme = pref;
  saveSettings();
});

ipcMain.handle('files:startup', () => {
  rendererReady = true;
  const list = pendingFiles.map(readEntry).filter(Boolean);
  pendingFiles = [];
  return list;
});

ipcMain.handle('app:version', () => app.getVersion());

// Drag a layer out as a real PNG file: write it to a temp folder and hand it to the OS drag.
const dragDirs = [];
ipcMain.on('drag:start', (e, name, bytes) => {
  try {
    // Earlier drags have been dropped by now: remove their files instead of keeping every one
    // until quit (a few recent ones stay, in case an app is still reading its drop).
    while (dragDirs.length > 2) { try { fs.rmSync(dragDirs.shift(), { recursive: true, force: true }); } catch (_) { /* in use */ } }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutout-drag-'));
    dragDirs.push(dir);
    const file = path.join(dir, String(name || 'layer.png').replace(/[\\/:*?"<>|]/g, '-'));
    const buf = Buffer.from(bytes);
    fs.writeFileSync(file, buf);
    let icon = nativeImage.createFromBuffer(buf);
    const s = icon.getSize();
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'cutout', 'icons', 'icon-48.png'));
    else if (s.width > 96 || s.height > 96) icon = icon.resize(s.width >= s.height ? { width: 96 } : { height: 96 });
    e.sender.startDrag({ file, icon });
  } catch (_) { /* ignore: the drag simply doesn't start */ }
});
app.on('will-quit', () => {
  for (const d of dragDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* in use */ } }
});

/* ---------- app */
// Windows/Linux: no menu bar (Cutout has its own menus; also drops Electron's default Reload/DevTools keys).
// Mac: a menu bar is expected, and without an Edit menu ⌘C / ⌘V don't even work in text fields.
// Cut / Copy / Paste use the system roles (the page gets cut / copy / paste events); Undo, Redo and
// Select all go to the page, which decides between text editing and Cutout's own commands.
function buildMacMenu() {
  const toPage = cmd => () => { if (win) win.webContents.send('menu:command', cmd); };
  return Menu.buildFromTemplate([
    { role: 'appMenu' }, // Cutout: About, Hide, Hide others, Quit…
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: toPage('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: toPage('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: toPage('selectAll') },
      ],
    },
    { role: 'windowMenu' }, // Minimize, Zoom, Close…
  ]);
}
Menu.setApplicationMenu(process.platform === 'darwin' ? buildMacMenu() : null);
app.whenReady().then(() => {
  if (THEMES.includes(settings.theme)) nativeTheme.themeSource = settings.theme; // title bar right from the start
  // Mac About window: just "Cutout" and "Version x.y.z" (no build number in parentheses, no copyright).
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: 'Cutout', applicationVersion: app.getVersion(), version: '', copyright: '' });
  }
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win) createWindow(); });
