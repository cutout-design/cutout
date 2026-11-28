// Draws the Mac disk image's window background (installer/dmg-background.png and @2x): a soft
// backdrop with a quiet arrow from Cutout to the Applications folder. Finder draws the two icons and
// their names on top, at the positions in package.json's build.dmg.contents (centers, in points).
// Run with Electron: npx electron scripts/make-dmg-background.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 540, H = 300; // the window's content size in points (package.json build.dmg.window)
const html = scale => `<!doctype html><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${W * scale}px; height: ${H * scale}px; background: #f6f7f9; overflow: hidden; }
  svg { position: absolute; left: 0; top: 0; }
</style><body><svg width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}">
  <!-- arrow between the icons (Cutout at x 150, Applications at x 390, both at y 130) -->
  <g fill="none" stroke="#aeb4be" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M238 130 H302" />
    <path d="M290 118 L302 130 L290 142" />
  </g>
</svg></body>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = path.join(__dirname, '..', 'installer');
  // One render at 2x; the 1x file is that image scaled down (a second offscreen window hung here).
  const scale = 2;
  const win = new BrowserWindow({ width: W * scale, height: H * scale, show: false, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html(scale))).catch(() => {});
  await new Promise(r => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: W * scale, height: H * scale });
  fs.writeFileSync(path.join(out, 'dmg-background@2x.png'), img.toPNG());
  fs.writeFileSync(path.join(out, 'dmg-background.png'), img.resize({ width: W, height: H, quality: 'best' }).toPNG());
  win.destroy();
  app.quit();
});
