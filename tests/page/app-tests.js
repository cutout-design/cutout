// End-to-end tests of Cutout's editing features, driven like a user (pointer events on the canvas,
// keys, buttons). Run by tests/run.mjs (npm test).
window.appTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view'), $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y), ...o }));
  const drag = async (x0, y0, x1, y1, o = {}) => { ptr('pointerdown', x0, y0, o); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5, o); ptr('pointerup', x1, y1, o); await wait(20); };
  const click = async (x, y, o = {}) => { ptr('pointerdown', x, y, o); ptr('pointerup', x, y, o); await wait(20); };
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), bubbles: true, cancelable: true, ...o }));
  const px = (l, x, y) => Array.from(C.ctx2d(l.canvas).getImageData(x - l.x, y - l.y, 1, 1).data);
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, paint) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); paint(g, w, h); return c; };
  const halves = () => image(200, 100, g => { g.fillStyle = '#ff0000'; g.fillRect(0, 0, 100, 100); g.fillStyle = '#0000ff'; g.fillRect(100, 0, 100, 100); });

  try {
    // Open / first layer sets the artboard
    reset(); C.addImageLayer(halves(), 'Halves'); await wait(20);
    check('first image sets the artboard', S.artboard.w === 200 && S.artboard.h === 100 && S.layers.length === 1);

    // Marquee → selection, Ctrl+J copy to layer, undo / redo
    C.setTool('marquee'); await drag(10, 10, 60, 40);
    check('marquee selects 50 x 30', S.sel && S.sel.w === 50 && S.sel.h === 30, S.sel ? `${S.sel.w}x${S.sel.h}` : 'none');
    key('j', { ctrlKey: true }); await wait(20);
    const top = S.layers[S.layers.length - 1];
    check('Ctrl+J copies the selection to a new layer', S.layers.length === 2 && top.canvas.width === 50 && top.canvas.height === 30 && top.x === 10 && top.y === 10);
    key('z', { ctrlKey: true }); await wait(20);
    check('undo removes it', S.layers.length === 1);
    key('z', { ctrlKey: true, shiftKey: true }); await wait(20);
    check('redo brings it back', S.layers.length === 2);

    // Delete pixels and fill
    reset(); C.addImageLayer(halves(), 'Halves'); C.setTool('marquee'); await drag(20, 20, 40, 40);
    key('Delete'); await wait(20);
    let L = S.layers[0];
    check('Delete clears the selected pixels', px(L, 30, 30)[3] === 0 && px(L, 50, 50)[3] === 255);
    key('Backspace', { altKey: true }); await wait(20); L = S.layers[0];
    const fill = px(L, 30, 30), want = S.opts.color.match(/\w\w/g).map(h => parseInt(h, 16));
    check('Alt+Backspace fills the selection', fill[3] === 255 && fill[0] === want[0] && fill[1] === want[1] && fill[2] === want[2], fill.join(','));

    // Magic wand (and a repeat click, which reuses the pixels), invert
    reset(); C.addImageLayer(halves(), 'Halves'); C.setTool('wand');
    let t0 = performance.now(); await click(30, 50); const first = performance.now() - t0;
    check('wand selects the red half', S.sel && S.sel.x === 0 && S.sel.w === 100 && S.sel.h === 100, S.sel ? `${S.sel.x},${S.sel.y} ${S.sel.w}x${S.sel.h}` : 'none');
    t0 = performance.now(); await click(150, 50); const second = performance.now() - t0;
    check('wand on the other half', S.sel && S.sel.x === 100 && S.sel.w === 100, `${Math.round(first)} ms, then ${Math.round(second)} ms`);
    key('i', { ctrlKey: true, shiftKey: true }); await wait(20);
    check('Ctrl+Shift+I inverts the selection', S.sel && S.sel.x === 0 && S.sel.w === 100);

    // Bucket
    reset(); C.addImageLayer(halves(), 'Halves'); C.setTool('bucket'); await click(150, 50); L = S.layers[0];
    const b = px(L, 150, 50);
    check('bucket fills the blue half', b[0] === want[0] && b[2] === want[2] && px(L, 50, 50)[0] === 255, b.join(','));

    // Eraser
    reset(); C.addImageLayer(halves(), 'Halves'); C.setTool('eraser'); await drag(20, 50, 180, 50); L = S.layers[0];
    check('eraser clears along the stroke', px(L, 100, 50)[3] === 0 && px(L, 100, 5)[3] === 255);
    key('z', { ctrlKey: true }); await wait(20); L = S.layers[0];
    check('undo restores the erased pixels', px(L, 100, 50)[3] === 255);

    // Flip
    reset(); C.addImageLayer(halves(), 'Halves'); C.setTool('pointer'); S.selected = new Set([S.layers[0].id]); S.active = S.layers[0].id; C.changed();
    key('H', { shiftKey: true, code: 'KeyH' }); await wait(20); L = S.layers[0];
    check('Shift+H flips horizontally', px(L, 10, 10)[2] === 255 && px(L, 190, 10)[0] === 255);

    // Scale with the W field, duplicate keeps Original size
    reset(); C.addImageLayer(halves(), 'Halves'); C.setTool('pointer'); S.selected = new Set([S.layers[0].id]); S.active = S.layers[0].id; C.changed();
    const lw = $('#lw'); lw.value = '100'; lw.dispatchEvent(new Event('change')); await wait(20); L = S.layers[0];
    check('W field scales the layer (proportions kept)', L.canvas.width === 100 && L.canvas.height === 50, `${L.canvas.width}x${L.canvas.height}`);
    document.querySelector('[data-cmd="originalSize"]'); // (button exists)
    // Duplicate via the layer menu's function: right-click on the layer, then pick Duplicate
    vc.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...client(20, 20) })); await wait(20);
    const dupItem = [...document.querySelectorAll('#menu .menu-item')].find(x => /Duplicate/.test(x.textContent)); dupItem.click(); await wait(20);
    const dup = S.layers[S.layers.length - 1];
    check('a duplicate of a scaled layer keeps Original size', S.layers.length === 2 && dup.src && dup.src.width === 200 && !$('#btnOrig').disabled);
    $('#btnOrig').click(); await wait(20);
    check('Original size restores the duplicate', S.layers[S.layers.length - 1].canvas.width === 200);

    // Cut layers: hidden selected layers aren't removed
    reset(); C.addImageLayer(halves(), 'A'); C.addImageLayer(halves(), 'B', { x: 0, y: 0 });
    const [A, B] = S.layers; B.visible = false; S.selected = new Set([A.id, B.id]); S.active = A.id; C.changed();
    key('x', { ctrlKey: true }); await wait(50);
    check('Ctrl+X on layers keeps the hidden one', S.layers.length === 1 && S.layers[0].id === B.id);

    // Align and distribute
    reset(); C.addImageLayer(halves(), 'Bg'); S.layers.length = 0;
    // (the first image added to an empty document becomes the artboard, so place them afterwards)
    const box = (x, y) => { const l = C.addImageLayer(image(20, 20, g => { g.fillStyle = '#0a0'; g.fillRect(0, 0, 20, 20); }), null, { x, y }); l.x = x; l.y = y; return l; };
    const b1 = box(10, 10), b2 = box(100, 60), b3 = box(300, 30);
    S.artboard.w = 400; S.artboard.h = 300;
    S.selected = new Set([b1.id, b2.id, b3.id]); S.active = b3.id; C.changed();
    key('a', { altKey: true, code: 'KeyA' }); await wait(20);
    check('Alt+A aligns left edges', b1.x === 10 && b2.x === 10 && b3.x === 10);
    b2.y = 40; b3.y = 250; C.changed(); key('V', { altKey: true, shiftKey: true, code: 'KeyV' }); await wait(20);
    check('Alt+Shift+V distributes vertically', Math.abs((b2.y - (b1.y + 20)) - (b3.y - (b2.y + 20))) <= 1, `${b1.y}, ${b2.y}, ${b3.y}`);

    // Trim and fit
    S.selected.clear(); S.active = null; C.changed();
    key('t', { ctrlKey: true, altKey: true, code: 'KeyT' }); await wait(20);
    check('Ctrl+Alt+T trims the artboard to content', S.artboard.w === 20 && S.artboard.h === 260, `${S.artboard.w}x${S.artboard.h}`);
    S.layers[0].x = -50; C.changed(); key('f', { ctrlKey: true, altKey: true, code: 'KeyF' }); await wait(20);
    check('Ctrl+Alt+F fits the artboard to the layers', S.artboard.w === 70, `${S.artboard.w}x${S.artboard.h}`);

    // Artboard width field with math
    reset(); C.addImageLayer(halves(), 'Halves'); S.selected.clear(); S.active = null; C.changed();
    const aw = $('#aw'); aw.value = '*2'; aw.dispatchEvent(new Event('change')); await wait(20);
    check('artboard W field takes math (*2)', S.artboard.w === 400, `${S.artboard.w}`);

    // Image size dialog
    key('i', { ctrlKey: true, altKey: true, code: 'KeyI' }); await wait(20);
    $('#iw').value = '50%'; $('#iw').dispatchEvent(new Event('change'));
    $('#dlgImage form').requestSubmit($('#dlgImage button[value="ok"]')); await wait(50);
    check('Image size scales artboard and layers', S.artboard.w === 200 && S.layers[0].canvas.width === 100, `${S.artboard.w}, layer ${S.layers[0].canvas.width}`);

    // Paste an image (paste event with a PNG file)
    reset(); const pc = halves(), blob = await new Promise(r => pc.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && !S.layers.length; i++) await wait(20);
    check('pasting an image adds a layer', S.layers.length === 1 && S.layers[0].canvas.width === 200);

    // Layer row drag-out preparation keeps only one PNG
    let made = 0, freed = 0; const cu = URL.createObjectURL, ru = URL.revokeObjectURL;
    URL.createObjectURL = o => { made++; return cu.call(URL, o); }; URL.revokeObjectURL = u => { freed++; return ru.call(URL, u); };
    try {
      C.addImageLayer(halves(), 'Second'); await wait(20);
      for (let i = 0; i < 6; i++) { const rows = document.querySelectorAll('#layers .layer'); rows[i % 2].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await wait(60); }
    } finally { URL.createObjectURL = cu; URL.revokeObjectURL = ru; }
    check('layer rows keep at most one prepared PNG', made - freed <= 1, `${made} made, ${freed} released`);

    // History stays small
    reset(); C.addImageLayer(image(2000, 1500, g => { g.fillStyle = '#888'; g.fillRect(0, 0, 2000, 1500); }), 'Big');
    C.setTool('marquee');
    for (let i = 0; i < 5; i++) { await drag(100 + i * 50, 100, 140 + i * 50, 140); key('Delete'); await wait(20); }
    await wait(600); C.compactHistory();
    check('undo history stays small after edits', C.historyBytes() < 2e6, `${(C.historyBytes() / 1e6).toFixed(2)} MB`);
  } catch (e) { results.push('ERROR ' + e.message + ' ' + (e.stack || '').split('\n')[1]); }
  reset();
  return results.join('\n');
};
