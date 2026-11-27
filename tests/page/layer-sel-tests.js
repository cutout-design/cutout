// Pixel selection vs picking another layer (Fireworks: panel keeps it; canvas click on another layer drops it). Run: await layerSelTests()
window.layerSelTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view');
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const client = (x, y) => { const r = vc.getBoundingClientRect(), d = devicePixelRatio || 1; return { clientX: r.left + (Math.round(C.view.ox) + x * C.view.s) / d, clientY: r.top + (Math.round(C.view.oy) + y * C.view.s) / d }; };
  const ptr = (type, x, y, o = {}) => vc.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, ...client(x, y), ...o }));
  const drag = async (x0, y0, x1, y1) => { ptr('pointerdown', x0, y0); for (let i = 1; i <= 5; i++) ptr('pointermove', x0 + (x1 - x0) * i / 5, y0 + (y1 - y0) * i / 5); ptr('pointerup', x1, y1); await wait(20); };
  const click = async (x, y, o = {}) => { ptr('pointerdown', x, y, o); ptr('pointerup', x, y, o); await wait(20); };
  const image = (w, h, color) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; };
  const setup = async () => {
    S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer'); C.changed();
    C.addImageLayer(image(400, 300, '#ffffff'), 'Paper'); await wait(20);
    C.addImageLayer(image(100, 100, '#ff0000'), 'Red', { x: 20, y: 20 }); await wait(20);
    C.addImageLayer(image(100, 100, '#0000ff'), 'Blue', { x: 250, y: 150 }); await wait(20);
    const red = S.layers.find(l => l.name === 'Red'), blue = S.layers.find(l => l.name === 'Blue');
    C.setTool('pointer'); await click(50, 50);
    C.setTool('marquee'); await drag(30, 30, 80, 80); C.setTool('pointer');
    return { red, blue };
  };
  try {
    let { red, blue } = await setup();
    check('setup: Red active with a selection', S.active === red.id && !!S.sel);
    await click(60, 60);
    check('clicking the active layer keeps the selection', !!S.sel && S.active === red.id);
    await click(300, 200);
    check('clicking another layer on the canvas selects it', S.active === blue.id);
    check('...and drops the pixel selection', S.sel === null);
    ({ red, blue } = await setup());
    const row = [...document.querySelectorAll('#layers .layer')].find(r => r.dataset.id == blue.id);
    if (row) { row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); row.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(20); }
    check('picking a layer in the Layers panel keeps the selection', !!row && S.active === blue.id && !!S.sel, row ? `active ${S.active === blue.id} sel ${!!S.sel}` : 'no row');
  } catch (e) { results.push('FAIL  threw: ' + e.message); }
  return results;
};
