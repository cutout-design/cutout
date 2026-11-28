// Makes the MSIX (Store) tile and logo images for Cutout from the same 32-unit artwork as the
// Windows icon (cutout/icons, "Cutout icons.svg"). Output: installer/appx/ (electron-builder
// reads appx assets from <buildResources>/appx). Windows only (renders with Edge).
//
//   node scripts/make-appx-assets.mjs
//
// Renders with Edge headless (transparent background). The 16/32/48/256 px taskbar sizes are
// copied from the repo's pixel-snapped icon PNGs instead of rendered, so they stay as sharp as the .ico.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const out = path.join(repo, 'installer/appx');
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(f => fs.existsSync(f));
if (!edge) throw new Error('Edge not found');
fs.mkdirSync(out, { recursive: true });

// The tile artwork in its 32-unit grid (same as installer/icon-mac.svg without the Mac shadow).
const ART = `
  <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6CB4FF"/><stop offset=".5" stop-color="#0073E7"/><stop offset="1" stop-color="#00478F"/></linearGradient></defs>
  <rect width="32" height="32" rx="7.2" fill="url(#b)"/>
  <path d="M6 6h7v2.5H8.5V13H6zM26 26h-7v-2.5h4.5V19H26z" fill="#fff"/>
  <rect x="11.3" y="11.6" width="11" height="11" rx="1.5" fill="#003670" fill-opacity=".5"/>
  <rect x="10.5" y="10.5" width="11" height="11" rx="1.5" fill="#fff"/>`;

// w × h canvas, icon of size `icon` px centered (transparent around it).
function svg(w, h, icon) {
  const s = icon / 32, x = (w - icon) / 2, y = (h - icon) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g transform="translate(${x} ${y}) scale(${s})">${ART}</g></svg>`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutout-appx-'));
function render(name, w, h, icon) {
  const html = path.join(tmp, name + '.html');
  fs.writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${svg(w, h, icon)}`);
  const png = path.join(out, name);
  execFileSync(edge, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${w},${h}`, `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')], { stdio: 'ignore' });
  console.log(name, `${w}x${h}`);
}
function copy(name, from) {
  fs.copyFileSync(path.join(repo, 'cutout/icons', from), path.join(out, name));
  console.log(name, '(copied ' + from + ')');
}

// App list / Start / title bar icon. Scales (44 px at 100%): icon fills the box, as Windows' own apps do.
for (const [scale, px] of [[100, 44], [125, 55], [150, 66], [200, 88], [400, 176]]) render(`Square44x44Logo.scale-${scale}.png`, px, px, px);
// Taskbar and Explorer sizes, plated and unplated (unplated = shown without the accent-color plate).
for (const size of [16, 24, 32, 48, 256]) {
  for (const suffix of ['', '_altform-unplated']) {
    const name = `Square44x44Logo.targetsize-${size}${suffix}.png`;
    if (size === 24) render(name, 24, 24, 24); else copy(name, `icon-${size}.png`);
  }
}
// Medium tile: icon at about 2/3 of the tile, like Windows' guidance for tile padding.
for (const [scale, px] of [[100, 150], [200, 300]]) render(`Square150x150Logo.scale-${scale}.png`, px, px, Math.round(px * 0.66));
// Wide tile (required by the manifest even though Windows 11 doesn't show tiles).
for (const [scale, w, h] of [[100, 310, 150], [200, 620, 300]]) render(`Wide310x150Logo.scale-${scale}.png`, w, h, Math.round(h * 0.66));
// Store logo (package logo shown in installers and Settings > Apps).
for (const [scale, px] of [[100, 50], [200, 100]]) render(`StoreLogo.scale-${scale}.png`, px, px, px);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Done:', out);
