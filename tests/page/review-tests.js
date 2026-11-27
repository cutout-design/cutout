// Checks from the code review: commands wait while a drag is in progress; a drag whose button was
// released out of sight ends on the next mouse move. Run: await reviewTests()
window.reviewTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view');
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y), ...o }));
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k, bubbles: true, cancelable: true, ...o }));
  const image = (w, h, color) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; };
  const setup = async () => {
    S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed();
    C.addImageLayer(image(400, 300, '#ffffff'), 'Paper'); await wait(20);
    C.addImageLayer(image(60, 60, '#ff0000'), 'Red', { x: 20, y: 20 }); await wait(20);
    return () => S.layers.find(l => l.name === 'Red');
  };
  try {
    let red = await setup();
    ptr('pointerdown', 40, 40); ptr('pointermove', 60, 40, { ctrlKey: true }); ptr('pointermove', 90, 40, { ctrlKey: true });
    key('z', { ctrlKey: true }); // mid-drag: must wait (no pause here: a real mouse move over the test window would end the drag)
    check('undo mid-drag is ignored', red() && red().x === 70, 'x ' + (red() && red().x));
    ptr('pointermove', 140, 40, { ctrlKey: true }); ptr('pointerup', 140, 40); await wait(20);
    check('the drag carries on to its end', red().x === 120, 'x ' + red().x);
    key('Delete'); await wait(20);
    check('keys work again after the drag', !red());
    key('z', { ctrlKey: true }); await wait(20); key('z', { ctrlKey: true }); await wait(20);
    check('one undo step for the whole move', red() && red().x === 20, 'x ' + (red() && red().x));

    red = await setup();
    ptr('pointerdown', 40, 40); ptr('pointermove', 60, 40, { ctrlKey: true });
    ptr('pointermove', 200, 40, { buttons: 0, ctrlKey: true }); await wait(20); // released out of sight
    check('a move with no button down ends the drag', red().x === 40, 'x ' + red().x);
    ptr('pointermove', 260, 40, { buttons: 0 }); await wait(20);
    check('...and the layer stays put afterwards', red().x === 40, 'x ' + red().x);

    // pixel commands leave a hidden layer alone
    red = await setup();
    const L = red(); S.selected = new Set([L.id]); S.active = L.id; L.visible = false;
    S.sel = { x: 25, y: 25, w: 10, h: 10, mask: new Uint8Array(100).fill(1) }; C.changed();
    const cv = L.canvas, nLayers = S.layers.length, toastNow = () => document.querySelector('#toast').textContent;
    key('Delete'); await wait(20);
    check('Delete does nothing on a hidden layer', red().canvas === cv && toastNow() === 'The layer is hidden', toastNow());
    key('Backspace', { altKey: true }); await wait(20);
    check('Fill does nothing on a hidden layer', red().canvas === cv);
    key('j', { ctrlKey: true, shiftKey: true }); await wait(20);
    check('Cut to layer does nothing on a hidden layer', S.layers.length === nLayers && red().canvas === cv);
    key('Backspace', { shiftKey: true }); await wait(200);
    check('Smart fill does nothing on a hidden layer', red().canvas === cv);
    red().visible = true; C.changed(); key('Delete'); await wait(20);
    check('...and works again once the layer is shown', red().canvas !== cv);
    S.sel = null; C.changed();

    // Cut puts the layers back when the clipboard doesn't take the image
    red = await setup();
    S.selected = new Set([red().id]); S.active = red().id; C.changed();
    const realWrite = Clipboard.prototype.write; Clipboard.prototype.write = () => Promise.reject(new Error('no clipboard'));
    try { key('x', { ctrlKey: true }); await wait(150); } finally { Clipboard.prototype.write = realWrite; }
    check('a failed cut leaves the layer in place', !!red(), document.querySelector('#toast').textContent);
    check('...and says so', /nothing was cut/.test(document.querySelector('#toast').textContent), document.querySelector('#toast').textContent);
    check('...with nothing left to redo', document.querySelector('#btnRedo').disabled);
    key('x', { ctrlKey: true }); await wait(250);
    check('a normal cut still removes the layer', !red(), document.querySelector('#toast').textContent);

    // a dropped image file with no type is recognized by its name
    await setup(); const nBefore = S.layers.length;
    const png = await new Promise(r => image(24, 16, '#00ff00').toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([png], 'Photo.PNG', { type: '' }));
    document.querySelector('#stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    for (let i = 0; i < 60 && S.layers.length === nBefore; i++) await wait(30);
    const added = S.layers.find(l => l.name === 'Photo');
    check('an untyped .PNG file opens', !!added && added.canvas.width === 24, document.querySelector('#toast').textContent);
    const dt2 = new DataTransfer(); dt2.items.add(new File(['hello'], 'notes.txt', { type: '' }));
    document.querySelector('#stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt2, bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); await wait(100);
    check('a file that is not an image still says so', document.querySelector('#toast').textContent === 'Not an image', document.querySelector('#toast').textContent);

    // Esc mid-drag takes the whole drag back (no pauses mid-drag: see above)
    red = await setup();
    ptr('pointerdown', 40, 40); ptr('pointermove', 90, 70, { ctrlKey: true }); const during = red().x;
    key('Escape'); ptr('pointermove', 150, 90, { ctrlKey: true }); ptr('pointerup', 150, 90); await wait(20);
    check('Esc mid-move puts the layer back', during === 70 && red().x === 20 && red().y === 20, 'during ' + during + ', after ' + red().x + ',' + red().y);
    key('z', { ctrlKey: true }); await wait(20);
    check('...and leaves no undo step behind', !red(), 'undo went to the step before the drag');
    key('z', { ctrlKey: true, shiftKey: true }); await wait(20);
    const n0 = S.layers.length;
    ptr('pointerdown', 40, 40, { altKey: true }); ptr('pointermove', 100, 40, { altKey: true, ctrlKey: true }); const nDup = S.layers.length;
    key('Escape'); ptr('pointerup', 100, 40); await wait(20);
    check('Esc mid Alt-drag removes the duplicate', nDup === n0 + 1 && S.layers.length === n0, n0 + ' → ' + nDup + ' → ' + S.layers.length);
    C.setTool('eraser'); const cvE = red().canvas;
    ptr('pointerdown', 40, 40); ptr('pointermove', 60, 60); const erasing = red().canvas !== cvE;
    key('Escape'); ptr('pointerup', 60, 60); await wait(20);
    check('Esc mid-erase restores the pixels', erasing && red().canvas === cvE);
    C.setTool('pointer');

    // New document: empty, default artboard, one undo step
    red = await setup();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', code: 'Digit0', ctrlKey: true, bubbles: true, cancelable: true })); await wait(30);
    const v0 = { s: C.view.s, ox: Math.round(C.view.ox), oy: Math.round(C.view.oy) };
    key('n', { ctrlKey: true }); await wait(30);
    check('New empties the document', S.layers.length === 0 && S.artboard.w === 800 && S.artboard.h === 600 && !S.sel, S.layers.length + ' layers, ' + S.artboard.w + 'x' + S.artboard.h);
    key('z', { ctrlKey: true }); await wait(30);
    check('...and Undo brings everything back', S.layers.length === 2 && S.artboard.w === 400);
    const v1 = { s: C.view.s, ox: Math.round(C.view.ox), oy: Math.round(C.view.oy) };
    check('...with the artboard where it was on screen', v1.s === v0.s && v1.ox === v0.ox && v1.oy === v0.oy, JSON.stringify(v0) + ' vs ' + JSON.stringify(v1));
    // a view the user set (zoomed, panned) comes back too
    C.view.s = v0.s * 2; C.view.ox = 37; C.view.oy = 53; vc.dispatchEvent(new WheelEvent('wheel', { deltaY: 0, deltaX: 0, bubbles: true, cancelable: true })); await wait(20);
    const u0 = { s: C.view.s, ox: Math.round(C.view.ox), oy: Math.round(C.view.oy) };
    key('n', { ctrlKey: true }); await wait(30); key('z', { ctrlKey: true }); await wait(30);
    const u1 = { s: C.view.s, ox: Math.round(C.view.ox), oy: Math.round(C.view.oy) };
    check('...also when the view was zoomed and panned by hand', u1.s === u0.s && u1.ox === u0.ox && u1.oy === u0.oy, JSON.stringify(u0) + ' vs ' + JSON.stringify(u1));
    // steps that don't resize the artboard leave the view alone
    key('ArrowRight'); await wait(20); C.view.ox += 11; key('z', { ctrlKey: true }); await wait(20);
    check('undoing an ordinary step keeps the current view', Math.round(C.view.ox) === u1.ox + 11, Math.round(C.view.ox) + ' vs ' + (u1.ox + 11));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', code: 'Digit0', ctrlKey: true, bubbles: true, cancelable: true })); await wait(20);
    document.querySelector('#appMenu').click(); await wait(30);
    check('the Cutout menu has no New or Open', ![...document.querySelectorAll('#menu .menu-item')].some(b => /^(New|Open)/.test(b.textContent.trim())));
    document.querySelector('#appMenu').click(); await wait(30);

    // a second Smart fill while one runs says so
    red = await setup(); const paper = S.layers.find(l => l.name === 'Paper'); S.selected = new Set([paper.id]); S.active = paper.id;
    S.sel = { x: 200, y: 150, w: 30, h: 30, mask: new Uint8Array(900).fill(1) }; C.changed();
    key('Backspace', { shiftKey: true }); key('Backspace', { shiftKey: true });
    check('a second Smart fill says it is still filling', document.querySelector('#toast').textContent === 'Still filling…', document.querySelector('#toast').textContent);
    for (let i = 0; i < 100 && S.layers.find(l => l.name === 'Paper').canvas === paper.canvas; i++) await wait(50);
    S.sel = null; C.changed();

    // the security policy is on: generated and inline code can't run
    const viol = []; const onV = e => viol.push(e.violatedDirective); document.addEventListener('securitypolicyviolation', onV);
    const sc = document.createElement('script'); sc.textContent = 'window.__inlineRan = true'; document.head.append(sc); sc.remove();
    const im = new Image(); im.src = 'http://example.invalid/x.png'; await wait(150);
    document.removeEventListener('securitypolicyviolation', onV);
    check('inline script is blocked', !window.__inlineRan && viol.some(v => /script-src/.test(v)), viol.join(' | '));
    check('a plain http image is blocked', viol.some(v => /img-src/.test(v)));
  } catch (e) { results.push('FAIL  threw: ' + e.message); }
  return results;
};
