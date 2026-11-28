// Draws the Mac disk image's window background: white (Finder draws the icon names black on any background picture, so a dark panel can't work), the heading "Drag Cutout to Applications" and
// a thin arrow between the two icons. Finder draws the icons and their names on top, at the positions in
// package.json's build.dmg.contents (centers, in points), so keep the numbers below in step with those.
// Runs on the Mac build machine before electron-builder (release workflow), so the heading is set in the
// Mac's own font; writes installer/dmg-background.png and @2x (not committed).
//   npx electron scripts/make-dmg-background.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 520, H = 320;           // the window's content size in points (= the 1x image); 20 more than the
                                  // content needs, for Finder's bottom bar (at 300 it showed a scrollbar)
const HEAD_Y = 76;                // heading center
const ICON_Y = 161;               // icon centers (build.dmg.contents y)
const ARROW_X = 260;              // between the icons at x 149 and 371 (build.dmg.contents x)

const html = scale => `<!doctype html><meta charset="utf-8"><style>
  html { zoom: ${scale}; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; background: #fff; overflow: hidden; }
  .h { position: absolute; left: 0; right: 0; top: ${HEAD_Y - 12}px; height: 24px; line-height: 24px; text-align: center;
       font: 600 17px -apple-system, "SF Pro Text", system-ui, sans-serif; letter-spacing: -0.01em; color: #1d1d1f; }
  svg { position: absolute; left: ${ARROW_X - 32}px; top: ${ICON_Y - 10}px; }
</style><body><div class="h">Drag Cutout to Applications</div>
<svg width="64" height="20" viewBox="0 0 64 20"><path d="M2 10 H60 M52 3 L60 10 L52 17" fill="none" stroke="#b7bcc5"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></body>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'installer');
  // One render at 2x; the 1x image is that one scaled down (a second offscreen window hung on Windows).
  const win = new BrowserWindow({ width: W * 2, height: H * 2, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(2))).catch(() => {});
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: W * 2, height: H * 2 });
  const size = img.getSize();
  if (size.width !== W * 2 || size.height !== H * 2) throw new Error(`captured ${size.width}x${size.height}, expected ${W * 2}x${H * 2}`);
  fs.writeFileSync(path.join(out, 'dmg-background@2x.png'), img.toPNG());
  fs.writeFileSync(path.join(out, 'dmg-background.png'), img.resize({ width: W, height: H, quality: 'best' }).toPNG());
  win.destroy();
  app.quit();
});
