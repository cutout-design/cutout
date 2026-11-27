// Figma paste: builds normal Figma copies from scratch (tests/figma-copy.mjs), pastes them into Cutout
// with a real paste event, and checks the pixels and messages. Run by tests/run.mjs.
import { figmaCopy, solid, at, canZstd } from './figma-copy.mjs';

const RED = solid(1, 0, 0), BLUE = solid(0, 0, 1), WHITE = solid(1, 1, 1);

export default async function figmaTests({ ev, wait }) {
  const out = [];
  const check = (name, ok, info = '') => out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);

  // In the page: paste the HTML, wait for a new layer or a message, report what happened.
  await ev(`window.__figmaPaste = async (html, points = []) => {
    const C = window.Cutout, S = C.state, toast = document.querySelector('#toast');
    S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.changed();
    toast.textContent = '';
    const dt = new DataTransfer(); dt.setData('text/html', html);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 100 && !S.layers.length && !/Copy as PNG|images|Couldn/.test(toast.textContent); i++) await new Promise(r => setTimeout(r, 50));
    const l = S.layers[0];
    const px = (x, y) => l ? Array.from(C.ctx2d(l.canvas).getImageData(x, y, 1, 1).data) : null;
    return { layers: S.layers.length, w: l && l.canvas.width, h: l && l.canvas.height, name: l && l.name, toast: toast.textContent, px: points.map(([x, y]) => px(x, y)) };
  }; window.__cspViolations = 0; document.addEventListener('securitypolicyviolation', () => window.__cspViolations++); true`);
  const paste = (html, points) => ev(`window.__figmaPaste(${JSON.stringify(html)}, ${JSON.stringify(points || [])})`);
  const near = (a, b, tol = 3) => a && b.every((v, i) => Math.abs(a[i] - v) <= tol);
  const show = p => (p ? p.join(',') : 'none');

  // A frame with a child rectangle
  const card = [
    { type: 'FRAME', name: 'Card', w: 100, h: 60, fillPaints: [RED], frameMaskDisabled: false },
    { type: 'RECTANGLE', name: 'Box', parent: 0, x: 10, y: 10, w: 40, h: 20, fillPaints: [BLUE] },
  ];
  let r = await paste(figmaCopy(card), [[5, 5], [20, 15], [55, 35]]);
  check('a Figma frame pastes as one layer at its size', r.layers === 1 && r.w === 100 && r.h === 60, `${r.layers} layers, ${r.w}x${r.h}, ${r.toast}`);
  check('...named after the frame', r.name === 'Card', r.name);
  check('...with the frame fill', near(r.px[0], [255, 0, 0, 255]), show(r.px[0]));
  check('...and the child rectangle in place', near(r.px[1], [0, 0, 255, 255]) && near(r.px[2], [255, 0, 0, 255]), `${show(r.px[1])} / ${show(r.px[2])}`);
  check('...and says what it pasted', /Pasted 100 × 60/.test(r.toast), r.toast);

  if (canZstd) {
    r = await paste(figmaCopy(card, { zstd: true }), [[20, 15]]);
    check('a zstd-compressed copy (newer Figma) pastes the same', r.w === 100 && r.h === 60 && near(r.px[0], [0, 0, 255, 255]), `${r.w}x${r.h} ${show(r.px[0])}`);
  } else check('zstd copy skipped (this Node has no zstd)', true);

  // Rounded corners: the corner pixel is empty, the middle filled
  r = await paste(figmaCopy([{ type: 'ROUNDED_RECTANGLE', name: 'Pill', w: 80, h: 40, cornerRadius: 20, fillPaints: [BLUE] }]), [[1, 1], [40, 20], [40, 1]]);
  check('rounded corners: the corner is transparent', r.px[0] && r.px[0][3] < 20, show(r.px[0]));
  check('rounded corners: the middle and edges are filled', near(r.px[1], [0, 0, 255, 255]) && r.px[2][3] > 200, `${show(r.px[1])} / ${show(r.px[2])}`);

  // Layer opacity and hidden children
  r = await paste(figmaCopy([
    { type: 'FRAME', name: 'Half', w: 50, h: 50, fillPaints: [WHITE], opacity: 0.5, frameMaskDisabled: false },
    { type: 'RECTANGLE', name: 'Hidden', parent: 0, w: 50, h: 50, fillPaints: [RED], visible: false },
  ]), [[25, 25]]);
  check('layer opacity carries over', r.px[0] && Math.abs(r.px[0][3] - 128) <= 3, show(r.px[0]));
  check('a hidden layer is not drawn', r.px[0] && r.px[0][0] > 250 && r.px[0][1] > 250, show(r.px[0]));

  // A fill with its own opacity
  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'Faint', w: 20, h: 20, fillPaints: [solid(0, 0, 0, 1, { opacity: 0.25 })] }]), [[10, 10]]);
  check('fill opacity carries over', r.px[0] && Math.abs(r.px[0][3] - 64) <= 3, show(r.px[0]));

  // A drop shadow makes the image bigger, like Figma's Copy as PNG
  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'Lifted', w: 50, h: 50, fillPaints: [WHITE],
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 4 }, radius: 8, visible: true, spread: 0 }] }]), [[33, 33]]);
  // 8 px blur on each side; the 4 px offset moves it: 4 px above, 12 px below
  check('a drop shadow adds room around the layer', r.w === 66 && r.h === 66, `${r.w}x${r.h}`);
  check('...and the layer itself stays opaque', near(r.px[0], [255, 255, 255, 255]), show(r.px[0]));

  // A layer blur: drawn soft where the browser's canvas can blur, refused where it can't (never pasted sharp)
  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'Soft', w: 40, h: 40, fillPaints: [BLUE],
    effects: [{ type: 'FOREGROUND_BLUR', radius: 8, visible: true }] }]), [[24, 24], [8, 24]]);
  const canBlur = await ev(`'filter' in document.createElement('canvas').getContext('2d')`);
  if (canBlur) check('a layer blur pastes soft', r.layers === 1 && r.w === 56 && r.px[0][3] > 240 && r.px[1][3] > 20 && r.px[1][3] < 235, `${r.w}x${r.h} ${show(r.px[0])} / ${show(r.px[1])}`);
  else check('a layer blur is refused where the browser can\'t blur', r.layers === 0 && /Copy as PNG/.test(r.toast), `${r.layers} layers, ${r.toast}`);

  // An outside stroke counts toward the size
  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'Outlined', w: 40, h: 40, fillPaints: [WHITE], strokePaints: [RED], strokeWeight: 4, strokeAlign: 'OUTSIDE' }]), [[1, 24], [24, 24]]);
  check('an outside stroke adds its width', r.w === 48 && r.h === 48, `${r.w}x${r.h}`);
  check('...drawn outside the fill', near(r.px[0], [255, 0, 0, 255]) && near(r.px[1], [255, 255, 255, 255]), `${show(r.px[0])} / ${show(r.px[1])}`);

  // Two layers copied together: one image covering both
  r = await paste(figmaCopy([
    { type: 'RECTANGLE', name: 'A', w: 20, h: 20, fillPaints: [RED] },
    { type: 'RECTANGLE', name: 'B', x: 50, y: 30, w: 20, h: 20, fillPaints: [BLUE] },
  ]), [[10, 10], [60, 40], [35, 25]]);
  check('two layers paste as one image covering both', r.layers === 1 && r.w === 70 && r.h === 50, `${r.layers} layers, ${r.w}x${r.h}`);
  check('...each in its place, the gap empty', near(r.px[0], [255, 0, 0, 255]) && near(r.px[1], [0, 0, 255, 255]) && r.px[2][3] === 0, r.px.map(show).join(' / '));

  // Refusals: anything Cutout can't draw exactly pastes nothing and asks for Copy as PNG
  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'New', w: 20, h: 20, fillPaints: [RED], futureFeature: 'on' }]));
  check('a field Cutout doesn\'t know refuses the paste', r.layers === 0 && /Copy as PNG/.test(r.toast), `${r.layers} layers, ${r.toast}`);

  r = await paste(figmaCopy([{ type: 'TEXT', name: 'Label', w: 60, h: 20, fillPaints: [RED], textData: { characters: 'Hello' } }]));
  check('text without its outlines is refused', r.layers === 0 && /Copy as PNG/.test(r.toast), `${r.layers} layers, ${r.toast}`);

  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'Photo', w: 40, h: 40, fillPaints: [{ type: 'IMAGE', opacity: 1, visible: true, image: { hash: Array(20).fill(7) } }] }]));
  check('an image it can\'t download is refused', r.layers === 0 && /Couldn’t load the images/.test(r.toast), `${r.layers} layers, ${r.toast}`);

  r = await paste('<span data-buffer="<!--(figma)ZmlnLWtpd2kAAAAAAAAA(/figma)-->"></span>');
  check('damaged Figma data is refused without an error', r.layers === 0 && /Copy as PNG/.test(r.toast), `${r.layers} layers, ${r.toast}`);

  r = await paste(figmaCopy([{ type: 'RECTANGLE', name: 'Hidden', w: 20, h: 20, fillPaints: [RED], visible: false }]));
  check('a copy with nothing visible pastes nothing', r.layers === 0 && r.toast !== '', `${r.layers} layers, ${r.toast}`);

  // Still works after the refusals, and nothing broke the security policy
  r = await paste(figmaCopy(card), [[20, 15]]);
  check('pasting works again after a refusal', r.layers === 1 && near(r.px[0], [0, 0, 255, 255]), show(r.px[0]));
  const csp = await ev('window.__cspViolations');
  check('Figma paste runs within the content security policy', csp === 0, `${csp} violations`);
  await ev(`(() => { const S = window.Cutout.state; S.layers.length = 0; S.selected.clear(); S.active = null; window.Cutout.changed(); return true; })()`);
  return out;
}
