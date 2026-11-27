// Keyboard and screen reader checks, with real key and mouse input sent through the DevTools
// protocol (synthetic DOM events miss how Chromium really behaves, e.g. the Menu key). Run by
// tests/run.mjs (npm test).
export default async function a11yTests({ send, ev, wait }) {
  const KEYS = { Tab: 9, Enter: 13, Escape: 27, ' ': 32, ArrowDown: 40, ArrowUp: 38, ArrowRight: 39, F10: 121, Delete: 46, ContextMenu: 93, s: 83 };
  const key = async (k, mods = 0) => {
    const code = k === ' ' ? 'Space' : k, vk = KEYS[k];
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    if (k === ' ' || k === 'Enter') { const t = k === ' ' ? ' ' : String.fromCharCode(13); await send('Input.dispatchKeyEvent', { type: 'char', key: k, text: t, unmodifiedText: t, modifiers: mods }); }
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    await wait(60);
  };
  const click = async (x, y) => { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); await wait(80); };
  const results = [];
  const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`);
  const focused = () => ev(`(() => { const a = document.activeElement; if (!a || a === document.body) return 'body'; return (a.id ? '#' + a.id : a.className ? a.tagName.toLowerCase() + '.' + String(a.className).split(' ')[0] : a.tagName.toLowerCase()) + (a.matches(':focus-visible') ? ' fv' : '') + ' ring=' + getComputedStyle(a).outlineStyle; })()`);

  await ev(`(() => { const C = window.Cutout, S = C.state; S.layers.length = 0; S.selected.clear(); S.active = null; S.sel = null; C.setTool('pointer');
    const mk = (w, h, c) => { const k = C.makeCanvas(w, h), g = C.ctx2d(k); g.fillStyle = c; g.fillRect(0, 0, w, h); return k; };
    C.addImageLayer(mk(300, 200, '#ffffff'), 'Paper'); C.addImageLayer(mk(60, 60, '#ff0000'), 'Red', { x: 20, y: 20 }); S.selected.clear(); S.active = null; C.changed(); document.activeElement.blur && document.activeElement.blur(); })()`);
  await wait(100);

  // 1. Tab reaches the top bar's buttons with a visible ring
  await key('Tab'); const f1 = await focused();
  check('Tab reaches the Cutout menu button, with a focus ring', /^#appMenu fv ring=solid/.test(f1), f1);
  // 2. Enter opens the menu with the first item focused; arrows move; Esc closes and returns focus
  await key('Enter');
  let st = await ev(`JSON.stringify({ open: !document.querySelector('#menu').hidden, role: document.querySelector('#menu').getAttribute('role'), exp: document.querySelector('#appMenu').getAttribute('aria-expanded'), item: document.activeElement.textContent.trim(), itemRole: document.activeElement.getAttribute('role') })`);
  let o = JSON.parse(st);
  check('Enter opens the menu, focus on its first item', o.open && o.role === 'menu' && o.exp === 'true' && /System/.test(o.item) && o.itemRole === 'menuitemradio', st);
  await key('ArrowDown'); const a2 = await ev(`document.activeElement.textContent.trim()`);
  check('ArrowDown moves to the next item', /Light/.test(a2), a2);
  await key('ArrowUp'); await key('ArrowUp'); const a3 = await ev(`document.activeElement.textContent.trim()`);
  check('ArrowUp wraps around to the last item', /About/.test(a3), a3);
  await key('Escape'); const f2 = await focused();
  st = await ev(`JSON.stringify({ open: !document.querySelector('#menu').hidden, exp: document.querySelector('#appMenu').getAttribute('aria-expanded') })`); o = JSON.parse(st);
  check('Esc closes it and focus returns to the button', !o.open && o.exp === 'false' && /^#appMenu/.test(f2), f2 + ' ' + st);
  // 3. Enter on a menu item runs it (Dark theme), then back to System
  await key('Enter'); await key('ArrowDown'); await key('ArrowDown'); await key('Enter');
  const theme = await ev(`document.documentElement.dataset.theme`);
  check('Enter on a menu item runs it', theme === 'dark', theme);
  await key('Enter'); await key('Enter'); // System
  // 4. Tab on through the bar: Open, (Paste), Undo... each with a ring; Space presses a button
  const seen = [];
  for (let i = 0; i < 6; i++) { await key('Tab'); seen.push(await focused()); }
  check('Tab moves through the top bar, each with a ring', seen.every(s => /fv ring=solid/.test(s)), seen.join(' | '));
  // 5. Space on a focused button presses it (Undo button)
  await ev(`window.__undos = 0; const zb = document.querySelector('[data-cmd=zoomFit]'); zb.addEventListener('click', () => window.__undos++, { once: true }); zb.focus()`);
  await key(' ');
  check('Space presses a focused button', await ev(`window.__undos === 1`));
  await key('Escape');
  // 6. Layer rows: reachable, Enter selects, Shift+Enter adds
  await ev(`document.querySelector('#layers .layer').focus()`);
  await key('Tab', 0); await key('Tab', 8); // nudge focus-visible on via the keyboard, back to the row
  const rowF = await focused();
  await key('Enter');
  st = await ev(`JSON.stringify({ sel: [...window.Cutout.state.selected].length, active: window.Cutout.state.active, f: document.activeElement.className, label: document.activeElement.getAttribute('aria-label') })`); o = JSON.parse(st);
  check('Enter on a focused layer row selects it, focus stays on the row', o.sel === 1 && /layer/.test(o.f) && /selected/.test(o.label), rowF + ' ' + st);
  await key('Tab'); await key('Tab'); await key('Enter', 8);
  st = await ev(`JSON.stringify({ sel: [...window.Cutout.state.selected].length })`);
  check('Shift+Enter on another row adds it', JSON.parse(st).sel === 2, st);
  // 7. Keyboard context menu on the canvas
  await ev(`window.Cutout.state.selected = new Set([window.Cutout.state.layers[1].id]); window.Cutout.state.active = window.Cutout.state.layers[1].id; window.Cutout.changed(); document.querySelector('#view').focus()`);
  await key('ContextMenu'); // the real Menu key (Chromium: button -1, positioned at the canvas center)
  await wait(80);
  st = await ev(`JSON.stringify({ open: !document.querySelector('#menu').hidden, first: document.activeElement.textContent.trim(), items: [...document.querySelectorAll('#menu .menu-item')].map(b => b.firstChild.textContent).slice(0, 3) })`);
  o = JSON.parse(st);
  check('Menu key on the canvas opens the layer menu, first item focused', o.open && /Copy/.test(o.first) && o.items.includes('Duplicate'), st);
  await key('Escape');
  // 7b. Shift+F10 does the same; with nothing selected it's the artboard's menu
  await ev(`window.Cutout.state.selected.clear(); window.Cutout.state.active = null; window.Cutout.changed(); document.querySelector('#view').focus()`);
  await key('F10', 8);
  st = await ev(`JSON.stringify({ open: !document.querySelector('#menu').hidden, first: document.activeElement.textContent.trim().slice(0, 20), inMenu: document.querySelector('#menu').contains(document.activeElement) })`);
  check('Shift+F10 opens the artboard menu with its first item focused', JSON.parse(st).open && JSON.parse(st).inMenu && /Copy artboard/.test(JSON.parse(st).first), st);
  await key('Escape');
  // 7c. Tab to a button, then use the mouse on another button: Space pans again (doesn't press the first)
  await ev(`document.activeElement.blur()`); await key('Tab');
  const tb = JSON.parse(await ev(`JSON.stringify(document.querySelector('#tools [data-tool=marquee]').getBoundingClientRect())`));
  await click(tb.left + tb.width / 2, tb.top + tb.height / 2);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'char', key: ' ', text: ' ', unmodifiedText: ' ' });
  st = await ev(`JSON.stringify({ tool: window.Cutout.state.tool, cursor: document.querySelector('#view').style.cursor, menu: !document.querySelector('#menu').hidden })`);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await wait(60);
  check('after Tab then a mouse click on a tool, Space pans (no stale keyboard focus)', JSON.parse(st).tool === 'marquee' && JSON.parse(st).cursor === 'grab' && !JSON.parse(st).menu && !(await ev(`!document.querySelector('#menu').hidden`)), st);
  await ev(`window.Cutout.setTool('pointer')`);
  // 7d. A letter on a keyboard-focused list is type-ahead, not a tool shortcut
  await ev(`window.Cutout.setTool('bucket'); document.activeElement.blur && document.activeElement.blur()`);
  await ev(`(() => { const s = document.querySelector('#bucketFill'); s.value = 'color'; s.focus(); s.classList.remove('pointer-focus'); })()`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 }); await wait(60);
  check('a letter typed on a focused list does not switch tools', (await ev(`window.Cutout.state.tool`)) === 'bucket', await ev(`window.Cutout.state.tool`));
  await ev(`document.activeElement.blur(); window.Cutout.setTool('pointer'); const S = window.Cutout.state; S.selected = new Set([S.layers[1].id]); S.active = S.layers[1].id; window.Cutout.changed()`);
  // 7e. Control+Return (also the Mac's way): with a pixel selection, the selection menu, from anywhere
  await ev(`window.Cutout.state.sel = { x: 30, y: 30, w: 20, h: 20, mask: new Uint8Array(400).fill(1) }; window.Cutout.changed(); document.activeElement.blur && document.activeElement.blur()`);
  await key('Enter', 2);
  st = await ev(`JSON.stringify({ open: !document.querySelector('#menu').hidden, inMenu: document.querySelector('#menu').contains(document.activeElement), items: [...document.querySelectorAll('#menu .menu-item')].map(b => b.getAttribute('aria-label')).slice(0, 4) })`);
  check('Control+Return opens the selection menu, first item focused', JSON.parse(st).open && JSON.parse(st).inMenu && JSON.parse(st).items.includes('Copy to new layer'), st);
  await key('Escape'); await ev(`window.Cutout.state.sel = null; window.Cutout.changed()`);
  // 8. Mouse users: a clicked layer row keeps today's keys (Space pans, Esc deselects, arrows nudge)
  const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('#layers .layer').getBoundingClientRect())`));
  await click(r.left + 60, r.top + r.height / 2);
  const clicked = await focused();
  const sel0 = await ev(`[...window.Cutout.state.selected].join(',')`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  const panning = await ev(`document.querySelector('#view').style.cursor`);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await wait(50);
  check('after clicking a row, Space still pans (not select)', panning === 'grab' && (await ev(`[...window.Cutout.state.selected].join(',')`)) === sel0, clicked + ' cursor ' + panning);
  const x0 = await ev(`window.Cutout.state.layers.find(l => l.id === window.Cutout.state.active).x`);
  await key('ArrowRight'); const x1 = await ev(`window.Cutout.state.layers.find(l => l.id === window.Cutout.state.active).x`);
  check('...arrows still nudge the layer', x1 === x0 + 1, x0 + ' → ' + x1);
  await key('Escape');
  check('...Esc still deselects', (await ev(`window.Cutout.state.selected.size`)) === 0);
  // 9. Screen reader announcements repeat, pressed states, labels
  await ev(`window.Cutout.setTool('marquee')`);
  st = await ev(`JSON.stringify([...document.querySelectorAll('#tools [data-tool]')].map(b => b.dataset.tool + '=' + b.getAttribute('aria-pressed')))`);
  check('tool buttons say which is pressed', /marquee=true/.test(st) && /pointer=false/.test(st), st);
  await ev(`window.Cutout.setTool('pointer')`);
  const ann = await ev(`(async () => { const r = []; for (let i = 0; i < 2; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true })); await new Promise(z => setTimeout(z, 20)); r.push(document.querySelector('#announce').textContent); await new Promise(z => setTimeout(z, 150)); r.push(document.querySelector('#announce').textContent); } return r.join(' / '); })()`);
  check('messages reach the screen reader each time (emptied, then said)', /^ \/ .+ \/  \/ .+$/.test(ann), ann);
  const unnamed = await ev(`JSON.stringify([...document.querySelectorAll('button, input:not([type=hidden]):not(#fileInput), select')].filter(el => el.offsetParent !== null || el.closest('.opt')).filter(el => { const n = el.getAttribute('aria-label') || el.title || (el.labels && [...el.labels].map(l => l.textContent.trim()).join('')) || el.textContent.trim() || el.placeholder; return !n; }).map(el => el.outerHTML.slice(0, 80)))`);
  check('every visible control has a name', unnamed === '[]', unnamed);
  // 10. Reduced motion
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await wait(100);
  const td = await ev(`getComputedStyle(document.querySelector('#toast')).transitionDuration`);
  check('reduced motion: no transitions', /^0s/.test(td), td);
  await send('Emulation.setEmulatedMedia', { features: [] });
  return results;
}
