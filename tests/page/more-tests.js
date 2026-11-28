// Editing features the other suites don't cover: marquee modes and shapes, growing a selection,
// rotate, rename, Canvas size, number math, settings. Run by tests/run.mjs (npm test).
window.moreTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view'), $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y), ...o }));
  const drag = async (x0, y0, x1, y1, o = {}) => { ptr('pointerdown', x0, y0, o); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5, o); ptr('pointerup', x1, y1, o); await wait(20); };
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: o.code || (k.length === 1 ? 'Key' + k.toUpperCase() : k), bubbles: true, cancelable: true, ...o }));
  const reset = () => { S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed(); };
  const image = (w, h, paint) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); paint(g, w, h); return c; };
  const area = () => (S.sel ? S.sel.mask.reduce((a, v) => a + (v ? 1 : 0), 0) : 0);
  const menu = async (x, y, label) => {
    vc.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...client(x, y) })); await wait(20);
    const item = [...document.querySelectorAll('#menu .menu-item')].find(b => b.getAttribute('aria-label') === label);
    if (item) { item.click(); await wait(30); } else key('Escape');
    return !!item;
  };
  const field = async (sel, v) => { const f = $(sel); f.value = v; f.dispatchEvent(new Event('change')); await wait(20); };
  const saved = { ...S.opts };

  try {
    // The Layers panel header has no buttons (a trash can there looked like Delete all)
    check('layers header has no buttons', !document.querySelector('.panel-head button'));

    reset();
    C.addImageLayer(image(200, 100, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 200, 100); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 10, 10); }), 'Paper'); await wait(20);

    // Marquee modes: Shift adds, Alt subtracts, the mode buttons do the same without a key
    C.setTool('marquee'); S.opts.mqStyle = 'normal'; S.opts.selMode = 'replace'; C.changed();
    await drag(10, 10, 40, 40);
    await drag(60, 10, 80, 30, { shiftKey: true });
    check('Shift-drag adds to the selection', area() === 900 + 400, `${area()} px`);
    await drag(10, 10, 20, 20, { altKey: true });
    check('Alt-drag subtracts from it', area() === 1300 - 100, `${area()} px`);
    [...document.querySelectorAll('#selModeSeg button')].find(b => b.dataset.mode === 'add').click(); await wait(20);
    await drag(100, 50, 110, 60);
    check('the Add mode button adds without Shift', area() === 1200 + 100, `${area()} px`);
    check('...and shows as pressed', document.querySelector('#selModeSeg [data-mode="add"]').getAttribute('aria-pressed') === 'true');
    [...document.querySelectorAll('#selModeSeg button')].find(b => b.dataset.mode === 'replace').click(); await wait(20);
    await drag(10, 10, 20, 20);
    check('New mode replaces the selection again', area() === 100, `${area()} px`);

    // Marquee shapes: exact size and aspect ratio
    const style = $('#mqStyle'); style.value = 'size'; style.dispatchEvent(new Event('change')); await wait(20);
    await field('#mqW', '30'); await field('#mqH', '20');
    await drag(50, 50, 52, 52);
    check('Exact size makes a 30 x 20 selection', S.sel && S.sel.w === 30 && S.sel.h === 20, S.sel ? `${S.sel.w}x${S.sel.h}` : 'none');
    style.value = 'ratio'; style.dispatchEvent(new Event('change')); await wait(20);
    await field('#mqW', '2'); await field('#mqH', '1');
    await drag(20, 20, 80, 80);
    check('Aspect ratio 2:1 keeps the ratio', S.sel && S.sel.w === 2 * S.sel.h, S.sel ? `${S.sel.w}x${S.sel.h}` : 'none');
    style.value = 'normal'; style.dispatchEvent(new Event('change')); await wait(20);
    const prefs = JSON.parse(localStorage.getItem('cutout.prefs.v1') || '{}');
    check('the marquee settings are remembered', prefs.mqStyle === 'normal' && Number(prefs.mqW) === 2 && Number(prefs.mqH) === 1, JSON.stringify({ s: prefs.mqStyle, w: prefs.mqW, h: prefs.mqH }));

    // Grow / shrink one side with Ctrl+Arrow
    await drag(50, 30, 70, 50);
    key('ArrowRight', { ctrlKey: true }); await wait(20);
    check('Ctrl+Right grows the selection 1 px to the right', S.sel.x === 50 && S.sel.w === 21, `${S.sel.x} ${S.sel.w}`);
    key('ArrowUp', { ctrlKey: true }); await wait(20);
    check('Ctrl+Up grows it 1 px up', S.sel.y === 29 && S.sel.h === 21, `${S.sel.y} ${S.sel.h}`);
    key('ArrowRight', { ctrlKey: true, shiftKey: true }); key('ArrowRight', { ctrlKey: true, shiftKey: true }); await wait(20);
    check('Ctrl+Shift+Right shrinks it from the right', S.sel.w === 19, `${S.sel.w}`);
    key('Escape'); await wait(20);
    check('Esc deselects', !S.sel);

    // Rotate 90° from the layer menu: size swaps, the red corner moves
    C.setTool('pointer'); await wait(10);
    check('the layer menu has Rotate 90° right', await menu(100, 50, 'Rotate 90° right'));
    let L = S.layers[0], d = C.ctx2d(L.canvas).getImageData(L.canvas.width - 5, 5, 1, 1).data;
    check('rotating right swaps width and height', L.canvas.width === 100 && L.canvas.height === 200, `${L.canvas.width}x${L.canvas.height}`);
    check('...and turns the top-left corner to the top right', d[0] === 255 && d[1] === 0, Array.from(d).join(','));
    await menu(L.x + 50, L.y + 100, 'Rotate 90° left'); L = S.layers[0];
    d = C.ctx2d(L.canvas).getImageData(5, 5, 1, 1).data;
    check('rotating left turns it back', L.canvas.width === 200 && d[0] === 255 && d[1] === 0, `${L.canvas.width}x${L.canvas.height}`);

    // Rename with F2
    S.selected.clear(); S.selected.add(L.id); S.active = L.id; C.changed(); await wait(20);
    key('F2'); await wait(20);
    const input = document.querySelector('#layers .layer input');
    check('F2 opens the layer name for editing', !!input && document.activeElement === input);
    if (input) {
      input.value = 'Background';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await wait(20);
    }
    check('...and Enter renames the layer', S.layers[0].name === 'Background', S.layers[0].name);
    key('z', { ctrlKey: true }); await wait(20);
    check('renaming is one undo step', S.layers[0].name === 'Paper', S.layers[0].name);

    // Number fields take math
    L = S.layers[0];
    await field('#lx', '10+5');
    check('X field takes math (10+5)', S.layers[0].x === 15, `${S.layers[0].x}`);
    await field('#lw', '50%');
    check('W field takes a percentage (50%)', S.layers[0].canvas.width === 100 || Math.round(S.layers[0].w || 0) === 100, `${S.layers[0].canvas.width}`);
    const ly = $('#ly'); ly.focus();
    ly.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); await wait(20);
    const yAfterUp = S.layers[0].y;
    ly.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true })); await wait(20);
    check('↑ in a field adds 1, Shift+↑ adds 10', S.layers[0].y - yAfterUp === 10, `${yAfterUp} → ${S.layers[0].y}`);
    ly.blur();
    key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); await wait(20);

    // Canvas size: artboard grows around the center, the image keeps its size
    reset();
    C.addImageLayer(image(100, 100, g => { g.fillStyle = '#00ff00'; g.fillRect(0, 0, 100, 100); }), 'Green'); await wait(20);
    key('c', { ctrlKey: true, altKey: true }); await wait(20);
    const dlg = $('#dlgCanvas');
    check('Ctrl+Alt+C opens Canvas size', dlg.open);
    $('#cw').value = '140'; $('#ch').value = '120'; $('#cbgTransparent').checked = true;
    dlg.close('ok'); await wait(30);
    L = S.layers[0];
    check('Canvas size changes the artboard only', S.artboard.w === 140 && S.artboard.h === 120 && L.canvas.width === 100, `${S.artboard.w}x${S.artboard.h}, layer ${L.canvas.width}`);
    check('...and keeps the image centered', L.x === 20 && L.y === 10, `${L.x}, ${L.y}`);
    key('z', { ctrlKey: true }); await wait(30);
    check('undo puts the artboard back', S.artboard.w === 100 && S.artboard.h === 100, `${S.artboard.w}x${S.artboard.h}`);
    $('#cw').value = '50'; dlg.returnValue = ''; dlg.showModal(); dlg.close('cancel'); await wait(20);
    check('Cancel changes nothing', S.artboard.w === 100);

    // Pasting SVG markup (Copy as SVG): read without parsing it into a document
    const pasteSvg = async text => {
      reset(); const dt = new DataTransfer(); dt.setData('text/plain', text);
      const t0 = performance.now();
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await wait(0); const ms = performance.now() - t0; // a slow check blocks the page before this timer runs
      for (let i = 0; i < 40 && !S.layers.length; i++) await wait(20);
      return { layer: S.layers[0], ms, toast: $('#toast').textContent };
    };
    const px = (l, x, y) => [...C.ctx2d(l.canvas).getImageData(x, y, 1, 1).data];
    let r = await pasteSvg('<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: test -->\n<svg width="40" height="30" viewBox="0 0 40 30" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="40" height="30" fill="#FF0000"/></svg>');
    check('SVG paste: size from width and height', r.layer && r.layer.canvas.width === 40 && r.layer.canvas.height === 30, r.layer ? `${r.layer.canvas.width}x${r.layer.canvas.height}` : 'no layer');
    check('SVG paste: draws the shapes', r.layer && px(r.layer, 20, 15).join() === '255,0,0,255', r.layer ? px(r.layer, 20, 15).join() : '');
    r = await pasteSvg('<svg viewBox="0 0 64 32"><circle cx="16" cy="16" r="16" fill="blue" stroke-width="3"/></svg>');
    check('SVG paste: no namespace, size from viewBox', r.layer && r.layer.canvas.width === 64 && r.layer.canvas.height === 32, r.layer ? `${r.layer.canvas.width}x${r.layer.canvas.height}` : 'no layer');
    r = await pasteSvg('<!-- old: <svg width="500" height="400"> -->\n<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="#00FF00"/></svg>');
    check('SVG paste: size from the real tag, not an <svg> inside a comment before it', r.layer && r.layer.canvas.width === 24 && r.layer.canvas.height === 12, r.layer ? `${r.layer.canvas.width}x${r.layer.canvas.height}` : 'no layer');
    window.__svgRan = false;
    r = await pasteSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.__svgRan=true"><script>window.__svgRan=true</script><rect width="10" height="10" fill="red"/></svg>');
    check('SVG paste: scripts in the markup never run', r.layer && window.__svgRan === false, `ran ${window.__svgRan}`);
    r = await pasteSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&b;</text></svg>');
    check('SVG paste: entity declarations are refused', !r.layer, r.toast);
    // The old check doubled its time with each comment: 40 of them froze the window for hours
    r = await pasteSvg('<!---->'.repeat(40) + 'x</svg>');
    check('SVG paste: crafted comment text is checked quickly', !r.layer && r.ms < 200, `${Math.round(r.ms)} ms`);
    // About Cutout links to the privacy page (app stores ask for a link in the app); OK has the focus
    $('#appMenu').click(); await wait(30);
    const about = [...document.querySelectorAll('#menu .menu-item')].find(b => b.getAttribute('aria-label') === 'About Cutout');
    if (about) about.click();
    await wait(100);
    const link = $('#aboutPrivacy');
    check('About: links to the privacy page, opening outside the app', $('#dlgAbout').open && link && link.href === 'https://cutout.design/privacy/' && link.target === '_blank', link && link.href);
    const guide = $('#aboutGuide');
    check('About: User Guide links to the guide, on the line under the version', guide && guide.textContent === 'User Guide' && guide.href === 'https://cutout.design/guide/' && guide.target === '_blank' && guide.parentElement === link.parentElement && guide.parentElement !== $('#aboutVersion'), guide && guide.href);
    check('About: OK has the focus, so Enter closes it', document.activeElement === $('#dlgAbout button[value="ok"]'), document.activeElement && document.activeElement.outerHTML.slice(0, 60));
    $('#dlgAbout').close();
  } catch (e) {
    check('the suite ran to the end', false, e.message);
  } finally {
    Object.assign(S.opts, saved);
    reset();
  }
  return results;
};
