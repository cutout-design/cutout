// Straighten and Clear corners, on made-up scans. Run in Cutout's page, then: await scanTests()
window.scanTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view'), $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y) }));
  const drag = async (x0, y0, x1, y1) => { ptr('pointerdown', x0, y0); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5); ptr('pointerup', x1, y1); await wait(20); };
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), bubbles: true, cancelable: true, ...o }));
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, paint) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); paint(g, w, h); return c; };
  const sel = () => S.sel ? `${S.sel.x},${S.sel.y} ${S.sel.w}x${S.sel.h}` : 'none';
  const menu = async (label, at) => {
    const p = at || (S.sel ? [S.sel.x + S.sel.w / 2, S.sel.y + S.sel.h / 2] : [100, 100]);
    vc.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...client(...p) })); await wait(20);
    const item = [...document.querySelectorAll('#menu .menu-item')].find(b => b.textContent.includes(label));
    if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); throw new Error('menu item missing: ' + label); }
    $('#toast').textContent = ''; item.click(); await wait(40);
    return $('#toast').textContent;
  };
  // a scan: noisy white paper, dark scanner edge on top and left, a card of 560 x 355 tilted by deg
  const scan = (deg, opts = {}) => image(1200, 1000, (g, w, h) => {
    const id = g.createImageData(w, h); let s = 3;
    for (let i = 0; i < w * h; i++) { s = (s * 1103515245 + 12345) >>> 0; const v = 248 + (s >>> 28) % 6; id.data.set([v, v, v, 255], i * 4); }
    g.putImageData(id, 0, 0);
    g.fillStyle = '#262626'; g.fillRect(0, 0, w, 5); g.fillRect(0, 0, 4, h);
    g.save(); g.translate(560, 460); g.rotate(deg * Math.PI / 180);
    g.fillStyle = opts.fill || '#efece5'; g.strokeStyle = '#b3aea4'; g.lineWidth = 1.5;
    g.beginPath(); g.roundRect(-280, -177.5, 560, 355, opts.radius ?? 22); g.fill(); g.stroke();
    if (opts.whiteTop) { g.fillStyle = '#fafafa'; g.fillRect(-250, -177, 500, 22); }
    g.fillStyle = '#222'; for (let k = 0; k < 40; k++) g.fillRect(-250 + k * 8, -150, 4 + (k % 3), 70);
    g.fillStyle = '#5b8fd6'; g.fillRect(-240, 20, 120, 110); g.fillStyle = '#8a5a3a'; g.font = '40px Georgia'; g.fillText('1845', 150, 150);
    g.restore();
  });
  const sizeAfterShrink = async () => { await menu('Shrink to content'); return S.sel ? [S.sel.w, S.sel.h] : [0, 0]; };

  try {
    // Tilted 4°: straighten from a loose selection, then Shrink to content gives the card's own size
    reset(); C.addImageLayer(scan(4), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(150, 120, 980, 820);
    let t = await menu('Straighten');
    const m = /Straightened ([\d.]+)/.exec(t);
    check('4° tilt: straightened by about 4°', m && Math.abs(+m[1] - 4) <= 0.3, t);
    let [sw, sh] = await sizeAfterShrink();
    check('4° tilt: the card is level afterwards (size matches the card)', Math.abs(sw - 563) <= 5 && Math.abs(sh - 358) <= 5, sw + 'x' + sh);
    t = await menu('Straighten');
    check('straightening again: already straight', /Already straight/.test(t) || (/Straightened 0\.[0-2]/.test(t)), t);
    key('z', { ctrlKey: true }); await wait(30); // undoes Straighten (selection changes aren't undo steps)
    check('undo puts the tilted scan back', S.layers[0].canvas.width === 1200 && S.layers[0].x === 0, S.layers[0].canvas.width + ' @ ' + S.layers[0].x);

    // Tilted the other way, straightened from the layer menu with no selection
    reset(); C.addImageLayer(scan(-3), 'Scan'); await wait(30);
    C.setTool('pointer'); S.sel = null; C.changed();
    t = await menu('Straighten', [560, 460]);
    const m2 = /Straightened ([\d.]+)/.exec(t);
    check('-3° tilt, whole layer from the layer menu: straightened by about 3°', m2 && Math.abs(+m2[1] - 3) <= 0.3, t);
    C.setTool('marquee'); await drag(150, 120, 980, 820);
    [sw, sh] = await sizeAfterShrink();
    check('-3° tilt: the card is level afterwards', Math.abs(sw - 563) <= 5 && Math.abs(sh - 358) <= 5, sw + 'x' + sh);
    check('exposed corners are transparent', C.ctx2d(S.layers[0].canvas).getImageData(1, 1, 1, 1).data[3] === 0);

    // Level card: nothing to do; very crooked: refused
    reset(); C.addImageLayer(scan(0), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(150, 120, 980, 820);
    t = await menu('Straighten');
    check('level card: says already straight', /Already straight/.test(t), t);
    reset(); C.addImageLayer(scan(20), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(100, 60, 1040, 900);
    t = await menu('Straighten'); const before = S.layers[0].canvas;
    check('20° tilt: refused, nothing changes', /Too crooked/.test(t) && S.layers[0].canvas === before, t);

    // Clear corners: rounded card with a paper-white strip along its top edge
    reset(); C.addImageLayer(scan(0, { radius: 30, whiteTop: true }), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(150, 120, 980, 820);
    await menu('Shrink to content');
    const r = { ...S.sel }; const L = () => S.layers[0], px = (x, y) => Array.from(C.ctx2d(L().canvas).getImageData(x - L().x, y - L().y, 1, 1).data);
    t = await menu('Clear corners');
    check('clear corners: the corner paper is transparent', [[r.x, r.y], [r.x + r.w - 1, r.y], [r.x, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1]].every(([x, y]) => px(x, y)[3] === 0), t || 'ok');
    check('clear corners: the card inside its rounded corner stays', px(r.x + 30, r.y + 30)[3] === 255);
    check('clear corners: the paper-white strip along the card top stays', px(r.x + r.w / 2, r.y + 3)[3] === 255 && px(r.x + 90, r.y + 3)[3] === 255);
    check('clear corners: the selection is kept', sel() === `${r.x},${r.y} ${r.w}x${r.h}`, sel());
    { // no light halo left right next to the cleared corner
      let halo = 0; for (let k = 0; k < 30; k++) { const yy = r.y + Math.round(30 - Math.sqrt(Math.max(0, 900 - (30 - k) ** 2))) - 1; if (yy < r.y) continue; /* only inside the selection */ const [R, G, B, A] = px(r.x + k, yy); if (A > 200 && R >= 248 && G >= 248) halo++; /* paper-colored, not the outline's soft edge */ }
      check('clear corners: no light halo along the rounded edge', halo <= 3, halo + ' light pixels');
    }
    key('z', { ctrlKey: true }); await wait(30);
    check('undo brings the corners back', px(r.x, r.y)[3] === 255);

    // The real workflow: straighten a tilted rounded card, shrink, crop to it, deselect, then Clear
    // corners from the layer menu (the corners of the crop are the transparent wedges Straighten left)
    reset(); C.addImageLayer(scan(4, { radius: 30, whiteTop: true }), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(150, 120, 980, 820);
    await menu('Straighten'); await menu('Shrink to content'); await menu('Trim to selection');
    S.sel = null; C.setTool('pointer'); C.changed(); await wait(20);
    const A = S.artboard;
    t = await menu('Clear corners', [A.w / 2, A.h / 2]);
    const pxA = (x, y) => Array.from(C.ctx2d(L().canvas).getImageData(x - L().x, y - L().y, 1, 1).data);
    const cornerAlphas = [[3, 3], [A.w - 4, 3], [3, A.h - 4], [A.w - 4, A.h - 4]].map(([x, y]) => pxA(x, y)[3]);
    check('after straighten + crop, Clear corners from the layer menu clears all four', cornerAlphas.every(a => a < 40), cornerAlphas.join(',') + ' ' + (t || ''));
    check('...and keeps the card inside its corners', pxA(32, 32)[3] === 255 && pxA(A.w - 33, A.h - 33)[3] === 255);
    check('...and keeps the paper-white strip along the top', pxA(A.w / 2, 4)[3] === 255);

    // The usual sequence: no selection → Shrink to content (layer menu) → Straighten → Trim to
    // selection → Clear corners. The card's bottom band is colored so a paper strip would show.
    reset(); C.addImageLayer(scan(4, { radius: 30 }), 'Scan'); await wait(30);
    S.sel = null; C.setTool('pointer'); C.changed(); await wait(20);
    await menu('Shrink to content', [560, 460]);
    const tilted = sel();
    await menu('Straighten');
    check('Straighten re-fits the Shrink to content selection to the leveled card', S.sel && Math.abs(S.sel.w - 563) <= 5 && Math.abs(S.sel.h - 358) <= 5, tilted + ' -> ' + sel());
    t = await menu('Trim to selection');
    const B = S.artboard;
    { const vc2 = document.querySelector('#view'), sc = C.view.s, cx = C.view.ox + B.w * sc / 2, cy = C.view.oy + B.h * sc / 2;
      check('Trim to selection re-fits the view: the card is centered', Math.abs(cx - vc2.width / 2) <= 2 && Math.abs(cy - vc2.height / 2) <= 2, Math.round(cx) + ',' + Math.round(cy) + ' vs ' + vc2.width / 2 + ',' + vc2.height / 2); }
    check('Trim to selection: the artboard is the card, and nothing hangs outside', Math.abs(B.w - 563) <= 5 && Math.abs(B.h - 358) <= 5 && S.layers.every(l => l.x >= 0 && l.y >= 0 && l.x + l.canvas.width <= B.w && l.y + l.canvas.height <= B.h), `${B.w}x${B.h} ${t}`);
    { // no paper strip: the edge rows and columns are mostly card, not paper-white
      const comp = C.makeCanvas(B.w, B.h), cg = C.ctx2d(comp); for (const l of S.layers) cg.drawImage(l.canvas, l.x, l.y);
      const dd = cg.getImageData(0, 0, B.w, B.h).data, paper = (x, y) => { const o = (y * B.w + x) * 4; return dd[o + 3] > 200 && dd[o] >= 246 && dd[o + 1] >= 246; };
      const frac = (cells) => cells.filter(([x, y]) => paper(x, y)).length / cells.length;
      const mid = k => Array.from({ length: B.w - 120 }, (_, i) => [60 + i, k]), midC = k => Array.from({ length: B.h - 120 }, (_, i) => [k, 60 + i]);
      const fr = [frac(mid(2)), frac(mid(B.h - 3)), frac(midC(2)), frac(midC(B.w - 3))];
      check('no paper strip along any edge after trimming', fr.every(f => f < 0.1), fr.map(f => f.toFixed(2)).join(','));
    }
    t = await menu('Clear corners', [B.w / 2, B.h / 2]);
    const pxB = (x, y) => Array.from(C.ctx2d(L().canvas).getImageData(x - L().x, y - L().y, 1, 1).data);
    { const al = [[1, 1], [B.w - 2, 1], [1, B.h - 2], [B.w - 2, B.h - 2]].map(([x, y]) => pxB(x, y)); check('then Clear corners clears all four corners', al.every(p => p[3] < 40), al.map(p => p.join('/')).join(' ') + ' ' + (t || '')); }
    key('z', { ctrlKey: true }); await wait(30); key('z', { ctrlKey: true }); await wait(30);
    check('undo twice: corners back, then the trim undone in one step', S.artboard.w === 1200 && S.artboard.h === 1000, S.artboard.w + 'x' + S.artboard.h);

    // Square corners: nothing to clear
    reset(); C.addImageLayer(scan(0, { radius: 0 }), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(150, 120, 980, 820); await menu('Shrink to content');
    t = await menu('Clear corners');
    check('square card: says there is no background in the corners', /No background in the corners/.test(t), t);

    // A card pushed into the scanner's top-left corner, its top cut off by the scan, a dark scanner
    // line along the top beside it and down the right side, and a deeper blob where they meet
    // (a real scan: Shrink to content with no selection ran to the right edge; Clear corners then
    // cleared "corners" inside the card where its plain white top ends)
    reset();
    C.addImageLayer(image(1600, 2000, (g, w, h) => {
      const id = g.createImageData(w, h); let s = 7;
      for (let i = 0; i < w * h; i++) { s = (s * 1103515245 + 12345) >>> 0; const v = 249 + (s >>> 28) % 5; id.data.set([v, v, v, 255], i * 4); }
      g.putImageData(id, 0, 0);
      g.fillStyle = '#262626'; g.fillRect(990, 0, w - 990, 5); g.fillRect(w - 4, 0, 4, h); g.fillRect(w - 45, 0, 45, 17);
      g.fillStyle = '#fbfbfb'; g.strokeStyle = '#b3aea4'; g.lineWidth = 1.5;
      g.beginPath(); g.roundRect(6, -60, 1000, 700, 26); g.fill(); g.stroke();
      g.fillStyle = '#222'; for (let k = 0; k < 60; k++) g.fillRect(70 + k * 10, 53, 5 + (k % 3), 110);
      g.fillStyle = '#5b8fd6'; g.fillRect(60, 400, 220, 180); g.fillStyle = '#8a5a3a'; g.font = '60px Georgia'; g.fillText('1845', 800, 560);
    }), 'Scan'); await wait(30);
    C.setTool('pointer'); S.sel = null; C.changed();
    await menu('Shrink to content', [400, 300]);
    const shrunk = sel();
    check('card in the scan corner, no selection: Shrink to content stops at the card, not the scanner line', S.sel && S.sel.x + S.sel.w <= 1012 && S.sel.w >= 990, shrunk);
    await menu('Trim to selection');
    S.sel = null; C.changed();
    await menu('Clear corners', [400, 300]);
    const L2 = S.layers[0], pxL = (x, y) => Array.from(C.ctx2d(L2.canvas).getImageData(x - L2.x, y - L2.y, 1, 1).data), A2 = S.artboard;
    check('cut-off top: Clear corners leaves the top of the card alone', [[3, 3], [A2.w - 4, 3], [3, 45], [A2.w - 4, 45]].every(([x, y]) => pxL(x, y)[3] === 255), [[3, 3], [3, 45]].map(([x, y]) => pxL(x, y)[3]).join(','));
    check('...and clears the rounded bottom corners', [[1, A2.h - 2], [A2.w - 2, A2.h - 2]].every(([x, y]) => pxL(x, y)[3] < 40), [[1, A2.h - 2], [A2.w - 2, A2.h - 2]].map(([x, y]) => pxL(x, y)[3]).join(',') + ' shrink ' + shrunk + ' artboard ' + A2.w + 'x' + A2.h);

    // A card cropped with a bit of scanner edge in one corner (a real scan: a dark patch in the
    // bottom-left made that corner read square, and it was skipped)
    reset();
    C.addImageLayer(image(800, 500, (g, w, h) => {
      g.fillStyle = '#fbfbfb'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#efece5'; g.strokeStyle = '#8f8a80'; g.lineWidth = 2;
      g.beginPath(); g.roundRect(1, 1, w - 2, h - 2, 26); g.fill(); g.stroke();
      g.fillStyle = '#222'; for (let k = 0; k < 40; k++) g.fillRect(60 + k * 12, 60, 6, 90);
      g.fillStyle = '#262626'; g.fillRect(0, h - 22, 4, 22); // the patch of scanner edge
    }), 'Card'); await wait(30);
    C.setTool('pointer'); S.sel = null; C.changed();
    t = await menu('Clear corners', [400, 250]);
    { const L3 = S.layers[0], a3 = (x, y) => C.ctx2d(L3.canvas).getImageData(x - L3.x, y - L3.y, 1, 1).data[3];
      check('a dark patch in a corner: that corner is still cleared around it', a3(8, 497) < 40 && a3(2, 2) < 40 && a3(797, 497) < 40, [a3(8, 497), a3(2, 2), a3(797, 497)].join(',') + ' ' + t); }

    // The More menu has both
    $('#selMore').click(); await wait(20);
    const items = [...document.querySelectorAll('#menu .menu-item')].map(b => b.textContent);
    check('More menu lists Straighten and Clear corners', items.some(x => x.includes('Straighten')) && items.some(x => x.includes('Clear corners')));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  } catch (e) { results.push('FAIL  exception: ' + (e && e.stack || e)); }
  return results.join('\n');
};
