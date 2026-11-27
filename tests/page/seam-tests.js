// A piece cut to its own layer and left in place shows no seam in the view, at any zoom. Run: await seamTests()
window.seamTests = async () => {
  const C = window.Cutout, S = C.state, vc = document.querySelector('#view');
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  window.dispatchEvent(new Event('resize')); await wait(50);
  const saved = { s: C.view.s, ox: C.view.ox, oy: C.view.oy };
  try {
    S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer');
    S.artboard.w = 200; S.artboard.h = 100; S.artboard.bg = null;
    const base = C.makeCanvas(200, 100), bg = C.ctx2d(base); bg.fillStyle = '#ff0000'; bg.fillRect(0, 0, 100, 100); bg.fillStyle = '#0000ff'; bg.fillRect(100, 0, 100, 100);
    const piece = C.makeCanvas(71, 62); C.ctx2d(piece).drawImage(base, -14, -15);
    bg.clearRect(14, 15, 71, 62);
    C.addImageLayer(base, 'Base', { x: 0, y: 0 }); await wait(20);
    C.addImageLayer(piece, 'Piece', { x: 14, y: 15 }); await wait(20);
    S.selected.clear(); S.active = null; S.layers[0].x = 0; S.layers[0].y = 0; S.layers[1].x = 14; S.layers[1].y = 15;
    for (const s of [1, 1.25, 1.5, 1.75, 2.5, 3]) {
      C.view.s = s; C.view.ox = 101.7; C.view.oy = 80.3; C.render();
      const ox = Math.round(C.view.ox), oy = Math.round(C.view.oy);
      // device pixels whose centers fall inside the artboard
      const x0 = Math.ceil(ox - 0.5), y0 = Math.ceil(oy - 0.5), x1 = Math.ceil(ox + 200 * s - 0.5), y1 = Math.ceil(oy + 100 * s - 0.5);
      const d = vc.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let bad = 0, first = ""; for (let i = 0; i < d.length; i += 4) { const red = d[i] === 255 && d[i + 1] === 0 && d[i + 2] === 0, blue = d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 255; if (!(red || blue) || d[i + 3] !== 255) { if (!bad) first = ((i / 4) % (x1 - x0)) + "," + Math.floor(i / 4 / (x1 - x0)) + " rgba " + [d[i], d[i+1], d[i+2], d[i+3]].join(); bad++; } }
      check(`no seam at ${s * 100 / (devicePixelRatio || 1)}% (scale ${s})`, bad === 0, bad + " off pixels, first " + first + " layers " + S.layers.map(l => [l.x, l.y, l.canvas.width, l.canvas.height].join(" ")).join(" / ") + " ab " + S.artboard.w + "x" + S.artboard.h);
    }
  } catch (e) { results.push('FAIL  threw: ' + e.message); }
  finally { C.view.s = saved.s; C.view.ox = saved.ox; C.view.oy = saved.oy; C.changed(); }
  return results;
};
