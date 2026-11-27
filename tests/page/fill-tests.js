// Tests of "Fill with: Color / Surroundings", driven like a user. Run in Cutout's page, then: await fillTests()
window.fillTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view'), $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y), ...o }));
  const drag = async (x0, y0, x1, y1) => { ptr('pointerdown', x0, y0); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5); ptr('pointerup', x1, y1); await wait(20); };
  const click = async (x, y) => { ptr('pointerdown', x, y); ptr('pointerup', x, y); await wait(20); };
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), bubbles: true, cancelable: true, ...o }));
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, paint) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); paint(g, w, h); return c; };
  const layer = () => S.layers[S.layers.length - 1];
  const region = (l, x, y, w, h) => C.ctx2d(l.canvas).getImageData(x - l.x, y - l.y, w, h).data;
  // largest difference from an expected color over a region
  const maxDiff = (d, rgb) => { let m = 0; for (let i = 0; i < d.length; i += 4) m = Math.max(m, Math.abs(d[i] - rgb[0]), Math.abs(d[i + 1] - rgb[1]), Math.abs(d[i + 2] - rgb[2]), 255 - d[i + 3]); return m; };
  const setSel = (id, v) => { const el = $(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  const setFillWith = v => setSel('#selFill', v), setBucket = v => setSel('#bucketFill', v);
  const until = async (cond, ms = 20000) => { const t0 = performance.now(); while (!cond() && performance.now() - t0 < ms) await wait(20); return cond(); };
  const flatWithBox = () => image(400, 300, g => { g.fillStyle = '#f9fafb'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#1f2937'; g.fillRect(150, 100, 100, 60); g.fillStyle = '#f59e0b'; g.fillRect(160, 110, 20, 20); });
  const savedFillWith = S.opts.fillWith, savedBucket = S.opts.bucketFill, savedColor = S.opts.color;

  try {
    // Default stays Color, and Alt+Backspace still fills with the color
    reset(); C.addImageLayer(flatWithBox(), 'Shot'); await wait(20);
    setFillWith('color');
    S.opts.color = '#ff0000';
    C.setTool('marquee'); await drag(140, 90, 260, 170);
    key('Backspace', { altKey: true }); await wait(30);
    check('Alt+Backspace fills with the color', maxDiff(region(layer(), 145, 95, 110, 70), [255, 0, 0]) === 0);
    key('z', { ctrlKey: true }); await wait(30);

    // Shift+Backspace fills from surroundings: the box is gone, the background continues
    const before = layer().canvas;
    key('Backspace', { shiftKey: true });
    const done = await until(() => layer().canvas !== before);
    check('Shift+Backspace smart-fills', done && maxDiff(region(layer(), 140, 90, 120, 80), [249, 250, 251]) <= 1, done ? 'max diff ' + maxDiff(region(layer(), 140, 90, 120, 80), [249, 250, 251]) : 'timed out');
    check('pixels outside the selection are untouched', maxDiff(region(layer(), 0, 0, 400, 80), [249, 250, 251]) === 0);
    check('selection stays after the fill', !!S.sel);
    key('z', { ctrlKey: true }); await wait(30);
    check('undo brings the box back', region(layer(), 200, 150, 1, 1)[0] === 0x1f);

    // The menu: Smart hides the swatch, the Fill button uses it, the tooltip says so
    setFillWith('smart'); await wait(20);
    check('the selection menu reads Color / Smart', [...$('#selFill').options].map(o => o.textContent).join('/') === 'Color/Smart');
    check('Smart hides the color swatch', getComputedStyle($('#selActions .sel-swatch')).display === 'none');
    check('Fill group uses normal spacing', getComputedStyle($('#selActions .fill-group')).columnGap === '6px', getComputedStyle($('#selActions .fill-group')).columnGap);
    check('Fill button tooltip says Smart fill', /^Smart fill/.test($('#btnFill').title) && /Backspace|⌫/.test($('#btnFill').title), $('#btnFill').title);
    check('the setting is saved', JSON.parse(localStorage.getItem('cutout.prefs.v1')).fillWith === 'smart');
    const b2 = layer().canvas;
    $('#btnFill').click();
    check('Fill button smart-fills', await until(() => layer().canvas !== b2) && maxDiff(region(layer(), 140, 90, 120, 80), [249, 250, 251]) <= 1);
    key('z', { ctrlKey: true }); await wait(30);

    // Alt+Backspace still means color while the menu is on Smart
    key('Backspace', { altKey: true }); await wait(30);
    check('Alt+Backspace is color even when the menu is on Smart', maxDiff(region(layer(), 145, 95, 110, 70), [255, 0, 0]) === 0);
    key('z', { ctrlKey: true }); await wait(30);

    // Right-click menu has the item
    const r = client(200, 130);
    vc.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...r })); await wait(30);
    check('right-click menu offers Smart fill', $$('#menu .menu-item').some(b => /Smart fill/.test(b.textContent)));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(20);

    // Bucket: its own setting, Color to start, even though the selection's menu is on Smart
    setBucket('color'); await wait(20);
    C.setTool('bucket'); await wait(20);
    check('bucket has its own menu, on Color', $('#bucketFill').offsetParent && $('#bucketFill').value === 'color' && S.opts.fillWith === 'smart');
    check('the selection menu hides while the bucket shows its own', !$('#selFill').offsetParent);
    check('Fill button follows the bucket setting', /^Fill \(/.test($('#btnFill').title), $('#btnFill').title);
    const b3c = layer().canvas;
    await click(200, 130); await wait(30);
    check('bucket on Color fills the selection with the color', layer().canvas !== b3c && maxDiff(region(layer(), 145, 95, 110, 70), [255, 0, 0]) === 0);
    key('z', { ctrlKey: true }); await wait(30);
    setBucket('smart'); await wait(20);
    check('bucket on Smart hides its swatch', getComputedStyle($('.bucket-swatch')).display === 'none');
    const b3 = layer().canvas;
    await click(200, 130);
    check('bucket on Smart smart-fills inside the selection', await until(() => layer().canvas !== b3) && maxDiff(region(layer(), 140, 90, 120, 80), [249, 250, 251]) <= 1);
    key('z', { ctrlKey: true }); await wait(30);
    S.sel = null; C.changed(); $('#toast').textContent = '';
    const b4 = layer().canvas;
    await click(200, 130); await wait(50);
    check('bucket on Smart without a selection asks for one', layer().canvas === b4 && $('#toast').textContent === 'Make a selection first', $('#toast').textContent);
    setBucket('color');
    await click(200, 130); await wait(30);
    check('bucket on Color still flood-fills', region(layer(), 200, 130, 1, 1)[0] === 255);
    key('z', { ctrlKey: true }); await wait(30);
    // old setting name from the test build is read as Color
    check('settings migrate (anything but smart is color)', ['color', 'smart'].includes(S.opts.fillWith) && ['color', 'smart'].includes(S.opts.bucketFill));

    // Cards with gaps (a UI layout), selected across all four with their text: cards and gaps come back
    reset();
    const cards = [['#f9e1d7', 100, 100], ['#e1ede3', 520, 100], ['#fdf0d7', 100, 360], ['#e1ede3', 520, 360]];
    C.addImageLayer(image(960, 640, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 960, 640);
      for (const [c, x, y] of cards) { g.fillStyle = c; g.fillRect(x, y, 400, 240); g.fillStyle = '#7c2d12'; g.font = 'bold 28px Segoe UI'; g.fillText('Heading', x + 30, y + 60); g.font = '18px Segoe UI'; g.fillText('Some body text that goes here', x + 30, y + 110); } }), 'Cards'); await wait(20);
    C.setTool('marquee'); await drag(120, 120, 900, 580);
    const b8 = layer().canvas; const t8 = performance.now(); key('Backspace', { shiftKey: true });
    const ok8 = await until(() => layer().canvas !== b8); const ms8 = Math.round(performance.now() - t8);
    const hex = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
    const cardErr = cards.map(([c, x, y]) => maxDiff(region(layer(), x + 30, y + 30, 340, 180), hex(c)));
    check('cards come back flat, text gone', ok8 && cardErr.every(e => e <= 1), cardErr.join(',') + ' / ' + ms8 + ' ms');
    check('the gaps between cards stay white', maxDiff(region(layer(), 505, 130, 10, 420), [255, 255, 255]) <= 1 && maxDiff(region(layer(), 130, 345, 760, 10), [255, 255, 255]) <= 1);
    key('z', { ctrlKey: true }); await wait(30);

    // Gradient and texture
    reset();
    C.addImageLayer(image(500, 300, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#4f46e5'); gr.addColorStop(1, '#ec4899'); g.fillStyle = gr; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(200, 110, 100, 60); }), 'Gradient'); await wait(20);
    C.setTool('marquee'); await drag(190, 100, 310, 180);
    const ref = image(500, 300, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#4f46e5'); gr.addColorStop(1, '#ec4899'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });
    const b5 = layer().canvas; key('Backspace', { shiftKey: true }); await until(() => layer().canvas !== b5);
    { const a = region(layer(), 190, 100, 120, 80), e = C.ctx2d(ref).getImageData(190, 100, 120, 80).data; let m = 0, s = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - e[i]); m = Math.max(m, d); s += d; }
      check('gradient continues through the hole', s / a.length < 2.5 && m < 16, `mean ${(s / a.length).toFixed(2)}, max ${m}`); }

    // Responsiveness: the window keeps running while a big fill works (worker)
    reset();
    C.addImageLayer(image(3000, 2000, (g, w, h) => { g.fillStyle = '#3f7a2e'; g.fillRect(0, 0, w, h); for (let i = 0; i < 40000; i++) { g.fillStyle = `hsl(${100 + (i % 40)}, 40%, ${25 + (i * 7) % 30}%)`; g.fillRect((i * 7919) % w, (i * 104729) % h, 6, 2); } g.fillStyle = '#ef4444'; g.beginPath(); g.arc(1500, 1000, 180, 0, 7); g.fill(); }), 'Grass'); await wait(50);
    C.setTool('marquee'); await drag(1300, 800, 1700, 1200);
    const b6 = layer().canvas; let maxGap = 0, last = performance.now(), ticking = true;
    (async () => { while (ticking) { await wait(16); const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; } })();
    const t0 = performance.now(); key('Backspace', { shiftKey: true });
    const ok6 = await until(() => layer().canvas !== b6, 60000); const ms = Math.round(performance.now() - t0); ticking = false;
    check('400 x 400 fill on a 3000 x 2000 image finishes', ok6, ms + ' ms');
    check('the window stays responsive while filling', maxGap < 250, 'longest pause ' + Math.round(maxGap) + ' ms');
    { const d = region(layer(), 1300, 800, 400, 400); let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90) red++; check('the red object is gone', red === 0, red + ' red pixels'); }

    // Changing the layer while it fills: nothing is applied. Needs a fill that takes a while, so a
    // random texture (patch fill) with a big hole; the undo happens while it runs.
    reset();
    C.addImageLayer(image(2000, 1500, (g, w, h) => { const id = g.createImageData(w, h); let s = 9; for (let i = 0; i < w * h; i++) { s = (s * 1103515245 + 12345) >>> 0; id.data.set([60 + (s >>> 25), 120 + ((s >>> 17) & 63), 40 + ((s >>> 9) & 63), 255], i * 4); } g.putImageData(id, 0, 0); }), 'Noise'); await wait(50);
    C.setTool('marquee'); await drag(700, 500, 1300, 1000); $('#toast').textContent = '';
    key('Backspace', { shiftKey: true }); await wait(30);
    key('z', { ctrlKey: true }); await wait(30); // undo (the layer goes away) while the fill runs
    await until(() => /changed/.test($('#toast').textContent), 60000);
        check('a fill that finishes after the layer changed is not applied', S.layers.length === 0 && /changed/.test($('#toast').textContent), S.layers.length + ' layers, toast: ' + $('#toast').textContent);
  } catch (e) { results.push('FAIL  exception: ' + (e && e.stack || e)); }
  S.opts.fillWith = savedFillWith; S.opts.bucketFill = savedBucket; S.opts.color = savedColor; C.changed();
  return results.join('\n');
};
