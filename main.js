'use strict';
/*
 * Cutout desktop app (Electron). Loads the same cutout/ web app and adds native behavior
 * through preload.js → window.cutoutNative, which cutout/app.js uses via its Platform object:
 * clipboard reads, native Save dialog, themed title bar, Open with, drag a layer out as a file,
 * and updates from GitHub Releases.
 */
const { app, BrowserWindow, ipcMain, clipboard, dialog, nativeTheme, nativeImage, Menu, shell, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

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
    else installOnClose = moveOnClose = false; // Restart to Update waits for the next quit; no move
  });

  win.on('close', () => {
    settings.maximized = win.isMaximized();
    settings.bounds = win.getNormalBounds();
    saveSettings();
  });
  win.on('closed', () => {
    win = null; rendererReady = false;
    if (installOnClose) installUpdate();
    else if (moveOnClose) moveToApplications();
  });
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
  scheduleUpdateChecks();
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

/* ---------- updates (electron-updater, from this repository's GitHub Releases) */
// Once a day (at launch, and every 24 hours while Cutout stays open) Cutout asks GitHub whether a newer
// release is out. The check carries nothing about the user or the computer: user agent "Cutout", no
// version, no ID, no language, no cookies (electron-updater has a session of its own). Downloading an update
// first fetches the installed version's .blockmap (named after it) for a differential download; docs/privacy.md says so. The page shows the dialogs:
// "available" (Download Update / Later / Skip This Version), then "ready" (Restart to Update / Later;
// otherwise the update installs when Cutout quits). Off when running from source, except in tests, and in the
// Microsoft Store and Mac App Store versions: the store updates those (process.windowsStore / process.mas).
const DAY = 24 * 60 * 60 * 1000;
const testFeed = !app.isPackaged && process.env.CUTOUT_UPDATE_CONFIG; // tests: an app-update.yml for a local server
const fromStore = !!(process.windowsStore || process.mas);
const updatesOn = (app.isPackaged && process.platform !== 'linux' && !fromStore) || !!testFeed;
let updater = null;
let installOnClose = false, moveOnClose = false;
const update = { version: null, ready: null, downloading: null, timer: null };
function getUpdater() {
  if (updater || !updatesOn) return updater;
  updater = require('electron-updater').autoUpdater;
  updater.logger = null;
  updater.autoDownload = false; // only after Download Update
  updater.autoInstallOnAppQuit = true; // Later on "ready": it installs when Cutout quits
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  if (testFeed) {
    updater.forceDevUpdateConfig = true;
    updater.updateConfigPath = testFeed;
  }
  // electron-updater keeps a random ID per install (.updaterId, for staged rollouts) and sends it as
  // x-user-staging-id. Cutout has no staged rollouts: no ID file, and the header is removed below.
  updater.getOrCreateStagingUserId = async () => '00000000-0000-4000-8000-000000000000';
  session.fromPartition('electron-updater', { cache: false }).webRequest.onBeforeSendHeaders((d, done) => {
    const headers = {};
    for (const [k, v] of Object.entries(d.requestHeaders)) if (!/^(x-user-staging-id|user-agent|accept-language)$/i.test(k)) headers[k] = v;
    headers['User-Agent'] = 'Cutout';
    done({ requestHeaders: headers });
  });
  updater.requestHeaders = { 'User-Agent': 'Cutout' };
  updater.on('download-progress', p => { if (win) win.webContents.send('update:progress', Math.floor(p.percent || 0)); });
  return updater;
}
function scheduleUpdateChecks() {
  if (!updatesOn || update.timer) return;
  const auto = async () => {
    if (update.ready || update.downloading || Date.now() - (settings.lastUpdateCheck || 0) < DAY) return;
    const r = await checkForUpdate(false);
    if (r && win && rendererReady) win.webContents.send('update:available', r);
  };
  setTimeout(auto, testFeed ? 1000 : 5000); // once launch has settled
  update.timer = setInterval(auto, 60 * 60 * 1000); // hourly: has a day passed?
}
/** → { status: 'available', version, current } | { status: 'ready', version } | { status: 'current' }
 *  | { status: 'error' }. Automatic checks return null unless there is something to show. */
