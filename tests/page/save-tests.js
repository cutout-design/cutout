window.saveTests = async () => {
  const C = window.Cutout, S = C.state, $ = s => document.querySelector(s);
  const results = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: 'Key' + k.toUpperCase(), bubbles: true, cancelable: true, ...o }));
  const image = (w, h, color) => { const c = C.makeCanvas(w, h), g = C.ctx2d(c); g.fillStyle = color; g.fillRect(0, 0, w, h); return c; };
  const toastText = () => $('#toast').textContent;
  // Wait until a condition holds (up to 5 s) instead of a fixed pause: a save takes longer on a slow
  // machine (the CI runner once needed more than 0.8 s, and the checks after it then failed in a chain).
  const until = async (cond, ms = 5000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await wait(25); return cond(); };
  const saved = () => /^Saved out\.png/.test(toastText());
  C.addImageLayer(image(50, 40, '#f00'), 'One'); await wait(30);
  key('s', { ctrlKey: true });
  check('first save opens the format dialog', await until(() => $('#dlgExport').open));
  $('#toast').textContent = '';
  $('#dlgExport button[value="ok"]').click();
  check('saved', await until(saved), toastText());
  C.addImageLayer(image(20, 20, '#00f'), 'Two'); await wait(30);
  $('#toast').textContent = ''; // so the message below is from this save, not the first one
  key('s', { ctrlKey: true });
  check('saving again is silent (same document)', await until(saved) && !$('#dlgExport').open, toastText());
  // start over: delete everything, add a new image
  key('a', { ctrlKey: true }); await wait(20); key('Delete');
  check('document is empty', await until(() => S.layers.length === 0, 2000), `${S.layers.length} layers`);
  C.addImageLayer(image(30, 30, '#0f0'), 'New'); await wait(30);
  key('s', { ctrlKey: true });
  check('after starting over, Save asks again', await until(() => $('#dlgExport').open));
  check('...and suggests a fresh name', $('#fname').value === 'cutout', $('#fname').value);
  $('#dlgExport').close();
  // undo back to the old document does not matter here; the save target stays forgotten (safe side)
  return results;
};
