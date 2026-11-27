// Shrink to content. Run in Cutout's page, then: await shrinkTests()
window.shrinkTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view'), $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y) }));
  const drag = async (x0, y0, x1, y1) => { ptr('pointerdown', x0, y0); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5); ptr('pointerup', x1, y1); await wait(20); };
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, paint) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); paint(g, w, h); return c; };
  const sel = () => S.sel ? `${S.sel.x},${S.sel.y} ${S.sel.w}x${S.sel.h}` : 'none';
  const near = (want, tol = 2) => S.sel && Math.abs(S.sel.x - want[0]) <= tol && Math.abs(S.sel.y - want[1]) <= tol && Math.abs(S.sel.x + S.sel.w - want[0] - want[2]) <= tol && Math.abs(S.sel.y + S.sel.h - want[1] - want[3]) <= tol;
  const shrink = async (via = 'menu') => {
    if (via === 'more') { $('#selMore').click(); await wait(20); }
    else { const r = client(S.sel.x + S.sel.w / 2, S.sel.y + S.sel.h / 2); vc.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...r })); await wait(20); }
    const item = [...document.querySelectorAll('#menu .menu-item')].find(b => /Shrink to content/.test(b.textContent));
    if (!item) throw new Error('menu item missing (' + via + ')');
    item.click(); await wait(30);
  };
  // a made-up scan: noisy white paper, dark scanner lines on the edges, a light card against the top line, dust
  const scan = () => image(1200, 1600, (g, w, h) => {
    const id = g.createImageData(w, h); let s = 7;
    for (let i = 0; i < w * h; i++) { s = (s * 1103515245 + 12345) >>> 0; const v = 247 + (s >>> 28) % 7; id.data.set([v, v, v - 1, 255], i * 4); }
    g.putImageData(id, 0, 0);
    g.fillStyle = '#202020'; g.fillRect(0, 0, w, 5); g.fillRect(0, 0, 4, h); g.fillRect(w - 6, 0, 6, h); g.fillRect(0, h - 5, w, 5);
    g.fillStyle = '#f3f0ea'; g.strokeStyle = '#b9b4ab'; g.lineWidth = 1.5;
    g.beginPath(); g.roundRect(10, 5, 560, 355, 22); g.fill(); g.stroke();
    g.fillStyle = '#222'; for (let k = 0; k < 40; k++) g.fillRect(30 + k * 8, 30, 4 + (k % 3), 70);
    g.fillStyle = '#5b8fd6'; g.fillRect(40, 200, 120, 110); g.fillStyle = '#444'; g.font = '14px Segoe UI'; g.fillText('CLASS: C   END: None   REST: None', 190, 180);
    g.fillStyle = '#8a5a3a'; g.font = '40px Georgia'; g.fillText('1845', 450, 330);
    g.fillStyle = '#9a9a9a'; for (const [x, y] of [[640, 120], [700, 420], [610, 300], [300, 440]]) g.fillRect(x, y, 2, 2); // dust
  });
  // a rougher scan: scanner edges that wobble in thickness, vary in darkness and have gaps, plus blotchy noise
  const roughScan = () => image(1200, 1600, (g, w, h) => {
    const id = g.createImageData(w, h); let s = 11;
    const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = 244 + Math.round(rnd() * 9 + Math.sin(x / 37) * 2 + Math.cos(y / 53) * 2); id.data.set([v, v, v - 2, 255], (y * w + x) * 4); }
    const dark = (x, y) => { const v = 25 + Math.round(rnd() * 70); id.data.set([v, v, v, 255], (y * w + x) * 4); };
    for (let x = 0; x < w; x++) { if (x % 97 < 2) continue; const t = 3 + ((x * 7) % 5); for (let y = 0; y < t; y++) dark(x, y); }        // top
    for (let y = 0; y < h; y++) { if (y % 131 < 3) continue; const t = 2 + ((y * 5) % 6); for (let x = 0; x < t; x++) dark(x, y); }        // left
    for (let y = 0; y < h; y++) { const t = 4 + ((y * 3) % 4); for (let x = w - t; x < w; x++) dark(x, y); }                            // right
    g.putImageData(id, 0, 0);
    g.fillStyle = '#f5f3ee'; g.strokeStyle = '#c4bfb6'; g.lineWidth = 1.2;
    g.beginPath(); g.roundRect(8, 6, 560, 355, 22); g.fill(); g.stroke();
    g.fillStyle = '#222'; for (let k = 0; k < 40; k++) g.fillRect(30 + k * 8, 30, 4 + (k % 3), 70);
    g.fillStyle = '#5b8fd6'; g.fillRect(40, 200, 120, 110);
    g.fillStyle = '#8a5a3a'; g.font = '40px Georgia'; g.fillText('1845', 450, 330);
  });

  try {
    // Scan: loose rectangle from past the corner to well beyond the card
    reset(); C.addImageLayer(scan(), 'Scan'); await wait(30);
    C.setTool('marquee'); await drag(-40, -40, 760, 520);
    check('loose marquee includes scanner lines and dust', sel() === '0,0 760x520', sel());
    await shrink('menu');
    check('scan: snaps to the card (ignores scanner lines and dust)', near([9, 4, 563, 358]), sel());
    // Again via More ▾, from a different loose rectangle
    await drag(2, 2, 900, 700); await shrink('more');
    check('scan via More menu: same result', near([9, 4, 563, 358]), sel());

    // Rough scan: wobbly scanner edges with gaps, card against the top and left edges
    reset(); C.addImageLayer(roughScan(), 'Rough scan'); await wait(30);
    C.setTool('marquee'); await drag(-40, -40, 780, 560); await shrink();
    check('rough scan: snaps to the card despite wobbly scanner edges', near([7, 5, 563, 358], 3), sel());
    // Card in the scan's corner (like a real scan): pure white paper, the card covers the scanner's edge
    // lines there, so the lines show only below it (left edge) and to its right (top edge)
    reset();
    C.addImageLayer(image(1400, 1900, (g, w, h) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      const id = g.getImageData(0, 0, w, h); let s2 = 5; const rnd = () => (s2 = (s2 * 1103515245 + 12345) >>> 0) / 4294967296;
      const dark = (x, y) => { const v = 30 + Math.round(rnd() * 90); id.data.set([v, v, v, 255], (y * w + x) * 4); };
      for (let x = 600; x < w; x++) { if (x % 89 < 2) continue; const t = 3 + ((x * 7) % 9); for (let y = 0; y < t; y++) dark(x, y); }   // top, right of the card
      for (let y = 380; y < h; y++) { if (y % 113 < 3) continue; const t = 2 + ((y * 5) % 7); for (let x = 0; x < t; x++) dark(x, y); } // left, below the card
      g.putImageData(id, 0, 0);
      g.fillStyle = '#f1efe9'; g.beginPath(); g.roundRect(-10, -10, 590, 380, 18); g.fill();
      g.strokeStyle = '#b5b0a6'; g.lineWidth = 1.5; g.stroke();
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, 560, 24); // the card's top strip is as white as the paper
      g.fillStyle = '#222'; for (let k = 0; k < 40; k++) g.fillRect(30 + k * 8, 30, 4 + (k % 3), 70);
      g.fillStyle = '#5b8fd6'; g.fillRect(40, 200, 120, 110);
    }), 'Corner scan'); await wait(30);
    C.setTool('marquee'); await drag(-40, -40, 640, 440); await shrink();
    check('card in the scan corner: snaps to the card, not the edge lines', near([0, 0, 581, 371], 3), sel());

    // Certificate: a thin double frame (with small breaks, as scans have) around centered text
    reset();
    C.addImageLayer(image(1400, 1080, (g, w, h) => {
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      const line = (x, y, lw, lh, c) => { g.fillStyle = c; g.fillRect(x, y, lw, lh); };
      // outer frame 3 px, inner 2 px, each side a separate piece (gaps at the corners)
      line(92, 90, 1216, 3, '#c9c9c9'); line(92, 987, 1216, 3, '#c9c9c9'); line(90, 92, 3, 896, '#c9c9c9'); line(1307, 92, 3, 896, '#c9c9c9');
      line(102, 100, 1196, 2, '#d2d2d2'); line(102, 978, 1196, 2, '#d2d2d2'); line(100, 102, 2, 876, '#d2d2d2'); line(1298, 102, 2, 876, '#d2d2d2');
      g.fillStyle = '#111'; g.font = 'bold 56px Georgia'; g.fillText('Certificate of Something', 330, 230);
      g.font = '28px Segoe UI'; g.fillStyle = '#555'; g.fillText('has successfully met the standards', 470, 420);
      g.fillStyle = '#a89b78'; g.beginPath(); g.arc(700, 800, 110, 0, 7); g.lineWidth = 3; g.strokeStyle = '#a89b78'; g.stroke();
    }), 'Certificate'); await wait(30);
    C.setTool('marquee'); await drag(40, 40, 1360, 1040); await shrink();
    check('certificate: snaps to the thin frame, all four sides', near([90, 90, 1220, 900], 2), sel());

    // A selection that already fits says so
    $('#toast').textContent = ''; const fitted = sel(); await shrink();
    check('shrinking again: says it already fits', sel() === fitted && /already fits/i.test($('#toast').textContent), fitted + ' -> ' + sel() + ' / ' + $('#toast').textContent);

    // No selection: right-click the layer, Shrink to content works on the whole artboard
    reset(); C.addImageLayer(scan(), 'Scan'); await wait(30);
    S.sel = null; C.setTool('pointer'); C.changed(); await wait(20);
    { const r = client(300, 200); vc.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...r })); await wait(20);
      const item = [...document.querySelectorAll('#menu .menu-item')].find(b => /Shrink to content/.test(b.textContent));
      if (item) { item.click(); await wait(40); } else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check('no selection: the layer menu has Shrink to content', !!item); }
    check('no selection: it selects the card on the whole scan (scanner edges ignored)', near([9, 5, 562, 356], 3), sel());

    // Screenshot: loose rectangle around a button
    reset();
    C.addImageLayer(image(600, 400, g => { g.fillStyle = '#f9fafb'; g.fillRect(0, 0, 600, 400); g.fillStyle = '#2563eb'; g.beginPath(); g.roundRect(220, 170, 160, 44, 8); g.fill(); g.fillStyle = '#fff'; g.font = '16px Segoe UI'; g.fillText('Continue', 265, 198); }), 'Shot'); await wait(30);
    C.setTool('marquee'); await drag(150, 120, 460, 260); await shrink();
    check('screenshot: snaps to the button', near([220, 170, 160, 44], 1), sel());

    // Transparent layer
    reset();
    C.addImageLayer(image(500, 400, g => { g.fillStyle = '#e11d48'; g.beginPath(); g.arc(250, 200, 60, 0, 7); g.fill(); }), 'Clear'); await wait(30);
    C.setTool('marquee'); await drag(100, 60, 420, 360); await shrink();
    check('transparent layer: snaps to the object', near([190, 140, 120, 120], 2), sel());

    // Nothing inside
    await drag(10, 10, 120, 100); $('#toast').textContent = ''; const before = sel(); await shrink();
    check('nothing inside: says so, selection unchanged', sel() === before && /Nothing stands out/.test($('#toast').textContent), $('#toast').textContent);
  } catch (e) { results.push('FAIL  exception: ' + (e && e.stack || e)); }
  return results.join('\n');
};