async function checkForUpdate(manual) {
  const u = getUpdater();
  if (!u) return manual ? { status: 'error' } : null;
  if (update.ready) return { status: 'ready', version: update.ready };
  try {
    // A server that never answers would leave Check for Updates waiting forever: give up after 30 s.
    // electron-updater hands a check that is still running to every later caller, so after a timeout
    // it is dropped (its checkForUpdatesPromise), or every later check would wait on the dead one too.
    const check = u.checkForUpdates();
    check.catch(() => {}); // a dropped check may still fail later: nobody waits for it then
    let timer;
    const r = await Promise.race([check, new Promise((_, no) => { timer = setTimeout(() => {
      if (u.checkForUpdatesPromise === check) u.checkForUpdatesPromise = null;
      no(new Error('timeout'));
    }, testFeed && process.env.CUTOUT_UPDATE_TIMEOUT ? Number(process.env.CUTOUT_UPDATE_TIMEOUT) : 30000); })])
      .finally(() => clearTimeout(timer));
    if (!manual) { settings.lastUpdateCheck = Date.now(); saveSettings(); } // a manual check doesn't use up the daily one
    const version = r && r.isUpdateAvailable ? String(r.updateInfo.version) : null;
    if (!version) return manual ? { status: 'current' } : null;
    if (!manual && settings.skipVersion === version) return null; // Skip This Version: only a manual check shows it
    update.version = version;
    return { status: 'available', version, current: app.getVersion() };
  } catch (_) {
    return manual ? { status: 'error' } : null; // offline is normal: automatic checks stay quiet
  }
}
function installUpdate() {
  installOnClose = false;
  // Not silent: the installer's progress window shows while it installs (silent, nothing showed for
  // 10 to 20 seconds, which looked like Cutout had quit). It starts the new version when done.
  if (update.ready && updater) updater.quitAndInstall(false, true);
}
ipcMain.handle('update:supported', () => updatesOn);
ipcMain.handle('update:check', () => checkForUpdate(true));
ipcMain.handle('update:download', async () => {
  const u = getUpdater();
  if (!u || !update.version) return { status: 'error' };
  if (update.ready) return { status: 'ready', version: update.ready };
  // Mac: the update can only replace Cutout in the Applications folder, so offer to move it there now.
  // Moving reopens Cutout from Applications; the window closes first, so unsaved changes get their question.
  if (process.platform === 'darwin' && app.isPackaged && !inApplications()) {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      message: 'Move Cutout to the Applications folder?',
      detail: 'Cutout can update itself only from the Applications folder. It reopens from there; then choose Check for Updates again.',
      buttons: ['Move to Applications', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response !== 0) return { status: 'cancel' };
    if (!win) { moveToApplications(); return { status: 'moving' }; }
    moveOnClose = true;
    win.close();
    return { status: 'moving' };
  }
  try {
    update.downloading = update.downloading || u.downloadUpdate();
    await update.downloading;
    update.ready = update.version;
    return { status: 'ready', version: update.ready };
  } catch (_) {
    return { status: 'error' };
  } finally {
    update.downloading = null;
  }
});
ipcMain.on('update:skip', () => {
  if (!update.version) return;
  settings.skipVersion = update.version;
  saveSettings();
});
// Restart to Update: close the window first, so unsaved changes still get their question. If the
// user keeps the window open, nothing happens now (the update still installs on quit).
ipcMain.on('update:restart', () => {
  if (!update.ready) return;
  if (!win) { installUpdate(); return; }
  installOnClose = true;
  win.close();
});

/* ---------- app */
// Windows/Linux: no menu bar (Cutout has its own menus; also drops Electron's default Reload/DevTools keys).
// Mac: a menu bar is expected, and without an Edit menu ⌘C / ⌘V don't even work in text fields.
// Cut / Copy / Paste use the system roles (the page gets cut / copy / paste events); Undo, Redo and
// Select all go to the page, which decides between text editing and Cutout's own commands.
function buildMacMenu() {
  const toPage = cmd => () => { if (win) win.webContents.send('menu:command', cmd); };
  return Menu.buildFromTemplate([
    {
      label: 'Cutout',
      submenu: [
        { role: 'about' },
        ...(updatesOn ? [{ label: 'Check for Updates', click: toPage('checkUpdates') }] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
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
    {
      role: 'help', // macOS adds its menu search field here
      submenu: [
        { label: 'User Guide', click: () => shell.openExternal('https://cutout.design/guide/') },
        // The system's About window can't hold a link, so the Mac app has Privacy here
        // (Windows and the browser: a link in Cutout's About box). App stores ask for one in the app.
        { label: 'Privacy Policy', click: () => shell.openExternal('https://cutout.design/privacy/') },
      ],
    },
  ]);
}
Menu.setApplicationMenu(process.platform === 'darwin' ? buildMacMenu() : null);
app.whenReady().then(async () => {
  if (THEMES.includes(settings.theme)) nativeTheme.themeSource = settings.theme; // title bar right from the start
  // Mac About window: just "Cutout" and "Version x.y.z" (no build number in parentheses, no copyright).
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: 'Cutout', applicationVersion: app.getVersion(), version: '', copyright: '' });
    if (await offerMoveToApplications()) return; // moved: the copy in Applications starts instead
    if (settings.movedNotice && inApplications()) {
      settings.movedNotice = false;
      saveSettings();
      await dialog.showMessageBox({ type: 'info', message: 'Cutout is now in the Applications folder', detail: 'If a copy is still where you opened it from, such as Downloads, you can delete it.', buttons: ['OK'] });
    }
  }
  if (!win) createWindow(); // a file opened while the Move question showed may have opened it already
});
// Mac: updates can only replace Cutout when it runs from the Applications folder. Opened straight
// from Downloads, macOS runs a hidden read-only copy (App Translocation) and the update fails. So offer
// to move it there (as many Mac apps do). Do Not Move is remembered for this copy of Cutout only
// (noMoveCopy: which unpacked copy it was): deleting the app can't clear settings on a Mac (no code runs),
// so a fresh download asks again. 2.0.0 and 2.0.1 remembered it for good (noMoveOffer); that is dropped.
// Download Update still offers the move. Not when opened with files: moving restarts Cutout, and the
// files would be lost.
/** Tells copies of Cutout apart: the file number of this copy's Info.plist (new for every unzip or copy;
 *  APFS never reuses them). The same in macOS's translocated view of that copy. Not the creation time:
 *  unzipping can restore the times stored in the zip, which are the same for every download. */
