// Dragging to the edge of the view scrolls it (marquee, moving layers, rubber band). Run in Cutout's page, then: await autoScrollTests()
window.autoScrollTests = async () => {
  const C = window.Cutout, S = C.state, V = C.view, vc = document.querySelector('#view'), $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const dpr = devicePixelRatio || 1, R = () => vc.getBoundingClientRect();
  const ptr = (type, clientX, clientY, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY, ...o }));
  const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }));
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, color) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; };
  const size = () => $('#selSize').textContent;
  const width = () => parseInt(size(), 10) || 0;
  // A big image at 100%, its top-left corner a little inside the view: most of it is off to the right and below
  const bigAt100 = async () => {
    reset(); C.addImageLayer(image(4000, 3000, '#3366ff'), 'Big'); await wait(20);
    V.s = dpr; V.ox = 100 * dpr; V.oy = 100 * dpr; C.render();
  };

  try {
    // Marquee to past the right edge, then held still
    await bigAt100(); C.setTool('marquee');
    const r = R(), y = r.top + 200;
    ptr('pointerdown', r.left + 200, y);
    ptr('pointermove', r.left + 260, y);
    ptr('pointermove', r.right + 40, y + 60); // past the edge
    const ox0 = V.ox; await wait(50); const w0 = width();
    await wait(400);
    const w1 = width();
    check('marquee at the right edge scrolls the view', V.ox < ox0 - 50 * dpr, `${Math.round(ox0)} → ${Math.round(V.ox)}`);
    check('...and keeps extending the selection with the pointer held still', w1 > w0 + 50, `${w0} → ${w1}`);
    ptr('pointermove', r.right - 12, y + 60); await wait(30); // just inside the edge: slow
    const ox1 = V.ox; await wait(150);
    const step = ox1 - V.ox;
    ptr('pointermove', r.right + 40, y + 60); await wait(30); // 40 px past: full speed
    const ox2 = V.ox; await wait(150);
    const fast = ox2 - V.ox;
    check('further past the edge scrolls faster', fast > step * 2, `${Math.round(step)} → ${Math.round(fast)} px per 150 ms`);
    ptr('pointermove', r.right + 300, y + 60); await wait(30);
    const ox2b = V.ox; await wait(150);
    check('...and 40 px past is already full speed', Math.abs((ox2b - V.ox) - fast) < fast * 0.35, `${Math.round(fast)} vs ${Math.round(ox2b - V.ox)}`);
    ptr('pointermove', r.left + r.width / 2, y); await wait(60); // back inside
    const ox3 = V.ox; await wait(150);
    check('moving back inside the view stops it', V.ox === ox3 && !C.autoScrolling());
    ptr('pointermove', r.right + 40, y + 2); await wait(100);
    ptr('pointerup', r.right + 40, y + 2); await wait(30);
    const ox4 = V.ox; await wait(150);
    check('letting go stops it', V.ox === ox4 && !C.autoScrolling());
    const endX = Math.round(((r.width + 40) * dpr - Math.round(V.ox)) / V.s); // the pointer, in the document (the selection stops at the image's edge, 4000)
    check('the selection ends where the pointer was in the scrolled view', S.sel && S.sel.x === 100 && Math.abs(S.sel.x + S.sel.w - Math.min(endX, 4000)) <= 1, S.sel ? `${S.sel.x},${S.sel.y} ${S.sel.w}x${S.sel.h}, pointer at ${endX}` : 'none');

    // Same speed toward the left (the toolbar side has little room before the screen's edge)
    reset(); C.addImageLayer(image(8000, 3000, '#3366ff'), 'Wide'); await wait(20);
    V.s = dpr; V.ox = -4000 * dpr; V.oy = 100 * dpr; C.render(); C.setTool('marquee');
    ptr('pointerdown', r.left + r.width / 2, r.top + 200);
    ptr('pointermove', r.left + r.width / 2, r.top + 260);
    ptr('pointermove', r.left - 40, r.top + 260); await wait(120);
    const l0 = V.ox; await wait(150); const toLeft = V.ox - l0;
    ptr('pointermove', r.right + 40, r.top + 260); await wait(120);
    const r0 = V.ox; await wait(150); const toRight = r0 - V.ox;
    check('40 px past the left edge scrolls as fast as 40 px past the right', toLeft > 0 && toRight > 0 && Math.abs(toLeft - toRight) < Math.max(toLeft, toRight) * 0.35, `left ${Math.round(toLeft)}, right ${Math.round(toRight)} px per 150 ms`);
    ptr('pointerup', r.right + 40, r.top + 260); await wait(20);

    // Esc mid-scroll cancels the marquee and stops the scrolling
    await bigAt100(); C.setTool('marquee');
    ptr('pointerdown', r.left + 200, r.top + 200);
    ptr('pointermove', r.left + 200, r.top + 260);
    ptr('pointermove', r.left + 200, r.bottom + 30); await wait(150);
    check('marquee at the bottom edge scrolls down', V.oy < 100 * dpr - 10 * dpr, `${Math.round(V.oy)}`);
    key('Escape'); await wait(30);
    const oy0 = V.oy; await wait(150);
    check('Esc stops the scrolling and drops the marquee', V.oy === oy0 && !C.autoScrolling() && S.sel === null);
    ptr('pointerup', r.left + 200, r.bottom + 30); await wait(20);

    // A click (no drag) near the edge doesn't scroll
    await bigAt100(); C.setTool('marquee');
    ptr('pointerdown', r.right - 5, r.top + 200); await wait(150);
    check('pressing near the edge without dragging doesn\'t scroll', V.ox === 100 * dpr && !C.autoScrolling());
    ptr('pointerup', r.right - 5, r.top + 200); await wait(20);

    // Stops once the artboard's edge comes into the view
    reset(); C.addImageLayer(image(1200, 400, '#3366ff'), 'Wide'); await wait(20);
    V.s = dpr; V.ox = 50 * dpr; V.oy = 100 * dpr; C.render(); C.setTool('marquee');
    ptr('pointerdown', r.left + 100, r.top + 150);
    ptr('pointermove', r.left + 160, r.top + 150);
    ptr('pointermove', r.right + 300, r.top + 250);
    for (let i = 0; i < 60 && C.autoScrolling(); i++) await wait(50);
    const right = V.ox / dpr + 1200; // the artboard's right edge, CSS px from the view's left
    check('it stops once the artboard\'s far edge is inside the view', !C.autoScrolling() && right <= r.width - 47 && right > r.width - 120, `edge at ${Math.round(right)} of ${Math.round(r.width)}`);
    ptr('pointerup', r.right + 300, r.top + 250); await wait(20);
    check('...and the selection runs to the artboard\'s edge', S.sel && S.sel.x + S.sel.w === 1200, S.sel ? `${S.sel.x} + ${S.sel.w}` : 'none');

    // A small artboard that fits doesn't scroll at all
    reset(); C.addImageLayer(image(300, 200, '#3366ff'), 'Small'); await wait(20); C.setTool('marquee');
    const vox = V.ox;
    ptr('pointerdown', r.left + r.width / 2, r.top + r.height / 2);
    ptr('pointermove', r.left + r.width / 2 + 30, r.top + r.height / 2);
    ptr('pointermove', r.right + 50, r.top + r.height / 2); await wait(150);
    check('with the whole artboard in view, nothing scrolls', V.ox === vox && !C.autoScrolling());
    ptr('pointerup', r.right + 50, r.top + r.height / 2); await wait(20);

    // Moving a layer to the edge carries it along
    await bigAt100();
    C.addImageLayer(image(50, 50, '#ff0000'), 'Red', { x: 200, y: 200 }); await wait(20);
    C.setTool('pointer');
    const red = S.layers[S.layers.length - 1];
    const rx = r.left + (V.ox + 225 * V.s) / dpr, ry = r.top + (V.oy + 225 * V.s) / dpr;
    ptr('pointerdown', rx, ry);
    ptr('pointermove', rx + 30, ry);
    ptr('pointermove', r.right + 30, ry); await wait(50);
    const x0 = S.layers.find(l => l.id === red.id).x; await wait(300);
    const x1 = S.layers.find(l => l.id === red.id).x;
    check('moving a layer to the edge scrolls and keeps carrying it', x1 > x0 + 30 && V.ox < 100 * dpr, `x ${x0} → ${x1}`);
    ptr('pointerup', r.right + 30, ry); await wait(20);
    C.undo(); await wait(20);
    check('...as one undo step', S.layers.find(l => l.name === 'Red')?.x === 200, `x ${S.layers.find(l => l.name === 'Red')?.x}`);
  } catch (e) {
    check('the suite stopped', false, e.message);
  } finally { reset(); }
  return results;
};
