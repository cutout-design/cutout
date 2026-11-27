// Selections stay inside the artboard (like Fireworks). Run in Cutout's page, then: await clipTests()
window.clipTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view'), $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y), ...o }));
  let sizeDuring = '';
  const drag = async (x0, y0, x1, y1, o = {}) => { ptr('pointerdown', x0, y0, o); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5, o); sizeDuring = $('#selSize').textContent; ptr('pointerup', x1, y1, o); await wait(20); };
  const click = async (x, y, o = {}) => { ptr('pointerdown', x, y, o); ptr('pointerup', x, y, o); await wait(20); };
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), bubbles: true, cancelable: true, ...o }));
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, color) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; };
  const sel = () => S.sel ? `${S.sel.x},${S.sel.y} ${S.sel.w}x${S.sel.h}` : 'none';
  const savedColor = S.opts.color, savedFill = S.opts.fillWith;

  try {
    reset(); C.addImageLayer(image(400, 300, '#3366ff'), 'Blue'); await wait(20);
    C.setTool('marquee');
    await drag(300, 200, 480, 360);
    check('marquee dragged past the edge stops at it', sel() === '300,200 100x100', sel());
    check('size readout shows the clipped size while dragging', sizeDuring === '100 × 100', sizeDuring);
    await drag(-50, -40, 60, 50);
    check('works past the top-left corner too', sel() === '0,0 60x50', sel());
    await drag(450, 50, 520, 120);
    check('a drag entirely outside the artboard selects nothing', S.sel === null, sel());

    // Grow at the edge does nothing; grow elsewhere still works
    await drag(300, 100, 400, 200);
    key('ArrowRight', { ctrlKey: true }); await wait(20);
    check('Ctrl+Right at the right edge doesn\'t grow past it', sel() === '300,100 100x100', sel());
    key('ArrowLeft', { ctrlKey: true }); await wait(20);
    check('Ctrl+Left still grows inside', sel() === '299,100 101x100', sel());

    // Invert stays inside, even with a layer sticking out
    reset(); C.addImageLayer(image(400, 300, '#3366ff'), 'Blue'); await wait(20);
    C.addImageLayer(image(200, 100, '#ff0000'), 'Red', { x: 300, y: -50 }); await wait(20);
    C.setTool('marquee'); await drag(10, 10, 50, 50);
    key('i', { ctrlKey: true, shiftKey: true }); await wait(20);
    check('invert stays inside the artboard', S.sel && S.sel.x >= 0 && S.sel.y >= 0 && S.sel.x + S.sel.w <= 400 && S.sel.y + S.sel.h <= 300, sel());

    // Wand on a layer that sticks out past the artboard
    S.sel = null; C.changed(); C.setTool('wand'); await click(350, 20);
    check('wand selection on a layer sticking out is clipped', sel() === '300,0 100x50', sel());

    // Moving a selection keeps its shape; commands use the part inside
    reset(); C.addImageLayer(image(400, 300, '#3366ff'), 'Blue'); await wait(20);
    C.setTool('marquee'); await drag(300, 100, 380, 180);
    for (let i = 0; i < 6; i++) key('ArrowRight', { shiftKey: true });
    await wait(20);
    check('moving past the edge keeps the selection\'s shape', sel() === '360,100 80x80', sel());
    const blue = S.layers[0];
    S.opts.color = '#00ff00';
    key('Backspace', { altKey: true }); await wait(30);
    const L = S.layers[0];
    check('Fill with color doesn\'t grow the layer past the artboard', L.canvas.width === 400 && L.canvas.height === 300 && L.x === 0, `${L.x},${L.y} ${L.canvas.width}x${L.canvas.height}`);
    check('...and fills the part inside', Array.from(C.ctx2d(L.canvas).getImageData(390, 150, 1, 1).data).join() === '0,255,0,255');
    key('z', { ctrlKey: true }); await wait(30);
    for (let i = 0; i < 6; i++) key('ArrowLeft', { shiftKey: true });
    await wait(20);
    check('moving back restores the whole selection', sel() === '300,100 80x80', sel());

    // Entirely outside: commands say so
    for (let i = 0; i < 12; i++) key('ArrowRight', { shiftKey: true });
    await wait(20); $('#toast').textContent = '';
    const before = S.layers[0].canvas;
    key('Delete'); await wait(30);
    check('a selection moved fully outside: Delete says so', S.layers[0].canvas === before && $('#toast').textContent === 'Selection is outside the artboard', $('#toast').textContent);

    // Crop to selection uses the part inside
    for (let i = 0; i < 12; i++) key('ArrowLeft', { shiftKey: true });
    for (let i = 0; i < 4; i++) key('ArrowRight', { shiftKey: true });
    await wait(20);
    document.querySelector('#selMore').click(); await wait(20);
    [...document.querySelectorAll('#menu .menu-item')].find(b => /Trim to selection/.test(b.textContent)).click(); await wait(30);
    check('crop to selection uses the part inside the artboard', S.artboard.w === 60 && S.artboard.h === 80, `${S.artboard.w}x${S.artboard.h}`);
  } catch (e) { results.push('FAIL  exception: ' + (e && e.stack || e)); }
  S.opts.color = savedColor; S.opts.fillWith = savedFill; C.changed();
  return results.join('\n');
};