function macCopyId() {
  try { return String(fs.statSync(path.join(macBundle(), 'Contents', 'Info.plist'), { bigint: true }).ino); } catch (_) { return ''; }
}
/** The Cutout.app this process runs from (…/Cutout.app/Contents/MacOS/Cutout → …/Cutout.app). */
function macBundle() { return path.resolve(process.execPath, '..', '..', '..'); }
/** True only when Cutout really runs from an Applications folder. A copy there that macOS still runs
 *  from a hidden translocated copy (it kept the "downloaded" flag) doesn't count: it can't update. */
function inApplications() {
  const b = macBundle();
  return ['/Applications', path.join(os.homedir(), 'Applications')].some(dir => b.startsWith(dir + '/'));
}
let askingMove = false;
async function offerMoveToApplications() {
  if (settings.noMoveOffer !== undefined) { delete settings.noMoveOffer; saveSettings(); }
  if (!updatesOn || !app.isPackaged || pendingFiles.length) return false;
  if (settings.noMoveCopy && settings.noMoveCopy === macCopyId()) return false;
  if (inApplications()) return false;
  askingMove = true; // a Dock click meanwhile must not open a window behind the question
  const r = await dialog.showMessageBox({
    type: 'question',
    message: 'Move Cutout to the Applications folder?',
    detail: 'Cutout can update itself only from the Applications folder.',
    buttons: ['Move to Applications', 'Do Not Move'],
    defaultId: 0,
    cancelId: 1,
  }).finally(() => { askingMove = false; });
  if (r.response === 0) return moveToApplications();
  settings.noMoveCopy = macCopyId();
  saveSettings();
  return false;
}
/** Copies this Cutout.app to /Applications (replacing an older one, which goes to the Trash), removes
 *  the "downloaded from the Internet" flag from the copy, puts the original in the Trash when it can,
 *  and reopens from Applications. Electron's own app.moveToApplicationsFolder kept the flag, so macOS
 *  went on running the copy in Applications from a hidden translocated copy, and updates refused
 *  ("move Cutout to the Applications folder") although it was there. Returns false if it couldn't move. */
async function moveToApplications() {
  const src = macBundle();
  const dest = '/Applications/Cutout.app', tmp = '/Applications/.Cutout-moving.app';
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    execFileSync('/usr/bin/ditto', [src, tmp]); // keeps the code signature, symlinks and permissions
    try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', tmp]); } catch (_) { /* no flag to remove */ }
    if (fs.existsSync(dest)) await shell.trashItem(dest);
    fs.renameSync(tmp, dest);
  } catch (_) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (__) { /* nothing to clean */ }
    dialog.showMessageBoxSync({ type: 'warning', message: 'Couldn’t move Cutout', detail: 'Drag Cutout to the Applications folder in Finder.' });
    return false;
  }
  // The original: a translocated copy has no known real place, and macOS can refuse to trash one in
  // Downloads without asking. Either way the copy in Applications says once that it can be deleted.
  let leftBehind = src.includes('/AppTranslocation/');
  if (!leftBehind && src !== dest) leftBehind = !(await shell.trashItem(src).then(() => true, () => false));
  settings.movedNotice = leftBehind;
  saveSettings();
  app.relaunch({ execPath: path.join(dest, 'Contents', 'MacOS', 'Cutout'), args: [] });
  app.exit(0);
  return true;
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!win && !askingMove) createWindow(); });
