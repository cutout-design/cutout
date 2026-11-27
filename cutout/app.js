'use strict';
/*
 * Cutout — a small, direct-manipulation raster scratchpad.
 *
 * Structure:
 *   Platform   – the only code that touches files and the system clipboard.
 *                A native shell (Tauri / Electron) can replace it without touching the editor.
 *   Document   – artboard + layers (bottom → top). Layer canvases are treated as immutable:
 *                any pixel edit swaps in a new canvas, which makes undo snapshots cheap.
 *   Selection  – a pixel mask in document coordinates: { x, y, w, h, mask: Uint8Array (0/1) }.
 *   View       – zoom/pan in device pixels; rendering is a single <canvas>.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const IS_MAC = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  /** Shortcut labels are written Windows-style ("Ctrl+Shift+S"); on a Mac show them the Mac way ("⇧⌘S"). */
  const MAC_KEYS = { Backspace: '⌫', Delete: '⌦', Enter: '↩', Escape: '⎋' };
  function fmtKeys(text) {
    if (!IS_MAC || !text) return text;
    return text
      .replace(/\b(?:(?:Ctrl|Alt|Shift)\+)+[^\s),]+/g, m => {
        const parts = m.split('+'), key = parts.pop(), mods = new Set(parts);
        return (mods.has('Alt') ? '⌥' : '') + (mods.has('Shift') ? '⇧' : '') + (mods.has('Ctrl') ? '⌘' : '') + (MAC_KEYS[key] || key);
      })
      .replace(/\bAlt\b/g, 'Option');
  }

  /* ======================================================================
   * Canvas helpers
   * ==================================================================== */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }
  function cloneCanvas(src) { const c = makeCanvas(src.width, src.height); ctx2d(c).drawImage(src, 0, 0); return c; }
  function getData(c) { return ctx2d(c).getImageData(0, 0, c.width, c.height); }
  /** Pixels of a layer canvas for reading only, kept for the last canvas asked about: repeat wand
   *  clicks on a big image don't read it again. (Layer canvases are never changed once made; an
   *  eraser stroke paints into a fresh copy, which isn't read until the stroke ends.) */
  let pixelsCache = null;
  function pixelsOf(c) {
    if (!pixelsCache || pixelsCache.canvas !== c) pixelsCache = { canvas: c, data: getData(c).data };
    return pixelsCache.data;
  }
  function canvasToBlob(c, type = 'image/png', q) {
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not encode image'))), type, q));
  }
  function opaqueBounds(c) {
    const w = c.width, h = c.height, d = getData(c).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      let row = y * w * 4 + 3;
      for (let x = 0; x < w; x++, row += 4) {
        if (d[row] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  /** Crops a canvas to its non-transparent pixels. Returns null if fully transparent. */
  function trimmed(c) {
    const b = opaqueBounds(c);
    if (!b) return null;
    if (b.x === 0 && b.y === 0 && b.w === c.width && b.h === c.height) return { canvas: c, dx: 0, dy: 0 };
    const n = makeCanvas(b.w, b.h);
    ctx2d(n).drawImage(c, -b.x, -b.y);
    return { canvas: n, dx: b.x, dy: b.y };
  }
  async function blobToCanvas(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const c = makeCanvas(bmp.width, bmp.height);
      ctx2d(c).drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return c;
    } catch (_) {
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        const c = makeCanvas(img.naturalWidth || 300, img.naturalHeight || 150);
        ctx2d(c).drawImage(img, 0, 0, c.width, c.height);
        return c;
      } finally { URL.revokeObjectURL(url); }
    }
  }
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const toHex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

  /* ======================================================================
   * Rect helpers
   * ==================================================================== */
  function rectIntersect(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h);
    return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null;
  }
  function rectUnion(a, b) {
    if (!a) return b; if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }
  const layerRect = l => ({ x: l.x, y: l.y, w: l.canvas.width, h: l.canvas.height });
  const containsPt = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

  /* ======================================================================
   * Platform (file + clipboard I/O)
   * ==================================================================== */
  /** Set by the Electron preload (desktop/preload.js); undefined in a browser. */
  const Native = window.cutoutNative || null;
  const Platform = {
    /** True in the desktop app (Electron). */
    isNative: !!Native,
    /** Can Cutout read the clipboard on its own (for a Paste button and Paste menu items)?
     *  Not as a local page in Edge, which refuses it even after "Allow". The desktop app reads it
     *  through Electron, which brings those commands back. Ctrl+V works either way. */
    canReadClipboard: !!Native,
    /** Cutout's version ('1.1.1'): the desktop app's own, else cutout/version.js (browser). */
    async version() {
      try { if (Native && Native.getVersion) return await Native.getVersion(); } catch (_) { /* fall back */ }
      return window.CUTOUT_VERSION || null;
    },
    /** Must be called synchronously inside a user gesture (key press / click). */
    copyImage(canvas) {
      if (!navigator.clipboard || !window.ClipboardItem) return Promise.reject(new Error('Clipboard unavailable'));
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(canvas, 'image/png') })]);
    },
    /** Returns { image: Blob } if there's an image, otherwise { text, html } (for SVG / Figma detection). */
    async readClipboard() {
      if (Native) {
        const clip = await Native.readClipboard();
        if (clip.png) return { image: new Blob([clip.png], { type: 'image/png' }) };
        return { text: clip.text || '', html: clip.html || '' };
      }
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error('Clipboard unavailable');
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) return { image: await item.getType(type) };
      }
      const readText = async type => {
        for (const item of items) if (item.types.includes(type)) return (await item.getType(type)).text();
        return '';
      };
      return { text: await readText('text/plain'), html: await readText('text/html') };
    },
    pickFiles() {
      return new Promise(resolve => {
        const input = $('#fileInput');
        input.value = '';
        input.onchange = () => resolve(Array.from(input.files || []));
        input.oncancel = () => resolve([]);
        input.click();
      });
    },
    /**
     * Shows a Save dialog offering PNG and JPEG. makeBlob(mime) is called after the
     * location is chosen; the format follows the chosen file name.
     * Returns { handle, name, mime }, or null if cancelled. Falls back to a download.
     */
    async saveAs(makeBlob, suggestedName) {
      if (Native) {
        const path = await Native.saveDialog(suggestedName);
        if (!path) return null;
        const handle = { path }, mime = mimeFor(path);
        await Platform.write(handle, await makeBlob(mime));
        return { handle, name: path.split(/[\\/]/).pop(), mime };
      }
      const png = { description: 'PNG image', accept: { 'image/png': ['.png'] } };
      const jpg = { description: 'JPEG image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } };
      if (window.showSaveFilePicker) {
        let handle = null;
        try {
          handle = await window.showSaveFilePicker({
            suggestedName,
            startIn: 'desktop',
            types: mimeFor(suggestedName) === 'image/jpeg' ? [jpg, png] : [png, jpg],
          });
        } catch (e) {
          if (e.name === 'AbortError') return null;
        }
        if (handle) {
          const mime = mimeFor(handle.name);
          await Platform.write(handle, await makeBlob(mime));
          return { handle, name: handle.name, mime };
        }
      }
      const mime = mimeFor(suggestedName), blob = await makeBlob(mime);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = suggestedName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { handle: null, name: suggestedName, mime };
    },
    async write(handle, blob) {
      if (handle.path) { await Native.writeFile(handle.path, new Uint8Array(await blob.arrayBuffer())); return; }
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    },
    /** Desktop app: title bar follows the theme (system / light / dark). */
    setTheme(pref) { if (Native) Native.setTheme(pref); },
    /** Desktop app: files from "Open with", the command line or a second launch. cb(files: File[]). */
    onOpenFiles(cb) {
      if (!Native) return;
      const toFiles = list => list.map(f => new File([f.data], f.name, { type: f.type }));
      Native.onOpenFiles(list => cb(toFiles(list)));
      Native.getStartupFiles().then(list => { if (list.length) cb(toFiles(list)); });
    },
    /** Desktop app on Mac: Edit menu commands (undo / redo / selectAll) for the page. */
    onMenuCommand(cb) { if (Native && Native.onMenuCommand) Native.onMenuCommand(cb); },
    /** Desktop app: drag a PNG out as a real file. Call from dragstart with bytes prepared earlier. */
    startDragOut(name, pngBytes) { if (Native) Native.startDrag(name, pngBytes); },
  };
  const mimeFor = name => (/\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png');

  /* ======================================================================
   * State
   * ==================================================================== */
  const PREFS_KEY = 'cutout.prefs.v1';
  const state = {
    artboard: { w: 800, h: 600, bg: null }, // bg: null = transparent, or '#rrggbb'
    layers: [],          // bottom → top: { id, name, x, y, canvas, visible }
    selected: new Set(), // selected layer ids
    active: null,        // the layer pixel tools act on
    sel: null,           // pixel selection
    tool: 'pointer',
    opts: { theme: 'system', eraserSize: 20, selMode: 'replace', mqStyle: 'normal', mqW: 1200, mqH: 630, lockRatio: true, abLockCanvas: false, wandTol: 32, wandContig: true, defringe: 2, fillTol: 32, fillContig: true, fillWith: 'color', bucketFill: 'color', color: '#ff3b30', jpegQ: 90 },
  };
  try { Object.assign(state.opts, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch (_) { /* ignore */ }
  delete state.opts.pasteHalf; // retired setting (an early name for the half-size paste option)
  delete state.opts.svgScale;  // retired: SVG now always renders at 1×
  // Fill with: 'color' or 'smart' (the selection's Fill, and the Paint bucket's own setting)
  for (const k of ['fillWith', 'bucketFill']) if (state.opts[k] !== 'smart') state.opts[k] = 'color';
  delete state.opts.halfPaste; // retired "Paste images at: Half size": Figma copies now paste at 1× directly
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.opts)); } catch (_) { /* ignore */ } }

  let nextId = 1;
  let internalClip = null; // { canvas, x, y } – remembers where a copy came from
  const view = { s: 1, ox: 0, oy: 0 }; // device px per doc px, offset in device px
  let dpr = window.devicePixelRatio || 1;

  function newLayer(canvas, x, y, name) {
    const id = nextId++;
    return { id, name: name || `Bitmap ${id}`, x: Math.round(x), y: Math.round(y), canvas, visible: true };
  }
  const getLayer = id => state.layers.find(l => l.id === id) || null;
  const activeLayer = () => getLayer(state.active);
  const layerIndex = id => state.layers.findIndex(l => l.id === id);
  function insertAbove(layer, refId) {
    const i = refId != null ? layerIndex(refId) : -1;
    if (i < 0) state.layers.push(layer); else state.layers.splice(i + 1, 0, layer);
  }
  function removeLayer(id) {
    const i = layerIndex(id);
    if (i >= 0) state.layers.splice(i, 1);
    state.selected.delete(id);
    if (state.active === id) state.active = null;
  }
  function selectOnly(id) {
    state.selected = new Set(id != null ? [id] : []);
    state.active = id;
    if (id != null) artboardSel = false;
  }
  let artboardSel = false; // the artboard itself is selected (shows resize handles)
  function selectArtboard() {
    artboardSel = true;
    state.selected.clear();
    state.active = null;
    changed();
  }

  /* ======================================================================
   * History
   *
   * Snapshots of the document. Layer canvases are never mutated (every pixel edit makes a
   * new canvas), so a snapshot just references them through an "image record".
   * To keep memory small, once a canvas has been replaced by an edit, its record is shrunk
   * to a patch: only the pixels that differ from its replacement. Undoing back to it
   * rebuilds the full image. A byte budget drops the oldest steps as a last resort.
   * ==================================================================== */
  const undoStack = [], redoStack = [];
  const MAX_HISTORY = 150;
  const HISTORY_BUDGET = 512 * 1024 * 1024; // bytes of pixels kept for undo
  let dirty = false; // unsaved changes (for the close warning)

  const recOf = new WeakMap(); // canvas → its image record, shared by every snapshot
  function recordOf(c) {
    let r = recOf.get(c);
    if (!r) { r = { canvas: c }; recOf.set(c, r); }
    return r;
  }
  /** Full canvas for a record, rebuilding it from its patch chain if needed. */
  function resolveImage(r) {
    if (r.canvas) return r.canvas;
    const base = resolveImage(r.base), c = makeCanvas(r.w, r.h), g = ctx2d(c);
    g.drawImage(base, r.dx, r.dy);
    if (r.patch) {
      g.clearRect(r.px, r.py, r.patch.width, r.patch.height);
      g.putImageData(r.patch, r.px, r.py);
    }
    r.canvas = c;
    r.base = r.patch = null;
    recOf.set(c, r);
    return c;
  }
  /** Shrinks a full record (at x, y) to a patch against the canvas that replaced it (at nx, ny). */
  function compactRecord(r, x, y, next, nx, ny) {
    const old = r.canvas, w = old.width, h = old.height, dx = nx - x, dy = ny - y;
    const tmp = makeCanvas(w, h);
    ctx2d(tmp).drawImage(next, dx, dy);
    const a = new Uint32Array(getData(old).data.buffer), b = new Uint32Array(getData(tmp).data.buffer);
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let yy = 0; yy < h; yy++) {
      const row = yy * w;
      for (let xx = 0; xx < w; xx++) {
        if (a[row + xx] !== b[row + xx]) {
          if (xx < minX) minX = xx;
          if (xx > maxX) maxX = xx;
          if (yy < minY) minY = yy;
          if (yy > maxY) maxY = yy;
        }
      }
    }
    r.base = recordOf(next);
    r.w = w; r.h = h; r.dx = dx; r.dy = dy; r.px = minX; r.py = minY;
    r.patch = maxX < 0 ? null : ctx2d(old).getImageData(minX, minY, maxX - minX + 1, maxY - minY + 1);
    r.canvas = null;
    recOf.delete(old);
  }
  function liveCanvases() {
    const s = new Set();
    for (const l of state.layers) { s.add(l.canvas); if (l.src) s.add(l.src); }
    return s;
  }
  /** Shrinks the newest undo step's replaced images to patches. */
  function compactHistory() {
    clearTimeout(compactHistory.timer);
    const top = undoStack[undoStack.length - 1];
    if (!top) return;
    const live = liveCanvases(), keep = new Set();
    // Pixels kept for repeat wand clicks: let them go once their layer is gone or edited.
    if (pixelsCache && !live.has(pixelsCache.canvas)) pixelsCache = null;
    if (lastWand && !live.has(lastWand.canvas)) lastWand = null;
    for (const s of redoStack) for (const l of s.layers) if (l.canvas.canvas) keep.add(l.canvas.canvas);
    for (const l of top.layers) {
      const r = l.canvas;
      if (!r.canvas || live.has(r.canvas) || keep.has(r.canvas)) continue;
      const cur = state.layers.find(x => x.id === l.id);
      if (!cur || cur.canvas === r.canvas) continue; // layer was deleted: keep its full image
      compactRecord(r, l.x, l.y, cur.canvas, cur.x, cur.y);
    }
    // Last resort: drop the oldest steps if undo still holds too many pixels.
    while (undoStack.length > 1 && historyBytes() > HISTORY_BUDGET) undoStack.shift();
  }
  function scheduleCompact() {
    clearTimeout(compactHistory.timer);
    // Never mid-drag: an eraser stroke paints into the live canvas until the mouse is released.
    compactHistory.timer = setTimeout(() => (drag ? scheduleCompact() : compactHistory()), 400);
  }
  function historyBytes() {
    const seen = new Set(), live = liveCanvases();
    let n = 0;
    const full = c => { if (!seen.has(c) && !live.has(c)) n += c.width * c.height * 4; seen.add(c); };
    for (const s of undoStack.concat(redoStack)) {
      for (const l of s.layers) {
        // the original pixels a scaled layer keeps for "Original size" (often the biggest image there is)
        if (l.src) full(l.src);
        const r = l.canvas;
        if (seen.has(r)) continue;
        seen.add(r);
        if (r.canvas) full(r.canvas);
        else if (r.patch) n += r.patch.data.length;
      }
    }
    return n;
  }
  function snapshot() {
    return {
      artboard: { ...state.artboard },
      layers: state.layers.map(l => ({ ...l, canvas: recordOf(l.canvas) })),
      selected: [...state.selected],
      active: state.active,
      sel: state.sel,
      view: { s: view.s, ox: view.ox, oy: view.oy, fit: viewFit && { ...viewFit } },
    };
  }
  function restore(s) {
    // When the step changes the artboard's size (New, Trim, Canvas size, a first paste), the view
    // goes back with it; otherwise the artboard would sit wherever the later view left it. Other
    // steps leave the view alone (you may have zoomed in since).
    const resized = s.artboard.w !== state.artboard.w || s.artboard.h !== state.artboard.h;
    if (resized && s.view) {
      if (s.view.fit) viewFit = { ...s.view.fit };
      else { viewFit = null; view.s = s.view.s; view.ox = s.view.ox; view.oy = s.view.oy; }
    }
    state.artboard = { ...s.artboard };
    state.layers = s.layers.map(l => ({ ...l, canvas: resolveImage(l.canvas) }));
    state.selected = new Set(s.selected);
    state.active = s.active;
    state.sel = s.sel;
    if (resized && viewFit) fitView(viewFit.capAt100); // a fitted view is fitted again (the window may have changed)
  }
  function pushHistory() {
    compactHistory(); // the previous step is finished: shrink what it replaced
    undoStack.push(snapshot());
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    lastNudge.key = '';
    dirty = true;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    lastNudge.key = '';
    dirty = true;
    changed();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    lastNudge.key = '';
    dirty = true;
    changed();
  }

  /* ======================================================================
   * Selection masks
   * ==================================================================== */
  function selFromRect(r) { return { x: r.x, y: r.y, w: r.w, h: r.h, mask: new Uint8Array(r.w * r.h).fill(1) }; }
  /** Shrinks the mask's box to its content; null if empty. */
  function selNormalize(s) {
    if (!s) return null;
    const { w, h, mask } = s;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[row + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) return s;
    const nw = maxX - minX + 1, nh = maxY - minY + 1, m = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const src = (y + minY) * w + minX;
      m.set(mask.subarray(src, src + nw), y * nw);
    }
    return { x: s.x + minX, y: s.y + minY, w: nw, h: nh, mask: m, matte: s.matte };
  }
  function selAt(s, x, y) {
    if (!s) return false;
    const lx = x - s.x, ly = y - s.y;
    return lx >= 0 && ly >= 0 && lx < s.w && ly < s.h && s.mask[ly * s.w + lx] === 1;
  }
  function blitMask(s, u, m) {
    for (let y = 0; y < s.h; y++) {
      const dst = (y + s.y - u.y) * u.w + (s.x - u.x), src = y * s.w;
      for (let x = 0; x < s.w; x++) if (s.mask[src + x]) m[dst + x] = 1;
    }
  }
  /** The selection limited to the artboard; null if nothing is left. New selections are clipped
   *  like this (marquee, wand, grow, invert), as in Fireworks. Moving a selection with the arrow
   *  keys keeps its shape; commands then use only the part inside the artboard (selToUse). */
  function selClip(s) {
    if (!s) return null;
    const r = rectIntersect(s, { x: 0, y: 0, w: state.artboard.w, h: state.artboard.h });
    if (!r) return null;
    if (r.x === s.x && r.y === s.y && r.w === s.w && r.h === s.h) return s;
    const mask = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) { const o = (r.y - s.y + y) * s.w + (r.x - s.x); mask.set(s.mask.subarray(o, o + r.w), y * r.w); }
    return selNormalize({ ...s, ...r, mask });
  }
  /** The selection a command acts on: the part inside the artboard (says so if there's none). */
  function selToUse() {
    if (!state.sel) return null;
    const s = selClip(state.sel);
    if (!s) toast('Selection is outside the artboard');
    return s;
  }
  function selCombine(a, b, mode) {
    if (mode === 'replace') return selNormalize(b);
    if (!b) return a;
    if (!a) return mode === 'add' ? selNormalize(b) : null;
    if (mode === 'add') {
      const u = rectUnion(a, b), m = new Uint8Array(u.w * u.h);
      blitMask(a, u, m);
      blitMask(b, u, m);
      return selNormalize({ ...u, mask: m, matte: a.matte || b.matte });
    }
    const r = rectIntersect(a, b);
    if (!r) return a;
    const m = a.mask.slice();
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (b.mask[(y - b.y) * b.w + (x - b.x)]) m[(y - a.y) * a.w + (x - a.x)] = 0;
      }
    }
    return selNormalize({ x: a.x, y: a.y, w: a.w, h: a.h, mask: m, matte: a.matte });
  }
  /** Grow (or shrink) a selection by 1 px on one side only, for any shape.
   *  (dx, dy) is the direction: grow pushes edges facing that way out; shrink pulls them in. */
  function selNudgeEdge(s, dx, dy, grow) {
    const box = grow
      ? { x: s.x + Math.min(0, dx), y: s.y + Math.min(0, dy), w: s.w + Math.abs(dx), h: s.h + Math.abs(dy) }
      : { x: s.x, y: s.y, w: s.w, h: s.h };
    const m = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        const X = box.x + x, Y = box.y + y;
        const on = grow
          ? selAt(s, X, Y) || selAt(s, X - dx, Y - dy) // a selected neighbour behind me pulls me in
          : selAt(s, X, Y) && selAt(s, X + dx, Y + dy); // drop pixels whose neighbour on that side isn't selected
        if (on) m[y * box.w + x] = 1;
      }
    }
    return selNormalize({ ...box, mask: m, matte: s.matte });
  }
  function selInvert(s, bounds) {
    const m = new Uint8Array(bounds.w * bounds.h).fill(1);
    if (s) {
      const r = rectIntersect(s, bounds);
      if (r) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            if (s.mask[(y - s.y) * s.w + (x - s.x)]) m[(y - bounds.y) * bounds.w + (x - bounds.x)] = 0;
          }
        }
      }
    }
    // Inverting a "background" selection gives a "subject" selection with the same matte color.
    const matte = s && s.matte ? { color: s.matte.color, inside: !s.matte.inside } : undefined;
    return selNormalize({ ...bounds, mask: m, matte });
  }

  /* ======================================================================
   * Edge cleanup (defringe)
   *
   * Anti-aliased edges contain pixels that are a blend of the subject and the
   * background. After the background is removed they show up as a light/dark
   * halo. For pixels within R px of the removed background, we take the color
   * of the nearest "solid" subject pixel (F) and work out how much of the pixel
   * is subject vs background (B):  C ≈ a·F + (1−a)·B.  The pixel becomes F at
   * alpha a. Pixels that aren't on the B–F line (real edge detail) are left alone.
   * ==================================================================== */
  const DEFRINGE_RESIDUAL = 32; // max color distance from the B–F blend line
  /** d: RGBA for a rw×rh rect. matte: 1 where the removed background is. B: [r,g,b]. */
  function defringe(d, rw, rh, matte, B, R) {
    if (R <= 0) return;
    const n = rw * rh, dist = new Uint8Array(n).fill(255), q = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (matte[i]) { dist[i] = 0; q[qt++] = i; }
    if (!qt) return;
    // 1) distance (in px, 8-connected) from the matte, up to R
    while (qh < qt) {
      const i = q[qh++], di = dist[i];
      if (di >= R) continue;
      const x = i % rw, y = (i / rw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= rw || (!dx && !dy)) continue;
          const j = yy * rw + xx;
          if (dist[j] > di + 1) { dist[j] = di + 1; q[qt++] = j; }
        }
      }
    }
    // 2) for each edge pixel, find the nearest solid subject pixel (beyond R)
    const src = new Int32Array(n).fill(-1);
    qh = qt = 0;
    for (let i = 0; i < n; i++) if (dist[i] === 255 && d[i * 4 + 3] > 0) { src[i] = i; q[qt++] = i; }
    while (qh < qt) {
      const i = q[qh++], x = i % rw, y = (i / rw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= rw || (!dx && !dy)) continue;
          const j = yy * rw + xx;
          if (src[j] < 0 && !matte[j] && dist[j] >= 1 && dist[j] <= R) { src[j] = src[i]; q[qt++] = j; }
        }
      }
    }
    // 3) un-mix the background out of each edge pixel
    const [Br, Bg, Bb] = B;
    for (let i = 0; i < n; i++) {
      const di = dist[i];
      if (di < 1 || di > R || matte[i]) continue;
      const o = i * 4;
      if (d[o + 3] === 0) continue;
      const cr = d[o] - Br, cg = d[o + 1] - Bg, cb = d[o + 2] - Bb;
      const s = src[i];
      if (s < 0) {
        // No solid subject nearby (very thin detail): only drop near-background pixels.
        if (cr * cr + cg * cg + cb * cb < 24 * 24) d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
        continue;
      }
      const so = s * 4;
      const fr = d[so] - Br, fg = d[so + 1] - Bg, fb = d[so + 2] - Bb, ff = fr * fr + fg * fg + fb * fb;
      if (ff < 30 * 30) continue; // subject color too close to the background to separate
      let a = (cr * fr + cg * fg + cb * fb) / ff;
      if (a >= 0.97) continue; // already solid subject
      if (a < 0) a = 0;
      const rr = cr - a * fr, rg = cg - a * fg, rb = cb - a * fb;
      if (rr * rr + rg * rg + rb * rb > DEFRINGE_RESIDUAL * DEFRINGE_RESIDUAL) continue; // real detail, not a blend
      if (a < 0.03) { d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0; continue; }
      d[o] = d[so]; d[o + 1] = d[so + 1]; d[o + 2] = d[so + 2];
      d[o + 3] = Math.round(d[o + 3] * a);
    }
  }
  const expandRect = (r, n) => ({ x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 });

  /** Pixels matching the color at (lx, ly) in layer coords. Returns Uint8Array (layer-sized) or null. */
  function matchMask(l, lx, ly, tol, contig) {
    const w = l.canvas.width, h = l.canvas.height;
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return null;
    return matchMaskData(pixelsOf(l.canvas), w, h, lx, ly, tol, contig);
  }
  function matchMaskData(d, w, h, lx, ly, tol, contig) {
    const s = (ly * w + lx) * 4;
    const r = d[s], g = d[s + 1], b = d[s + 2], a = d[s + 3];
    const match = i => {
      const o = i * 4, a2 = d[o + 3];
      if (a === 0 || a2 === 0) return Math.abs(a2 - a) <= tol; // transparent: compare alpha only
      return Math.abs(d[o] - r) <= tol && Math.abs(d[o + 1] - g) <= tol && Math.abs(d[o + 2] - b) <= tol && Math.abs(a2 - a) <= tol;
    };
    const n = w * h, out = new Uint8Array(n);
    if (!contig) {
      for (let i = 0; i < n; i++) if (match(i)) out[i] = 1;
      return out;
    }
    const stack = new Int32Array(n);
    let sp = 0;
    const s0 = ly * w + lx;
    out[s0] = 1;
    stack[sp++] = s0;
    while (sp > 0) {
      const i = stack[--sp], x = i % w;
      if (x > 0 && !out[i - 1] && match(i - 1)) { out[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !out[i + 1] && match(i + 1)) { out[i + 1] = 1; stack[sp++] = i + 1; }
      if (i >= w && !out[i - w] && match(i - w)) { out[i - w] = 1; stack[sp++] = i - w; }
      if (i + w < n && !out[i + w] && match(i + w)) { out[i + w] = 1; stack[sp++] = i + w; }
    }
    return out;
  }

  /* ======================================================================
   * Pixel operations
   * ==================================================================== */
  function alphaAt(l, x, y) {
    const lx = x - l.x, ly = y - l.y;
    if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) return 0;
    return ctx2d(l.canvas).getImageData(lx, ly, 1, 1).data[3];
  }
  /** Topmost visible layer with a non-transparent pixel at (x, y). */
  function hitLayer(x, y) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.visible && alphaAt(l, x, y) > 0) return l;
    }
    return null;
  }
  /** The layer a pixel tool should act on at (x, y). */
  function targetLayerAt(x, y) {
    const a = activeLayer();
    if (a && a.visible && containsPt(layerRect(a), x, y)) return a;
    const h = hitLayer(x, y);
    if (h) return h;
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (l.visible && containsPt(layerRect(l), x, y)) return l;
    }
    return null;
  }
  function sampleColor(x, y) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      if (!l.visible) continue;
      const lx = x - l.x, ly = y - l.y;
      if (lx < 0 || ly < 0 || lx >= l.canvas.width || ly >= l.canvas.height) continue;
      const d = ctx2d(l.canvas).getImageData(lx, ly, 1, 1).data;
      if (d[3] > 0) return { hex: toHex(d[0], d[1], d[2]), a: d[3] };
    }
    if (state.artboard.bg && containsPt({ x: 0, y: 0, w: state.artboard.w, h: state.artboard.h }, x, y)) return { hex: state.artboard.bg, a: 255 };
    return null;
  }
  function composite(rect, { bg = null, ids = null } = {}) {
    const c = makeCanvas(rect.w, rect.h), g = ctx2d(c);
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, rect.w, rect.h); }
    for (const l of state.layers) {
      if (!l.visible || (ids && !ids.has(l.id))) continue;
      g.drawImage(l.canvas, l.x - rect.x, l.y - rect.y);
    }
    return c;
  }
  /** Zeroes pixels of `canvas` (covering `rect` in doc coords) that are outside the selection. */
  function applyMask(canvas, rect, sel) {
    const g = ctx2d(canvas), id = g.getImageData(0, 0, rect.w, rect.h), d = id.data;
    for (let y = 0; y < rect.h; y++) {
      const sy = rect.y + y - sel.y;
      for (let x = 0; x < rect.w; x++) {
        const sx = rect.x + x - sel.x;
        const inside = sy >= 0 && sy < sel.h && sx >= 0 && sx < sel.w && sel.mask[sy * sel.w + sx] === 1;
        if (!inside) { const o = (y * rect.w + x) * 4; d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0; }
      }
    }
    g.putImageData(id, 0, 0);
  }
  /** Selected pixels of a layer as a trimmed { canvas, x, y }, or null. */
  function extractFromLayer(l, sel) {
    const r = rectIntersect(layerRect(l), sel);
    if (!r) return null;
    // Selection is the subject and the matte is outside it → clean the cut-out's edges.
    const R = sel.matte && !sel.matte.inside ? state.opts.defringe : 0;
    const e = R ? rectIntersect(layerRect(l), expandRect(r, R)) : r;
    const c = makeCanvas(e.w, e.h), g = ctx2d(c);
    g.drawImage(l.canvas, l.x - e.x, l.y - e.y);
    if (R) {
      const id = g.getImageData(0, 0, e.w, e.h), matte = new Uint8Array(e.w * e.h);
      for (let y = 0; y < e.h; y++) for (let x = 0; x < e.w; x++) if (!selAt(sel, e.x + x, e.y + y)) matte[y * e.w + x] = 1;
      defringe(id.data, e.w, e.h, matte, sel.matte.color, R);
      g.putImageData(id, 0, 0);
    }
    applyMask(c, e, sel);
    const t = trimmed(c);
    return t && { canvas: t.canvas, x: e.x + t.dx, y: e.y + t.dy };
  }
  function extractMerged(sel) {
    const c = composite(sel);
    applyMask(c, sel, sel);
    const t = trimmed(c);
    return t && { canvas: t.canvas, x: sel.x + t.dx, y: sel.y + t.dy };
  }
  /** Clears selected pixels in a layer (copy-on-write). Returns 'empty' if nothing is left. */
  function clearInLayer(l, sel) {
    const r = rectIntersect(layerRect(l), sel);
    if (!r) return 'none';
    // Selection is the background color → clean the edges of what's left.
    const R = sel.matte && sel.matte.inside ? state.opts.defringe : 0;
    const e = R ? rectIntersect(layerRect(l), expandRect(r, R)) : r;
    const c = cloneCanvas(l.canvas), g = ctx2d(c);
    const id = g.getImageData(e.x - l.x, e.y - l.y, e.w, e.h), d = id.data;
    const matte = R ? new Uint8Array(e.w * e.h) : null;
    for (let y = 0; y < e.h; y++) {
      const sy = e.y + y - sel.y;
      if (sy < 0 || sy >= sel.h) continue;
      for (let x = 0; x < e.w; x++) {
        const sx = e.x + x - sel.x;
        if (sx < 0 || sx >= sel.w || !sel.mask[sy * sel.w + sx]) continue;
        const i = y * e.w + x, o = i * 4;
        d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
        if (matte) matte[i] = 1;
      }
    }
    if (R) defringe(d, e.w, e.h, matte, sel.matte.color, R);
    g.putImageData(id, e.x - l.x, e.y - l.y);
    l.src = null; // pixel edit: bake the current size
    const t = trimmed(c);
    if (!t) return 'empty';
    l.canvas = t.canvas;
    l.x += t.dx;
    l.y += t.dy;
    return 'ok';
  }
  /* ---------- scaling (non-destructive until a pixel edit)
   * A scaled layer keeps its untouched pixels in `l.src`; `l.canvas` is the resampled
   * result. Any pixel edit bakes the current size in (clears `l.src`), like Sketch. */
  function resample(src, w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    let cur = src, cw = src.width, ch = src.height;
    // Halve in steps when shrinking a lot — avoids jagged, aliased results.
    while (cw / 2 >= w && ch / 2 >= h) {
      cw = Math.max(w, Math.round(cw / 2));
      ch = Math.max(h, Math.round(ch / 2));
      const n = makeCanvas(cw, ch), g = ctx2d(n);
      g.imageSmoothingQuality = 'high';
      g.drawImage(cur, 0, 0, cw, ch);
      cur = n;
    }
    const out = makeCanvas(w, h), g = ctx2d(out);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, w, h);
    return out;
  }
  function resizeLayer(l, x, y, w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (!l.src) l.src = l.canvas;
    l.canvas = w === l.src.width && h === l.src.height ? l.src : resample(l.src, w, h);
    l.x = Math.round(x);
    l.y = Math.round(y);
  }
  const isScaled = l => !!(l && l.src && l.canvas !== l.src);
  function originalSize() {
    const ls = state.layers.filter(l => state.selected.has(l.id) && isScaled(l));
    if (!ls.length) { toast('Already at original size'); return; }
    pushHistory();
    for (const l of ls) l.canvas = l.src;
    changed();
    const l = ls[ls.length - 1];
    toast(`Original size ${l.canvas.width} × ${l.canvas.height}`);
  }

  /** Gives the layer a fresh canvas that covers `rect` (copy-on-write). */
  function prepareLayerFor(l, rect) {
    l.src = null; // pixel edit: bake the current size
    const lr = layerRect(l), u = rectUnion(lr, rect);
    if (u.w === lr.w && u.h === lr.h) { l.canvas = cloneCanvas(l.canvas); return; }
    const c = makeCanvas(u.w, u.h);
    ctx2d(c).drawImage(l.canvas, l.x - u.x, l.y - u.y);
    l.canvas = c;
    l.x = u.x;
    l.y = u.y;
  }
  function paintSelection(l, sel, rgb) {
    prepareLayerFor(l, sel);
    const g = ctx2d(l.canvas);
    const id = g.getImageData(sel.x - l.x, sel.y - l.y, sel.w, sel.h), d = id.data;
    for (let i = 0; i < sel.mask.length; i++) {
      if (sel.mask[i]) { const o = i * 4; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255; }
    }
    g.putImageData(id, sel.x - l.x, sel.y - l.y);
  }

  /* ======================================================================
   * Commands
   * ==================================================================== */
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    // Screen readers: a separate live region, emptied first so the same message ("Copied") is read again
    const a = $('#announce');
    if (a) { a.textContent = ''; clearTimeout(toast.say); toast.say = setTimeout(() => { a.textContent = msg; }, 50); }
    t.classList.add('show');
    clearTimeout(toast.timer);
    // Longer messages stay longer: ~2.5 s for "Copied", ~5 s for a full sentence.
    const ms = Math.min(6000, Math.max(2500, 1200 + msg.length * 90));
    toast.timer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function addImageLayer(canvas, name, at) {
    pushHistory();
    let x, y;
    if (!state.layers.length) {
      // The first image starts a new document: Save asks where again, instead of silently
      // overwriting the file the previous image was saved to. (openFiles names it after its file.)
      docName = 'cutout'; saveTarget = null;
      state.artboard.w = canvas.width;
      state.artboard.h = canvas.height;
      x = 0; y = 0;
      fitView(true);
    } else if (at) {
      x = at.x; y = at.y;
    } else {
      const c = viewCenterDoc();
      x = Math.round(c.x - canvas.width / 2);
      y = Math.round(c.y - canvas.height / 2);
    }
    const l = newLayer(canvas, x, y, name);
    insertAbove(l, state.active);
    selectOnly(l.id);
    state.sel = null;
    changed();
    return l;
  }

  /** True if two canvases hold the same picture. Allows tiny differences, because a PNG
   *  round-trip through the clipboard can shift semi-transparent colors slightly. */
  function sameImage(a, b) {
    if (a.width !== b.width || a.height !== b.height) return false;
    const da = getData(a).data, db = getData(b).data;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i + 3] - db[i + 3]) > 2) return false;
      if (da[i + 3] > 8 && (Math.abs(da[i] - db[i]) > 3 || Math.abs(da[i + 1] - db[i + 1]) > 3 || Math.abs(da[i + 2] - db[i + 2]) > 3)) return false;
    }
    return true;
  }
  function pasteCanvas(canvas, label = 'Pasted') {
    const clip = internalClip;
    if (clip && state.layers.length && sameImage(clip.canvas, canvas)) {
      // Copied from Cutout: paste back in place, losslessly.
      addImageLayer(clip.canvas, null, { x: clip.x, y: clip.y });
    } else {
      addImageLayer(canvas, null, null);
    }
    toast(`${label} ${canvas.width} × ${canvas.height}`);
  }

  /* ---------- pasting things that aren't images: SVG markup and Figma's own clipboard format */
  /** Returns the SVG markup if the text is a whole SVG document (e.g. Figma's Copy as SVG). */
  function extractSvg(text) {
    const t = (text || '').trim();
    return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t) && /<\/svg>$/i.test(t) ? t : null;
  }
  /** A normal Ctrl+C in Figma: Figma's own data, encoded inside HTML. */
  const isFigmaCopy = html => /\((figmeta|figma)\)|data-buffer=/.test(html || '');
  /** Loads cutout/figma.js (and the decoders it needs) the first time a Figma copy is pasted. */
  let figmaLoading = null;
  function loadFigma() {
    const load = src => new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error(`Couldn’t load ${src}`));
      document.head.appendChild(s);
    });
    figmaLoading = figmaLoading || Promise.all([load('vendor/fzstd.js'), load('vendor/kiwi.js')])
      .then(() => load('figma.js')).then(() => window.CutoutFigma)
      .catch(e => { figmaLoading = null; throw e; });
    return figmaLoading;
  }
  /** Renders a normal Figma copy at 1× as one image, like Figma's Copy as PNG of the selection.
   *  If anything can't be drawn exactly, or its images can't be downloaded, nothing is pasted. */
  async function pasteFigma(html) {
    const failMsg = fmtKeys('Some features aren’t supported. Use Copy as PNG (Ctrl+Shift+C)');
    let figma;
    try { figma = await loadFigma(); } catch (_) { toast(failMsg); return; }
    const busy = setTimeout(() => toast('Pasting from Figma…'), 400);
    let result;
    try { result = await figma.render(html, { scale: 1 }); }
    catch (e) { result = null; console.warn('Figma paste:', e); }
    clearTimeout(busy);
    if (!result || !result.canvas) {
      if (result && result.unsupported && result.unsupported.length) console.warn('Figma paste, not supported:', result.unsupported.join(', '));
      toast(result && result.reason === 'images' ? fmtKeys('Couldn’t load the images. Copy again, or use Copy as PNG (Ctrl+Shift+C)') : failMsg);
      return;
    }
    // A copy set up like Cutout's own layers, for fast pixel reads (hover, wand, eyedropper)
    const l = addImageLayer(cloneCanvas(result.canvas), null, null);
    if (result.name) { l.name = result.name; changed(); }
    toast(`Pasted ${result.canvas.width} × ${result.canvas.height}`);
  }
  /** Renders SVG markup into a canvas at the chosen scale (vector, so 2× / 3× stay sharp). */
  async function svgToCanvas(svg, scale) {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('Not valid SVG');
    if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const px = v => (/^\s*[\d.]+(px)?\s*$/.test(v || '') ? parseFloat(v) : NaN); // ignore %, em…
    let w = px(root.getAttribute('width')), h = px(root.getAttribute('height'));
    if (Number.isNaN(w)) w = vb.length === 4 ? vb[2] : 300;
    if (Number.isNaN(h)) h = vb.length === 4 ? vb[3] : 150;
    root.setAttribute('width', w);
    root.setAttribute('height', h);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = makeCanvas(w * scale, h * scale);
      ctx2d(c).drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  /** Handles the non-image part of a paste: a normal Figma copy, or SVG markup (Copy as SVG),
   *  both at 1× (the size they have in Figma). Returns true if it pasted something. */
  async function pasteText(text, html) {
    if (isFigmaCopy(html)) { await pasteFigma(html); return true; }
    const svg = extractSvg(text) || extractSvg(html);
    if (svg) {
      try {
        pasteCanvas(await svgToCanvas(svg, 1), 'Pasted SVG');
      } catch (_) {
        toast('Couldn’t read the SVG');
      }
      return true;
    }
    toast('No image on the clipboard');
    return false;
  }

  /** Paste via the async clipboard (Paste button, menus). Edge refuses this clipboard access for
   *  pages opened from a local file (even after "Allow"), so then we ask for Ctrl+V, which always works. */
  async function pasteFromButton() {
    let clip;
    try { clip = await Platform.readClipboard(); }
    catch (_) { toast(fmtKeys('Press Ctrl+V to paste')); return; }
    if (clip.image) {
      try { pasteCanvas(await blobToCanvas(clip.image)); } catch (_) { toast('Couldn’t read the image'); }
      return;
    }
    await pasteText(clip.text, clip.html);
  }

  async function openFiles(files, dropAt) {
    if (!files) files = await Platform.pickFiles();
    // Some sources hand over files with no type (certain drags, network folders): go by the name then.
    const byExt = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif' };
    files = files.map(f => { const t = !f.type && byExt[(/\.([^.]+)$/.exec(f.name) || [])[1]?.toLowerCase()]; return t ? new File([f], f.name, { type: t }) : f; });
    const images = files.filter(f => f.type.startsWith('image/'));
    if (!images.length) { if (files.length) toast('Not an image'); return; }
    for (const f of images) {
      try {
        const c = await blobToCanvas(f);
        const name = f.name.replace(/\.[^.]+$/, '');
        const first = !state.layers.length;
        const at = dropAt && !first ? { x: Math.round(dropAt.x - c.width / 2), y: Math.round(dropAt.y - c.height / 2) } : null;
        addImageLayer(c, name, at);
        if (first) docName = name; // first image names the document
      } catch (_) {
        toast(`Couldn't open ${f.name}`);
      }
    }
  }

  function copy(cut) {
    let clip = null, source = '';
    const sel = selToUse();
    if (state.sel && !sel) return;
    if (sel) {
      const l = activeLayer();
      if (l && l.visible) { clip = extractFromLayer(l, sel); source = 'layer'; }
      if (!clip) { clip = extractMerged(sel); source = 'merged'; }
    } else if (state.selected.size) {
      const ls = state.layers.filter(l => state.selected.has(l.id) && l.visible);
      const r = ls.reduce((u, l) => rectUnion(u, layerRect(l)), null);
      if (r) clip = { canvas: composite(r, { ids: state.selected }), x: r.x, y: r.y };
      source = 'layers';
    } else if (state.layers.length) {
      const A = state.artboard;
      clip = { canvas: composite({ x: 0, y: 0, w: A.w, h: A.h }, { bg: A.bg }), x: 0, y: 0 };
      source = 'artboard';
    }
    if (!clip) { toast('Nothing to copy'); return; }
    internalClip = clip;
    const { width: w, height: h } = clip.canvas;
    const label = source === 'artboard' ? 'artboard' : `${w} × ${h}`;
    // Cut removes the copied pixels or layers; a merged copy (or the artboard) is only copied
    const cuts = cut && ((sel && source === 'layer') || source === 'layers');
    let cutStep = null; // the undo step of this cut, to take it back if the copy fails
    Platform.copyImage(clip.canvas).then(
      () => toast(`${cuts ? 'Cut' : 'Copied'} ${label}`),
      () => {
        // The clipboard didn't take the image: a cut would have thrown the pixels away, so put
        // them back (unless something else was done since; then Undo still has them).
        const back = cutStep && undoStack[undoStack.length - 1] === cutStep && !redoStack.length && !drag;
        if (back) { undo(); redoStack.length = 0; updateChrome(); }
        toast(back ? 'Couldn’t access the clipboard, so nothing was cut' : 'Couldn’t access the clipboard');
      }
    );
    if (!cuts) return;
    pushHistory();
    cutStep = undoStack[undoStack.length - 1];
    if (source === 'layer') {
      const l = activeLayer();
      if (clearInLayer(l, sel) === 'empty') removeLayer(l.id);
    } else {
      // only the layers that were copied (hidden ones aren't in the copy, so they stay)
      for (const l of state.layers.filter(x => state.selected.has(x.id) && x.visible)) removeLayer(l.id);
    }
    changed();
  }

  /* ---------- align & distribute (Figma conventions)
   * One layer aligns to the artboard; several align to their combined bounds. */
  const selectedLayers = () => state.layers.filter(l => state.selected.has(l.id) && l.visible);
  function alignLayers(how) {
    const ls = selectedLayers();
    if (!ls.length) { toast('No layer selected'); return; }
    const A = state.artboard;
    const ref = ls.length === 1 ? { x: 0, y: 0, w: A.w, h: A.h } : ls.reduce((u, l) => rectUnion(u, layerRect(l)), null);
    const pos = l => {
      const w = l.canvas.width, h = l.canvas.height;
      switch (how) {
        case 'left': return [ref.x, l.y];
        case 'hcenter': return [Math.round(ref.x + (ref.w - w) / 2), l.y];
        case 'right': return [ref.x + ref.w - w, l.y];
        case 'top': return [l.x, ref.y];
        case 'vcenter': return [l.x, Math.round(ref.y + (ref.h - h) / 2)];
        default: return [l.x, ref.y + ref.h - h]; // bottom
      }
    };
    if (ls.every(l => { const [x, y] = pos(l); return x === l.x && y === l.y; })) return; // already aligned
    pushHistory();
    for (const l of ls) [l.x, l.y] = pos(l);
    changed();
  }
  /** Equal gaps between 3+ layers; the outermost two stay put. axis: 'h' | 'v' */
  function distributeLayers(axis) {
    const ls = selectedLayers();
    if (ls.length < 3) { toast('Select 3 or more layers'); return; }
    const k = axis === 'h' ? 'x' : 'y', size = l => (axis === 'h' ? l.canvas.width : l.canvas.height);
    const sorted = [...ls].sort((a, b) => a[k] + size(a) / 2 - (b[k] + size(b) / 2));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const span = last[k] + size(last) - first[k], used = sorted.reduce((n, l) => n + size(l), 0);
    const gap = (span - used) / (sorted.length - 1);
    pushHistory();
    let at = first[k];
    for (const l of sorted) { l[k] = Math.round(at); at += size(l) + gap; }
    changed();
  }

  /* ---------- spacing of a selected row / column (Figma's spacing handles + field)
   * The selection is a "run" when its layers don't overlap along one axis. */
  function selectionRun() {
    const ls = selectedLayers();
    if (ls.length < 2) return null;
    for (const axis of ['x', 'y']) {
      const p = axis, size = l => (axis === 'x' ? l.canvas.width : l.canvas.height);
      const sorted = [...ls].sort((a, b) => a[p] - b[p]);
      if (sorted.every((l, i) => i === 0 || l[p] >= sorted[i - 1][p] + size(sorted[i - 1]))) {
        const gaps = sorted.slice(1).map((l, i) => l[p] - (sorted[i][p] + size(sorted[i])));
        return { axis, ls: sorted, gaps, size };
      }
    }
    return null;
  }
  /** Sets every gap in the run to v px. The first layer stays put. */
  function setRunGap(run, v) {
    const p = run.axis;
    let at = run.ls[0][p] + run.size(run.ls[0]);
    for (const l of run.ls.slice(1)) { l[p] = Math.round(at + v); at = l[p] + run.size(l); }
  }
  function setSpacing(v) {
    const run = selectionRun();
    if (!run) return;
    if (run.gaps.every(g => g === v)) return;
    pushHistory();
    setRunGap(run, v);
    changed();
  }

  /** Flip ('h' / 'v') or rotate 90° ('cw' / 'ccw') the selected layers. Keeps each layer's center. */
  function transformLayers(kind) {
    const ls = state.layers.filter(l => state.selected.has(l.id));
    if (!ls.length) { toast('No layer selected'); return; }
    pushHistory();
    const rot = kind === 'cw' || kind === 'ccw';
    const tf = c => {
      const n = makeCanvas(rot ? c.height : c.width, rot ? c.width : c.height), g = ctx2d(n);
      if (kind === 'h') { g.translate(c.width, 0); g.scale(-1, 1); }
      else if (kind === 'v') { g.translate(0, c.height); g.scale(1, -1); }
      else if (kind === 'cw') { g.translate(c.height, 0); g.rotate(Math.PI / 2); }
      else { g.translate(0, c.width); g.rotate(-Math.PI / 2); }
      g.drawImage(c, 0, 0);
      return n;
    };
    for (const l of ls) {
      const w = l.canvas.width, h = l.canvas.height;
      if (l.src && l.src === l.canvas) { l.canvas = l.src = tf(l.canvas); }
      else { l.canvas = tf(l.canvas); if (l.src) l.src = tf(l.src); } // keep Original size working
      if (rot) { l.x = Math.round(l.x + (w - h) / 2); l.y = Math.round(l.y + (h - w) / 2); }
    }
    changed();
  }

  function duplicateSelected() {
    if (!state.selected.size) return;
    pushHistory();
    const dup = [];
    for (const l of state.layers.filter(x => state.selected.has(x.id))) {
      const n = newLayer(l.canvas, l.x, l.y, `${l.name} copy`);
      if (l.src) n.src = l.src; // a scaled layer's copy keeps its original pixels (Original size)
      insertAbove(n, l.id);
      dup.push(n.id);
    }
    state.selected = new Set(dup);
    state.active = dup[dup.length - 1];
    changed();
  }
  function saveSelectionAs() {
    const sel = selToUse();
    if (!sel) return;
    const l = activeLayer(), clip = (l && l.visible && extractFromLayer(l, sel)) || extractMerged(sel);
    if (!clip) { toast('Selection is empty'); return; }
    saveCanvasAs(clip.canvas, `${docName}-selection`);
  }

  function deleteSelectedLayers() {
    if (!state.selected.size) { toast('No layer selected'); return; }
    pushHistory();
    for (const id of [...state.selected]) removeLayer(id);
    changed();
  }

  /** Pixel commands leave a hidden layer alone (you couldn't see what they did); says so. */
  function hiddenLayer(l) {
    if (!l || l.visible) return false;
    toast('The layer is hidden');
    return true;
  }
  function deleteSelectionPixels() {
    const l = activeLayer(), sel = selToUse();
    if (!sel) return;
    if (!l) { toast('Select a layer first'); return; }
    if (hiddenLayer(l)) return;
    if (!rectIntersect(layerRect(l), sel)) { toast('Selection is outside the layer'); return; }
    pushHistory();
    if (clearInLayer(l, sel) === 'empty') removeLayer(l.id);
    changed();
  }

  function selToLayer(cut) {
    if (!state.sel) { toast('Make a selection first'); return; }
    const l = activeLayer(), sel = selToUse();
    if (!sel) return;
    if (!l) { toast('Select a layer first'); return; }
    if (hiddenLayer(l)) return;
    const ex = extractFromLayer(l, sel);
    if (!ex) { toast('Selection is empty'); return; }
    pushHistory();
    const n = newLayer(ex.canvas, ex.x, ex.y);
    insertAbove(n, l.id);
    if (cut && clearInLayer(l, sel) === 'empty') removeLayer(l.id);
    selectOnly(n.id);
    state.sel = null;
    setTool('pointer');
    changed();
    toast(`${cut ? 'Cut' : 'Copied'} to new layer`);
  }

  /** What Fill uses right now: the Paint bucket has its own setting, the selection's Fill another. */
  const fillMode = () => (state.tool === 'bucket' ? state.opts.bucketFill : state.opts.fillWith);
  /** Fills the selection with the fill color, or with a smart fill (from its surroundings). */
  function fillSelection(mode = fillMode()) {
    if (mode === 'smart') { smartFill(); return; }
    if (!state.sel) { toast('Make a selection first'); return; }
    const sel = selToUse();
    if (!sel) return;
    let l = activeLayer();
    if (hiddenLayer(l)) return;
    pushHistory();
    const rgb = hexToRgb(state.opts.color);
    if (!l) {
      l = newLayer(makeCanvas(sel.w, sel.h), sel.x, sel.y, 'Fill');
      state.layers.push(l);
      selectOnly(l.id);
    }
    paintSelection(l, sel, rgb);
    changed();
  }

  /* ---------- Smart fill: fill from the surroundings (content-aware fill, cutout/fill.js)
   * Fills the selection with patches copied from around it, so backgrounds, gradients and
   * texture continue through. Runs in a background worker so the window stays responsive. */
  let fillWorker = null, fillBusy = false, fillJob = 0;
  // Each fill gets an id, so a reply always reaches its own caller (the warm-up fills at launch
  // can still be running when the first real fill starts).
  const fillWaiting = new Map(); // id → { resolve, onMain }
  function runPatchFill(data, w, h, mask) {
    const onMain = () => ({ ok: cutoutPatchFill(data, w, h, mask), data });
    return new Promise(resolve => {
      try {
        if (!fillWorker) {
          const src = cutoutPatchFill.toString() +
            '\nonmessage = e => { const { id, data, w, h, mask } = e.data; const ok = cutoutPatchFill(data, w, h, mask); postMessage({ id, ok, data }, [data.buffer]); };';
          fillWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          fillWorker.onmessage = e => { const job = fillWaiting.get(e.data.id); if (job) { fillWaiting.delete(e.data.id); job.resolve(e.data); } };
          // The worker failed: do the waiting fills here. Their `data` was copied to the worker, so it's intact.
          fillWorker.onerror = () => {
            fillWorker = null;
            const jobs = [...fillWaiting.values()]; fillWaiting.clear();
            for (const job of jobs) setTimeout(() => job.resolve(job.onMain()), 30);
          };
        }
      } catch (_) { fillWorker = null; setTimeout(() => resolve(onMain()), 30); return; } // no workers here
      const id = ++fillJob;
      fillWaiting.set(id, { resolve, onMain });
      fillWorker.postMessage({ id, data, w, h, mask });
    });
  }
  // Start the worker shortly after launch and run two tiny fills (one smooth, one patch-based)
  // so the first real Smart fill doesn't pay for starting and warming it up.
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(async () => {
    const tiny = (w, noisy) => {
      const d = new Uint8ClampedArray(w * w * 4), m = new Uint8Array(w * w);
      for (let i = 0; i < d.length; i++) d[i] = noisy ? (i * 2654435761) >>> 24 : 200;
      for (let y = w / 2 - 3; y < w / 2 + 3; y++) for (let x = w / 2 - 3; x < w / 2 + 3; x++) m[y * w + x] = 1;
      return runPatchFill(d, w, w, m);
    };
    await tiny(16, false);
    await tiny(64, true);
  });
  async function smartFill() {
    if (!state.sel) { toast('Make a selection first'); return; }
    const l = activeLayer(), sel = selToUse();
    if (!sel) return;
    if (!l) { toast('Select a layer first'); return; }
    if (hiddenLayer(l)) return;
    const r = rectIntersect(layerRect(l), sel);
    if (!r) { toast('Selection is outside the layer'); return; }
    if (fillBusy) { toast('Still filling…'); return; }
    // The selection plus a margin of surroundings to copy from.
    const m = Math.min(400, Math.max(48, Math.round(Math.max(r.w, r.h) * 0.75)));
    const c = rectIntersect(layerRect(l), expandRect(r, m));
    const id = ctx2d(l.canvas).getImageData(c.x - l.x, c.y - l.y, c.w, c.h);
    const mask = new Uint8Array(c.w * c.h);
    let n = 0;
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (selAt(sel, c.x + x, c.y + y)) { mask[y * c.w + x] = 1; n++; }
    if (!n) { toast('Selection is empty'); return; }
    fillBusy = true;
    const before = l.canvas, slow = setTimeout(() => toast('Filling…'), 300);
    let res;
    try { res = await runPatchFill(id.data, c.w, c.h, mask); }
    finally { clearTimeout(slow); fillBusy = false; }
    if ($('#toast').textContent === 'Filling…') $('#toast').classList.remove('show');
    if (!res.ok) { toast('Not enough surroundings to fill from'); return; }
    if (getLayer(l.id) !== l || l.canvas !== before) { toast('The layer changed, so nothing was filled'); return; }
    pushHistory();
    prepareLayerFor(l, c);
    ctx2d(l.canvas).putImageData(new ImageData(res.data, c.w, c.h), c.x - l.x, c.y - l.y);
    changed();
  }

  function bucketAt(x, y) {
    const opts = state.opts, A = state.artboard;
    if (state.sel) {
      if (selAt(state.sel, x, y)) fillSelection();
      else toast('Click inside the selection');
      return;
    }
    // A smart fill needs a selection around what to remove.
    if (opts.bucketFill === 'smart') { toast('Make a selection first'); return; }
    const t = targetLayerAt(x, y);
    if (!t) {
      if (!containsPt({ x: 0, y: 0, w: A.w, h: A.h }, x, y)) return;
      pushHistory();
      const c = makeCanvas(A.w, A.h), g = ctx2d(c);
      g.fillStyle = opts.color;
      g.fillRect(0, 0, A.w, A.h);
      const l = newLayer(c, 0, 0, 'Fill');
      state.layers.unshift(l); // empty area → becomes a background at the bottom
      selectOnly(l.id);
      changed();
      return;
    }
    const m = matchMask(t, x - t.x, y - t.y, opts.fillTol, opts.fillContig);
    if (!m) return;
    pushHistory();
    selectOnly(t.id);
    t.canvas = cloneCanvas(t.canvas);
    t.src = null; // pixel edit: bake the current size
    const g = ctx2d(t.canvas), id = getData(t.canvas), d = id.data, rgb = hexToRgb(opts.color);
    for (let i = 0; i < m.length; i++) {
      if (m[i]) { const o = i * 4; d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255; }
    }
    g.putImageData(id, 0, 0);
    changed();
  }

  function selectAll() {
    if (state.tool === 'pointer' || state.tool === 'hand') {
      state.selected = new Set(state.layers.map(l => l.id));
      state.active = state.layers.length ? state.layers[state.layers.length - 1].id : null;
    } else {
      state.sel = selFromRect({ x: 0, y: 0, w: state.artboard.w, h: state.artboard.h });
    }
    changed();
  }
  function deselect() {
    if (state.sel) state.sel = null;
    else { state.selected.clear(); state.active = null; }
    changed();
  }
  function invertSelection() {
    const A = state.artboard;
    state.sel = selInvert(state.sel, { x: 0, y: 0, w: A.w, h: A.h });
    changed();
  }

  /** Shrink to content: the selection snaps to the object inside it. The background is read from
   *  the selection's own edge (its typical color and how much it varies, so a slightly uneven scan
   *  still counts as background). Straight lines across the whole selection (a scanner's edge)
   *  and specks are ignored. Works on what you see (all visible layers). */
  function shrinkToContent() {
    // with no selection: the whole artboard (the object found there becomes the selection)
    let s;
    if (state.sel) { s = selToUse(); if (!s) return; }
    else {
      if (!state.layers.some(l => l.visible)) { toast('Nothing to select'); return; }
      s = selFromRect({ x: 0, y: 0, w: state.artboard.w, h: state.artboard.h });
    }
    if (shrinkIsFresh()) { toast('The selection already fits'); return; }
    const o = findObject(s);
    if (typeof o === 'string') { toast(o); return; }
    const { w, h, mask, x0, y0, x1, y1 } = o;
    const r = { x: s.x + x0, y: s.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (r.w === w && r.h === h) { toast(state.sel ? 'The selection already fits' : 'The content fills the artboard'); return; }
    const m2 = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) m2[y * r.w + x] = mask[(y + y0) * w + x + x0];
    state.sel = selNormalize({ ...r, mask: m2, matte: s.matte });
    lastShrink = { sel: state.sel, canvases: state.layers.map(l => l.canvas) };
    changed();
  }

  /** The object inside a selection on a plain background (used by Shrink to content, Straighten
   *  and Clear corners). Returns { w, h, mask, d (the pixels), bg, tol, isObject(i), x0, y0, x1, y1 }
   *  in selection coordinates, or a message to show. */
  function findObject(s, { edgeLines = true, paper = null } = {}) {
    const { w, h, mask } = s, d = ctx2d(composite(s)).getImageData(0, 0, w, h).data;
    // Background samples (colors): the selection's edge, a ring 10 px in (past a scanner line right
    // on the edge), and a thin ring just outside (so a selection that already hugs the object still
    // sees the paper around it).
    const smp = [];
    const take = (a, o) => smp.push(a[o], a[o + 1], a[o + 2], a[o + 3]);
    let edgeN = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) { take(d, i * 4); edgeN++; }
    }
    if (edgeN < 8) return 'Selection is too small';
    // rings 10 and 20 px in (when the selection is the whole scan, its edge is all scanner line)
    const whole = s.x <= 0 && s.y <= 0 && s.x + w >= state.artboard.w && s.y + h >= state.artboard.h;
    for (const k of whole ? [10, 20] : [10]) if (w > 4 * k && h > 4 * k) {
      for (let x = k; x < w - k; x++) for (const y of [k, h - 1 - k]) if (mask[y * w + x]) take(d, (y * w + x) * 4);
      for (let y = k + 1; y < h - 1 - k; y++) for (const x of [k, w - 1 - k]) if (mask[y * w + x]) take(d, (y * w + x) * 4);
    }
    const P = 3, O = { x: s.x - P, y: s.y - P, w: w + 2 * P, h: h + 2 * P }, od = ctx2d(composite(O)).getImageData(0, 0, O.w, O.h).data;
    for (let y = 0; y < O.h; y++) for (let x = 0; x < O.w; x++) {
      if (x >= P && y >= P && x < P + w && y < P + h) continue;
      const o = (y * O.w + x) * 4; if (od[o + 3]) take(od, o);
    }
    // background = the shade most samples are close to (not the average: an edge can run along a
    // scanner's dark line for a long way), and how much the samples near it vary
    const near = (col, a, o) => Math.max(Math.abs(a[o] - col[0]), Math.abs(a[o + 1] - col[1]), Math.abs(a[o + 2] - col[2]), Math.abs(a[o + 3] - col[3]));
    const bins = new Map();
    for (let o = 0; o < smp.length; o += 4) {
      const k = ((smp[o] >> 4) << 12) | ((smp[o + 1] >> 4) << 8) | ((smp[o + 2] >> 4) << 4) | (smp[o + 3] >> 4), b = bins.get(k) || { n: 0, c: [0, 0, 0, 0] };
      b.n++; for (let c = 0; c < 4; c++) b.c[c] += smp[o + c]; bins.set(k, b);
    }
    let bg = null, bestN = -1;
    for (const b of [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 4)) {
      const col = b.c.map(v => v / b.n); let n = 0;
      for (let o = 0; o < smp.length; o += 4) if (near(col, smp, o) <= 8) n++; // tight: paper and a light gray line stay apart
      if (n > bestN) { bestN = n; bg = col; }
    }
    if (paper) { // the caller knows the paper's color (e.g. read from the corners of a cropped card)
      bg = paper;
    }
    const dev = i => near(bg, d, i * 4);
    const noise = []; for (let o = 0; o < smp.length; o += 4) { const v = near(bg, smp, o); if (v <= 16) noise.push(v); }
    noise.sort((a, b) => a - b);
    const tol = Math.min(40, Math.max(12, (noise[Math.floor(noise.length * 0.9)] || 0) * 1.5 + 6));
    const fg = new Uint8Array(w * h);
    // On opaque paper, mostly transparent pixels are never the object (the corners Straighten
    // leaves, and their soft edges), and the rest is judged by color. On a transparent background,
    // anything visible enough is.
    const devRGB = i => Math.max(Math.abs(d[i * 4] - bg[0]), Math.abs(d[i * 4 + 1] - bg[1]), Math.abs(d[i * 4 + 2] - bg[2]));
    if (bg[3] >= 128) { for (let i = 0; i < w * h; i++) if (mask[i] && d[i * 4 + 3] >= 128 && devRGB(i) > tol) fg[i] = 1; }
    else for (let i = 0; i < w * h; i++) if (mask[i] && d[i * 4 + 3] >= 16 && dev(i) > tol) fg[i] = 1;
    // Scanner edges sit on the image's edges and wobble, fade and have gaps. Where the selection
    // reaches an edge of the image, peel rows/columns off that side while they're mostly not
    // background; stop at the first one that isn't.
    const A = state.artboard, xs = new Set([0, A.w]), ys = new Set([0, A.h]);
    for (const l of state.layers) if (l.visible) { xs.add(l.x); xs.add(l.x + l.canvas.width); ys.add(l.y); ys.add(l.y + l.canvas.height); }
    // Then a gentler pass for the line's faint, ragged tail: keep peeling while a little is left,
    // and stop as soon as it jumps up again (that's the object).
    const peelBits = new Uint8Array(w * h); // pixels peeled off as edge lines, per side (r0 1, r1 2, c0 4, c1 8)
    const peel = (rows, fromEnd) => {
      const len = rows ? h : w, span = rows ? w : h, bit = rows ? (fromEnd ? 2 : 1) : (fromEnd ? 8 : 4);
      let strong = true, prev = 1;
      const undo = [], covs = []; // what was peeled per row, in case part of it is the object
      for (let k = 0; k < Math.min(32, len >> 2); k++) {
        const a = fromEnd ? len - 1 - k : k; let n = 0, m = 0;
        for (let b = 0; b < span; b++) { const i = rows ? a * w + b : b * w + a; m += mask[i]; n += fg[i]; }
        if (!m) break;
        const cov = n / m;
        if (strong && cov < 0.5) { if (k === 0) break; strong = false; }
        // A line is at most ~12 px thick: still mostly "object" deeper than that means the object
        // starts right after the line (or touches the edge itself). Keep the leading rows that look
        // like the first one (the line), give back the rest.
        if (strong && k >= 12) {
          let j = 0; while (j < covs.length && covs[j] >= covs[0] - 0.15) j++;
          for (let t = j <= 12 && j < covs.length ? j : 0; t < undo.length; t++) for (const i of undo[t]) { fg[i] = 1; peelBits[i] &= ~bit; }
          return;
        }
        if (!strong && (cov < 0.02 || cov > prev * 1.5 + 0.05)) break;
        const row = [];
        for (let b = 0; b < span; b++) { const i = rows ? a * w + b : b * w + a; if (fg[i]) { row.push(i); fg[i] = 0; peelBits[i] |= bit; } }
        undo.push(row); covs.push(cov);
        prev = cov;
      }
    };
    const nearEdge = (set, v) => [...set].some(e => Math.abs(e - v) <= 16); // on or just inside it
    // An object in the scan's corner covers the edge lines there, so a line can run along only part
    // of a side. Along such a side, thin bands that hug it (at most 16 px deep) for a long stretch are
    // lines too; the object itself is deeper than that.
    const lineAt = {}; // per side: where along it a line was found
    const lineBits = new Uint8Array(w * h); // pixels taken as edge lines, per side (r0 1, r1 2, c0 4, c1 8)
    const hugging = (rows, fromEnd) => {
      const along = rows ? w : h, depth = rows ? h : w, mark = lineAt[(rows ? 'r' : 'c') + (fromEnd ? 1 : 0)] = new Uint8Array(along);
      const bit = rows ? (fromEnd ? 2 : 1) : (fromEnd ? 8 : 4);
      const at = (p, k) => { const a = fromEnd ? depth - 1 - k : k; return rows ? a * w + p : p * w + a; };
      const st = new Int32Array(along).fill(-1), ln = new Int32Array(along);
      for (let p = 0; p < along; p++) {
        let k = 0; while (k < 6 && k < depth && !fg[at(p, k)]) k++;
        if (k >= 6 || k >= depth) continue;
        const start = k; while (k < depth && fg[at(p, k)] && k - start <= 16) k++;
        if (k - start <= 16) { st[p] = start; ln[p] = k - start; }
      }
      // stretches of such bands (short gaps allowed); long ones are lines
      for (let p = 0; p < along;) {
        if (st[p] < 0) { p++; continue; }
        let q = p, gap = 0, n = 0;
        while (q < along && gap <= 4) { if (st[q] >= 0) { n++; gap = 0; } else gap++; q++; }
        // (a short stretch counts too when it runs off the end of the selection: the line goes on)
        if (n >= 40 || ((p === 0 || q >= along) && n >= 8)) for (let t = p; t < q; t++) if (st[t] >= 0) { mark[t] = 1; for (let k = st[t]; k < st[t] + ln[t]; k++) { const i = at(t, k); fg[i] = 0; lineBits[i] |= bit; } }
        p = q;
      }
    };
    // (not after cropping to the object: then its own outline is on the image edge)
    if (edgeLines && nearEdge(ys, s.y)) { peel(true, false); hugging(true, false); }
    if (edgeLines && nearEdge(ys, s.y + h)) { peel(true, true); hugging(true, true); }
    if (edgeLines && nearEdge(xs, s.x)) { peel(false, false); hugging(false, false); }
    if (edgeLines && nearEdge(xs, s.x + w)) { peel(false, true); hugging(false, true); }
    // pieces of the object; specks and thin slivers are dropped
    const pieceOf = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1; const pieces = [];
    for (let i0 = 0; i0 < w * h; i0++) {
      if (!fg[i0] || pieceOf[i0] >= 0) continue;
      let top = 0, area = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1; const id = pieces.length;
      stack[top++] = i0; pieceOf[i0] = id;
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0; area++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy, j = yy * w + xx;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && fg[j] && pieceOf[j] < 0) { pieceOf[j] = id; stack[top++] = j; }
        }
      }
      pieces.push({ area, bx0, by0, bx1, by1, keep: area >= 12 && Math.min(bx1 - bx0, by1 - by0) + 1 >= 4 });
    }
    // Leftovers of an edge line: a piece hugging a side where a line was found, next to or along
    // that line, is part of it (e.g. the scan's corner, where the top and side lines meet and the
    // band is a little deeper than the line cleanup takes). Never the object's biggest piece.
    const maxArea = pieces.reduce((m, p) => Math.max(m, p.area), 0), D = 24;
    const alongLine = (mark, a0, a1) => { if (!mark) return false; for (let t = Math.max(0, a0 - 16); t <= Math.min(mark.length - 1, a1 + 16); t++) if (mark[t]) return true; return false; };
    for (const p of pieces) {
      if (!p.keep || p.area === maxArea) continue;
      if ((p.by1 < D && alongLine(lineAt.r0, p.bx0, p.bx1)) || (p.by0 >= h - D && alongLine(lineAt.r1, p.bx0, p.bx1)) ||
          (p.bx1 < D && alongLine(lineAt.c0, p.by0, p.by1)) || (p.bx0 >= w - D && alongLine(lineAt.c1, p.by0, p.by1))) p.keep = false;
    }
    // dust is judged against the object: pieces far smaller than the biggest one don't count
    // (on a big scan a speck can be dozens of pixels)
    const biggest = pieces.reduce((m, p) => Math.max(m, p.keep ? p.area : 0), 0);
    for (const p of pieces) {
      if (p.keep) p.keep = p.area >= Math.max(12, biggest * 0.002);
      if (p.keep) { x0 = Math.min(x0, p.bx0); y0 = Math.min(y0, p.by0); x1 = Math.max(x1, p.bx1); y1 = Math.max(y1, p.by1); }
    }
    if (x1 < 0) return 'Nothing stands out from the background';
    // An edge line that runs along a side everywhere except where the object is: the object covers
    // it, so the object reaches that side (its strip there can be as white as the paper).
    const covers = (mark, a0, a1) => {
      if (!mark) return false; let inside = 0, outside = 0;
      for (let p = 0; p < mark.length; p++) if (mark[p]) { if (p >= a0 && p <= a1) inside++; else outside++; }
      return outside >= 8 && inside <= (a1 - a0 + 1) * 0.05;
    };
    if (y0 > 0 && y0 <= 64 && covers(lineAt.r0, x0, x1)) y0 = 0;
    if (y1 < h - 1 && y1 >= h - 65 && covers(lineAt.r1, x0, x1)) y1 = h - 1;
    if (x0 > 0 && x0 <= 64 && covers(lineAt.c0, y0, y1)) x0 = 0;
    if (x1 < w - 1 && x1 >= w - 65 && covers(lineAt.c1, y0, y1)) x1 = w - 1;
    const isObject = i => pieceOf[i] >= 0 && pieces[pieceOf[i]].keep;
    // A band taken as an edge line that touches the object (a card's corner pressed against the
    // scanner's dark edge, or the card's own outline close to the edge) took a bit of the object
    // with it: in the rows where it touches, the object reaches as far as the band does.
    let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
    for (let i = 0; i < w * h; i++) {
      const bits = lineBits[i];
      if (!bits) continue;
      const x = i % w, y = (i / w) | 0;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= x0 && yy >= y0 && xx <= x1 && yy <= y1 && isObject(yy * w + xx)) { near = true; break; }
      }
      if (!near) continue;
      if (bits & 4) for (let k = 0; k < nx0; k++) if (lineBits[y * w + k] & 4) { nx0 = k; break; }
      if (bits & 8) for (let k = w - 1; k > nx1; k--) if (lineBits[y * w + k] & 8) { nx1 = k; break; }
      if (bits & 1) for (let k = 0; k < ny0; k++) if (lineBits[k * w + x] & 1) { ny0 = k; break; }
      if (bits & 2) for (let k = h - 1; k > ny1; k--) if (lineBits[k * w + x] & 2) { ny1 = k; break; }
    }
    // A peeled line beside the object for only a short stretch (at most 15% of the object's side,
    // e.g. a scanner edge that starts just at a card's corner) where they touch: there the corner
    // and the line can't be told apart, so keep both. A line along the object's whole side is
    // clearly separate from it and stays out.
    const touchAt = { 1: new Set(), 2: new Set(), 4: new Set(), 8: new Set() };
    for (let i = 0; i < w * h; i++) {
      const bits = peelBits[i];
      if (!bits) continue;
      const x = i % w, y = (i / w) | 0;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= x0 && yy >= y0 && xx <= x1 && yy <= y1 && isObject(yy * w + xx)) { near = true; break; }
      }
      if (near) for (const b of [1, 2, 4, 8]) if (bits & b) touchAt[b].add(b <= 2 ? x : y);
    }
    for (const b of [1, 2, 4, 8]) {
      const t = touchAt[b];
      if (!t.size) continue;
      // how far the line runs alongside the object (rows or columns of the object's side with line in them)
      let len = 0, side = 0;
      if (b >= 4) { for (let y = y0; y <= y1; y++) { side++; for (let k = 0; k < w; k++) if (peelBits[y * w + k] & b) { len++; break; } } }
      else { for (let x = x0; x <= x1; x++) { side++; for (let k = 0; k < h; k++) if (peelBits[k * w + x] & b) { len++; break; } } }
      if (len > side * 0.15) continue;
      for (const p of t) {
        if (b === 4) { for (let k = 0; k < nx0; k++) if (peelBits[p * w + k] & 4) { nx0 = k; break; } }
        else if (b === 8) { for (let k = w - 1; k > nx1; k--) if (peelBits[p * w + k] & 8) { nx1 = k; break; } }
        else if (b === 1) { for (let k = 0; k < ny0; k++) if (peelBits[k * w + p] & 1) { ny0 = k; break; } }
        else { for (let k = h - 1; k > ny1; k--) if (peelBits[k * w + p] & 2) { ny1 = k; break; } }
      }
    }
    x0 = nx0; y0 = ny0; x1 = nx1; y1 = ny1;
    return { w, h, mask, d, bg, tol, isObject, x0, y0, x1, y1 };
  }
  /** Straighten: levels a slightly crooked scan. Finds the object (as Shrink to content does) in
   *  the selection, or in the whole active layer, takes the tilt of the smallest rectangle around
   *  its outline, and rotates the layer to level it (up to 10°; scans are only a little crooked).
   *  The corners the rotation exposes are transparent. */
  function straighten() {
    const l = activeLayer();
    if (!l) { toast('Select a layer first'); return; }
    if (hiddenLayer(l)) return;
    const fitted = shrinkIsFresh(); // the selection came from Shrink to content: re-fit it afterwards
    let s = null;
    if (state.sel) { s = selToUse(); if (!s) return; }
    else {
      const r = rectIntersect(layerRect(l), { x: 0, y: 0, w: state.artboard.w, h: state.artboard.h });
      if (!r) { toast('The layer is outside the artboard'); return; }
      s = selFromRect(r);
    }
    const o = findObject(s);
    if (typeof o === 'string') { toast(o); return; }
    // the outline: each row's outermost object pixels (their corners), then the convex hull
    const pts = [];
    for (let y = o.y0; y <= o.y1; y++) {
      let a = -1, b = -1;
      for (let x = o.x0; x <= o.x1; x++) if (o.isObject(y * o.w + x)) { if (a < 0) a = x; b = x; }
      if (a >= 0) pts.push([a, y], [a, y + 1], [b + 1, y], [b + 1, y + 1]);
    }
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
    const lower = [], upper = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    for (let k = pts.length - 1; k >= 0; k--) { const p = pts[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    // the smallest rectangle around it has one side along a hull edge: try each edge's angle
    let best = Infinity, angle = 0;
    for (let k = 0; k < hull.length; k++) {
      const p = hull[k], q = hull[(k + 1) % hull.length], t = Math.atan2(q[1] - p[1], q[0] - p[0]);
      const c = Math.cos(t), sn = Math.sin(t); let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of hull) { const u = x * c + y * sn, v = -x * sn + y * c; if (u < a0) a0 = u; if (u > a1) a1 = u; if (v < b0) b0 = v; if (v > b1) b1 = v; }
      const area = (a1 - a0) * (b1 - b0);
      if (area < best - 1e-6) { best = area; angle = t; }
    }
    while (angle > Math.PI / 4) angle -= Math.PI / 2;
    while (angle <= -Math.PI / 4) angle += Math.PI / 2;
    const deg = angle * 180 / Math.PI;
    if (Math.abs(deg) < 0.05) { toast('Already straight'); return; }
    if (Math.abs(deg) > 10) { toast('Too crooked to straighten'); return; }
    // rotate the layer around the object's center so the object stays in place
    const cx = s.x + (o.x0 + o.x1 + 1) / 2, cy = s.y + (o.y0 + o.y1 + 1) / 2, a = -angle, cs = Math.cos(a), sn = Math.sin(a), c = l.canvas;
    const corners = [[l.x, l.y], [l.x + c.width, l.y], [l.x, l.y + c.height], [l.x + c.width, l.y + c.height]]
      .map(([x, y]) => [cx + (x - cx) * cs - (y - cy) * sn, cy + (x - cx) * sn + (y - cy) * cs]);
    const nx = Math.floor(Math.min(...corners.map(p => p[0]))), ny = Math.floor(Math.min(...corners.map(p => p[1])));
    const nw = Math.ceil(Math.max(...corners.map(p => p[0]))) - nx, nh = Math.ceil(Math.max(...corners.map(p => p[1]))) - ny;
    const out = makeCanvas(nw, nh), g = ctx2d(out);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.translate(cx - nx, cy - ny); g.rotate(a); g.drawImage(c, l.x - cx, l.y - cy);
    pushHistory();
    l.canvas = out; l.x = nx; l.y = ny; l.src = null;
    // A tilted object's bounding box is bigger than the object: re-fit a fitted selection so a
    // trim or crop afterwards doesn't keep a strip of paper
    if (fitted) {
      const m = Math.ceil(Math.max(s.w, s.h) * Math.abs(Math.sin(angle))) + 4;
      const loose = rectIntersect(expandRect(s, m), { x: 0, y: 0, w: state.artboard.w, h: state.artboard.h });
      const o2 = loose && findObject(selFromRect(loose));
      if (o2 && typeof o2 !== 'string') {
        state.sel = selFromRect({ x: loose.x + o2.x0, y: loose.y + o2.y0, w: o2.x1 - o2.x0 + 1, h: o2.y1 - o2.y0 + 1 });
        lastShrink = { sel: state.sel, canvases: state.layers.map(x => x.canvas) };
      }
    }
    changed();
    toast(`Straightened ${Math.abs(deg).toFixed(1)}°`);
  }

  /** Clear corners: makes the background in the object's four rounded corners transparent (a
   *  card). Works on the object found in the selection, or in the whole active layer, so the
   *  selection can be tight, loose or the whole artboard. Each corner's radius is measured from
   *  the object's outline (where the curve meets the straight sides), and only pixels outside that
   *  curve are cleared: never inside the object, however white it is there. A corner with no
   *  visible outline is left alone. Edge cleanup removes the light fringe. */
  function clearCorners() {
    const l = activeLayer();
    if (!l) { toast('Select a layer first'); return; }
    if (hiddenLayer(l)) return;
    let s = null;
    if (state.sel) { s = selToUse(); if (!s) return; }
    else {
      const r = rectIntersect(layerRect(l), { x: 0, y: 0, w: state.artboard.w, h: state.artboard.h });
      if (!r) { toast('The layer is outside the artboard'); return; }
      s = selFromRect(r);
    }
    // the whole layer, or a selection covering the whole artboard: cropped to the object already
    const cropped = !state.sel || (s.x <= 0 && s.y <= 0 && s.x + s.w >= state.artboard.w && s.y + s.h >= state.artboard.h);
    // Cropped to the object already: the area is mostly object, so its edge would read the object's
    // color as the background. The paper is in the area's corners (outside the rounded corners).
    let paper = null;
    if (cropped) {
      const pick = [];
      for (const [cx, cy] of [[0, 0], [s.w - 1, 0], [0, s.h - 1], [s.w - 1, s.h - 1]]) for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
        const x = cx === 0 ? a : cx - a, y = cy === 0 ? b : cy - b; pick.push([s.x + x, s.y + y]);
      }
      const cd = ctx2d(composite(s)).getImageData(0, 0, s.w, s.h).data, cols = [];
      for (const [x, y] of pick) { const o = ((y - s.y) * s.w + x - s.x) * 4; if (cd[o + 3] >= 128) cols.push([cd[o], cd[o + 1], cd[o + 2], 255]); }
      if (cols.length >= 12) { // the shade most of them are close to
        let best = null, bestN = -1;
        for (const c of cols) { const n = cols.filter(q => Math.max(Math.abs(q[0] - c[0]), Math.abs(q[1] - c[1]), Math.abs(q[2] - c[2])) <= 8).length; if (n > bestN) { bestN = n; best = c; } }
        if (bestN >= 8) paper = best;
      }
    }
    const o = findObject(s, { edgeLines: !cropped, paper });
    if (typeof o === 'string') { toast(o); return; }
    // a gap of a few pixels between the object and the edge of the area is outside the object:
    // let the corners reach the edge (after a trim, the last row can be a sliver of paper)
    const { w, d, bg, tol, isObject } = o, H = o.h, near = 4;
    const x0 = o.x0 <= near ? 0 : o.x0, y0 = o.y0 <= near ? 0 : o.y0, x1 = o.x1 >= w - 1 - near ? w - 1 : o.x1, y1 = o.y1 >= H - 1 - near ? H - 1 : o.y1, zone = Math.max(4, Math.round(Math.min(x1 - x0 + 1, y1 - y0 + 1) * 0.12));
    // judged by color: a half-transparent pixel (the soft edge Straighten leaves) that is paper-
    // colored is paper too
    const devRGB = i => Math.max(Math.abs(d[i * 4] - bg[0]), Math.abs(d[i * 4 + 1] - bg[1]), Math.abs(d[i * 4 + 2] - bg[2]));
    const clearable = i => s.mask[i] && d[i * 4 + 3] >= 16 && devRGB(i) <= tol && !isObject(i);
    const clear = new Uint8Array(d.length >> 2);
    let n = 0;
    // Cropped to the card: a side the object doesn't reach (more than a few px of plain paper or
    // card between them) has no outline at the edge, e.g. a card whose top ran off the scan. Its
    // corners have no visible curve, so they're left alone.
    const atEdge = { l: x0 === 0, t: y0 === 0, r: x1 === w - 1, b: y1 === H - 1 };
    const median = a => a.slice().sort((p, q) => p - q)[a.length >> 1];
    const corners = [[x0, y0, 'l', 't'], [x1, y0, 'r', 't'], [x0, y1, 'l', 'b'], [x1, y1, 'r', 'b']]
      .filter(([, , sx, sy]) => !cropped || (atEdge[sx] && atEdge[sy]))
      .map(([cx, cy]) => {
        const sx = cx === x0 ? 1 : -1, sy = cy === y0 ? 1 : -1;
        return { cx, cy, at: (a, b) => (cy + sy * b) * w + cx + sx * a };
      });
    if (!corners.length) { toast('Can’t find the corners'); return; }
    // The radius, measured at each corner three ways: how far from the corner the outline meets
    // each straight side, and how far in it is along the diagonal (0.29 r for a round corner).
    // A scan's outline is faint in places, so one corner can read wrong; a card's corners are all
    // the same, so the middle of all the readings is used for all four.
    const readings = [];
    for (const c of corners) {
      const { at } = c; c.rd = [];
      const firstIn = (alongRows, k) => { for (let t = 0; t < zone; t++) if (isObject(alongRows ? at(t, k) : at(k, t))) return t; return Infinity; };
      let rRow = -1, rCol = -1, alongRows = 0, alongCols = 0;
      for (let k = 0; k < zone; k++) {
        const inRow = firstIn(true, k) <= 1, inCol = firstIn(false, k) <= 1;
        if (rRow < 0 && inRow) rRow = k;
        if (rCol < 0 && inCol) rCol = k;
        alongRows += inRow; alongCols += inCol;
      }
      // A square corner where the card ran off the scan: the outline runs straight along one edge
      // all the way into the corner, and there's (almost) none along the other edge. (A rounded
      // corner of a tightly cropped card has its outline along both edges, apart from the curve.)
      c.straight = Math.max(alongRows, alongCols) >= zone * 0.9 && Math.min(alongRows, alongCols) <= zone * 0.2;
      let tDiag = -1; for (let t = 0; t < zone; t++) if (isObject(at(t, t))) { tDiag = t; break; }
      for (const v of [rRow, rCol, tDiag >= 0 ? Math.round(tDiag / 0.2929) : -1]) if (v >= 0 && v < zone) { readings.push(v); c.rd.push(v); }
    }
    if (!readings.length) { toast('Can’t find the corners'); return; }
    // A corner with no outline to measure, or a square one (the outline runs straight along the edge
    // into the corner, e.g. where the card ran off the scan), is left alone. Readings of 0 (a speck
    // or a bit of scanner edge right in the corner) don't count toward the radius, but that corner
    // is still cleared.
    const round = corners.filter(c => c.rd.length && !(c.straight && median(c.rd) < 2));
    const rr = round.flatMap(c => c.rd).filter(v => v >= 2);
    const r = rr.length ? median(rr) : 0;
    if (r < 2) { toast('No background in the corners'); return; } // square corners
    for (const { at } of round) {
      // clear paper outside the curve, inside the r × r corner square
      for (let b = 0; b < r; b++) for (let a = 0; a < r; a++) {
        if (Math.hypot(r - a - 0.5, r - b - 0.5) <= r - 0.5) continue; // inside the curve
        const i = at(a, b); if (!clear[i] && clearable(i)) { clear[i] = 1; n++; }
      }
      // the radius is an estimate: paper touching what was cleared, up to 4 px inside the curve,
      // goes too (it stops at the outline, and 4 px can't reach into the object)
      const R = r + 4;
      for (let grew = true, pass = 0; grew && pass < 6; pass++) {
        grew = false;
        for (let b = 0; b < R; b++) for (let a = 0; a < R; a++) {
          const dist = Math.hypot(r - a - 0.5, r - b - 0.5);
          if ((a < r && b < r && dist > r - 0.5) || dist < r - 4.5) continue; // done already, or too deep
          const i = at(a, b);
          if (clear[i] || !clearable(i)) continue;
          if ((a > 0 && clear[at(a - 1, b)]) || clear[at(a + 1, b)] || (b > 0 && clear[at(a, b - 1)]) || clear[at(a, b + 1)]) { clear[i] = 1; n++; grew = true; }
        }
      }
    }
    if (!n) { toast('No background in the corners'); return; }
    const h = o.h;
    const cs = selNormalize({ x: s.x, y: s.y, w, h, mask: clear, matte: { color: bg.slice(0, 3).map(Math.round), inside: true } });
    if (!cs || !rectIntersect(layerRect(l), cs)) { toast('No background in the corners'); return; }
    pushHistory();
    if (clearInLayer(l, cs) === 'empty') removeLayer(l.id);
    changed();
  }

  /** The last Shrink to content result, so running it again on it just says it fits (an object
   *  pressed against the scan's edge would otherwise lose a row to the edge peeling each time). */
  let lastShrink = null;
  const shrinkIsFresh = () => lastShrink && state.sel === lastShrink.sel && state.layers.length === lastShrink.canvases.length && state.layers.every((l, k) => l.canvas === lastShrink.canvases[k]);

  function setArtboardRect(r) {
    // Moves content so the new artboard starts at 0,0 — keeps everything visually in place.
    pushHistory();
    for (const l of state.layers) { l.x -= r.x; l.y -= r.y; }
    if (state.sel) state.sel = { ...state.sel, x: state.sel.x - r.x, y: state.sel.y - r.y };
    state.artboard.w = r.w;
    state.artboard.h = r.h;
    userView(); // the content stays in place on screen, so the view is no longer the fit
    view.ox += r.x * view.s;
    view.oy += r.y * view.s;
    changed();
  }
  /**
   * Shrinks the artboard to the visible pixels inside it (never grows it — that's Fit),
   * and clips every layer to the artboard so nothing is left hanging outside.
   */
  function trimArtboard() {
    const A = state.artboard, b = opaqueBounds(composite({ x: 0, y: 0, w: A.w, h: A.h }));
    if (!b) { toast('Nothing to trim'); return; }
    const overhangs = state.layers.some(l => {
      const r = layerRect(l);
      return r.x < b.x || r.y < b.y || r.x + r.w > b.x + b.w || r.y + r.h > b.y + b.h;
    });
    if (b.w === A.w && b.h === A.h && !overhangs) { toast('Already trimmed'); return; }
    setArtboardRect(b); // one undo step — the clipping below joins it
    clipLayersToArtboard();
    changed();
    fitView(true); // the trimmed artboard, centered (as when an image is opened)
    toast(`Trimmed to ${b.w} × ${b.h}`);
  }
  /** Cuts off what hangs outside the artboard (part of the undo step the caller started). */
  function clipLayersToArtboard() {
    const ab = { x: 0, y: 0, w: state.artboard.w, h: state.artboard.h };
    for (const l of [...state.layers]) {
      const r = rectIntersect(layerRect(l), ab);
      if (!r) { removeLayer(l.id); continue; } // entirely off the artboard
      if (r.w === l.canvas.width && r.h === l.canvas.height) continue;
      const c = makeCanvas(r.w, r.h);
      ctx2d(c).drawImage(l.canvas, l.x - r.x, l.y - r.y);
      const t = trimmed(c);
      if (!t) { removeLayer(l.id); continue; }
      l.canvas = t.canvas;
      l.x = r.x + t.dx;
      l.y = r.y + t.dy;
      l.src = null; // pixel edit: bakes in the current scale
    }
  }
  function fitArtboard() {
    const u = state.layers.filter(l => l.visible).reduce((a, l) => rectUnion(a, layerRect(l)), null);
    if (!u) { toast('No layers to fit'); return; }
    if (u.x === 0 && u.y === 0 && u.w === state.artboard.w && u.h === state.artboard.h) { toast('Already fits'); return; }
    setArtboardRect(u);
    toast(`Fit to ${u.w} × ${u.h}`);
  }
  /** Trim to selection: the artboard becomes the selection's bounds and everything outside is
   *  cut off, like Trim. Pixels kept outside the artboard would come back on copy, drag-out or
   *  moving a layer, so there's no crop that keeps them. The view re-fits the new artboard. */
  function trimToSelection() {
    const sel = selToUse();
    if (!sel) return;
    setArtboardRect({ x: sel.x, y: sel.y, w: sel.w, h: sel.h }); // one undo step, the clipping joins it
    clipLayersToArtboard();
    state.sel = null;
    changed();
    fitView(true);
    toast(`Trimmed to ${sel.w} × ${sel.h}`);
  }

  /** New (Ctrl+N only: a shortcut for select all + delete, not a menu command; the Cutout menu is
   *  for settings). An empty document, as at launch. One undo step, so nothing is lost by it. */
  function newDocument() {
    const A = state.artboard;
    if (!state.layers.length && A.w === 800 && A.h === 600 && !A.bg) return;
    pushHistory();
    state.layers = [];
    state.selected.clear();
    state.active = null;
    state.sel = null;
    artboardSel = false;
    state.artboard = { w: 800, h: 600, bg: null };
    docName = 'cutout'; saveTarget = null;
    setTool('pointer');
    changed();
    fitView(true);
    toast('New document');
  }

  function arrange(dir) {
    if (!state.selected.size) return;
    pushHistory();
    const sel = state.layers.filter(l => state.selected.has(l.id));
    const rest = state.layers.filter(l => !state.selected.has(l.id));
    if (dir === 'top') state.layers = [...rest, ...sel];
    else if (dir === 'bottom') state.layers = [...sel, ...rest];
    else {
      const L = state.layers;
      if (dir === 'up') {
        for (let i = L.length - 2; i >= 0; i--) if (state.selected.has(L[i].id) && !state.selected.has(L[i + 1].id)) [L[i], L[i + 1]] = [L[i + 1], L[i]];
      } else {
        for (let i = 1; i < L.length; i++) if (state.selected.has(L[i].id) && !state.selected.has(L[i - 1].id)) [L[i], L[i - 1]] = [L[i - 1], L[i]];
      }
    }
    changed();
  }

  const lastNudge = { key: '', t: 0 };
  function nudge(dx, dy) {
    if (state.sel && (state.tool === 'marquee' || state.tool === 'wand' || !state.selected.size)) {
      state.sel = { ...state.sel, x: state.sel.x + dx, y: state.sel.y + dy };
      changed();
      return;
    }
    if (!state.selected.size) return;
    const key = [...state.selected].join(',');
    const now = performance.now();
    if (key !== lastNudge.key || now - lastNudge.t > 1200) pushHistory(); // group rapid nudges into one undo step
    lastNudge.key = key;
    lastNudge.t = now;
    for (const l of state.layers) if (state.selected.has(l.id)) { l.x += dx; l.y += dy; }
    changed();
  }

  /* ======================================================================
   * Dialogs
   * ==================================================================== */
  const anchor = { x: 0.5, y: 0.5 };
  function openCanvasDialog() {
    const dlg = $('#dlgCanvas'), A = state.artboard;
    $('#cw').value = A.w;
    $('#ch').value = A.h;
    $('#cbgTransparent').checked = !A.bg;
    $('#cbg').value = A.bg || '#ffffff';
    $('#cbg').disabled = !A.bg;
    anchor.x = 0.5; anchor.y = 0.5;
    renderAnchor();
    dlg.returnValue = '';
    dlg.showModal();
    $('#cw').select();
  }
  function renderAnchor() {
    const box = $('#anchor');
    box.innerHTML = '';
    for (const ay of [0, 0.5, 1]) {
      for (const ax of [0, 0.5, 1]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = ax === anchor.x && ay === anchor.y ? 'on' : '';
        b.setAttribute('aria-label', `${['Top', 'Middle', 'Bottom'][ay * 2]} ${['left', 'center', 'right'][ax * 2]}`.replace('Middle center', 'Center'));
        b.setAttribute('aria-pressed', String(ax === anchor.x && ay === anchor.y));
        b.onclick = () => { anchor.x = ax; anchor.y = ay; renderAnchor(); };
        box.appendChild(b);
      }
    }
  }
  $('#cbgTransparent').addEventListener('change', e => { $('#cbg').disabled = e.target.checked; });
  $('#dlgCanvas').addEventListener('close', () => {
    if ($('#dlgCanvas').returnValue !== 'ok') return;
    const A = state.artboard;
    const w = clamp(parseInt($('#cw').value, 10) || A.w, 1, 16000);
    const h = clamp(parseInt($('#ch').value, 10) || A.h, 1, 16000);
    const bg = $('#cbgTransparent').checked ? null : $('#cbg').value;
    const x = Math.round((A.w - w) * anchor.x), y = Math.round((A.h - h) * anchor.y);
    if (w === A.w && h === A.h && bg === A.bg) return;
    if (w === A.w && h === A.h) pushHistory(); // only the background changed: the view stays as it is
    else setArtboardRect({ x, y, w, h });
    state.artboard.bg = bg;
    changed();
  });

  function openSaveDialog() {
    if (!state.layers.length && !state.artboard.bg) { toast('Nothing to save yet'); return; }
    const dlg = $('#dlgExport');
    $('#fname').value = saveTarget ? saveTarget.name.replace(/\.(png|jpe?g)$/i, '') : docName;
    const fmt = saveTarget && saveTarget.mime === 'image/jpeg' ? 'jpeg' : 'png';
    $(`input[name="fmt"][value="${fmt}"]`).checked = true;
    $('#jq').value = state.opts.jpegQ;
    $('#jqv').textContent = state.opts.jpegQ;
    updateExportDialog();
    dlg.returnValue = '';
    dlg.showModal();
  }
  function exportFormat() { return $('input[name="fmt"]:checked').value; }
  function updateExportDialog() {
    const fmt = exportFormat(), A = state.artboard;
    $('#qualityRow').style.display = fmt === 'jpeg' ? '' : 'none';
    $('#exportNote').textContent = `Artboard, ${A.w} × ${A.h}.` +
      (fmt === 'jpeg' ? ` Transparent areas become ${A.bg ? 'the background color' : 'white'}.` : '');
  }
  $$('input[name="fmt"]').forEach(r => r.addEventListener('change', updateExportDialog));
  $('#jq').addEventListener('input', e => { $('#jqv').textContent = e.target.value; });
  // Runs on the Save button's submit (inside the click), so the system save dialog may open.
  $('#dlgExport form').addEventListener('submit', e => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    const fmt = exportFormat(), q = parseInt($('#jq').value, 10);
    state.opts.jpegQ = q;
    savePrefs();
    const name = ($('#fname').value || docName).trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.(png|jpe?g)$/i, '');
    Platform.saveAs(artboardBlob, `${name}.${fmt === 'png' ? 'png' : 'jpg'}`).then(res => {
      if (!res) return;
      saveTarget = res; // Ctrl+S now re-saves here
      dirty = false;
      toast(`Saved ${res.name}`);
    }, () => toast('Save failed'));
  });

  /* ---------- Save (Ctrl+S) / Save as (Ctrl+Shift+S) */
  let docName = 'cutout';
  let saveTarget = null; // { handle, name, mime } after the first save
  function canvasBlob(canvas, mime, bg) {
    if (mime === 'image/jpeg' || bg) {
      const c = makeCanvas(canvas.width, canvas.height), g = ctx2d(c);
      g.fillStyle = bg || '#ffffff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(canvas, 0, 0);
      canvas = c;
    }
    return canvasToBlob(canvas, mime, mime === 'image/jpeg' ? state.opts.jpegQ / 100 : undefined);
  }
  function artboardBlob(mime) {
    const A = state.artboard;
    return canvasBlob(composite({ x: 0, y: 0, w: A.w, h: A.h }), mime, A.bg);
  }
  async function save(asNew) {
    if (!state.layers.length && !state.artboard.bg) { toast('Nothing to save yet'); return; }
    try {
      if (!asNew && saveTarget && saveTarget.handle) {
        // Already saved once: write straight to the same file, no prompts.
        await Platform.write(saveTarget.handle, await artboardBlob(saveTarget.mime));
        dirty = false;
        toast(`Saved ${saveTarget.name}`);
        return;
      }
      openSaveDialog(); // first save, or Save As: choose format + quality, then location
    } catch (_) {
      toast('Save failed');
    }
  }
  /** Saves an arbitrary piece (a selection or a layer) without changing the document's save target. */
  async function saveCanvasAs(canvas, name) {
    try {
      const res = await Platform.saveAs(mime => canvasBlob(canvas, mime), `${name}.png`);
      if (res) toast(`Saved ${res.name}`);
    } catch (_) {
      toast('Save failed');
    }
  }

  /* ======================================================================
   * View
   * ==================================================================== */
  const stage = $('#stage'), vc = $('#view'), vg = vc.getContext('2d');
  const ZOOMS = [0.03, 0.05, 0.1, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
  let lastMouse = null; // device px, inside canvas

  /* While the view is still the automatic fit (an image just opened, Ctrl+0), it re-fits when the
   * window changes size, e.g. a window that opens with a file and then settles. Zooming or panning
   * ends that: from then on the view stays where the user put it. */
  let viewFit = null; // { capAt100 } while the view is the automatic fit
  const userView = () => { viewFit = null; };
  function fitView(capAt100) {
    viewFit = { capAt100 };
    const A = state.artboard, pad = 48 * dpr;
    let s = Math.min((vc.width - pad * 2) / A.w, (vc.height - pad * 2) / A.h);
    if (capAt100) s = Math.min(s, dpr);
    view.s = clamp(s, 0.02 * dpr, 64 * dpr);
    view.ox = Math.round((vc.width - A.w * view.s) / 2);
    view.oy = Math.round((vc.height - A.h * view.s) / 2);
    requestRender();
  }
  function zoomAt(s, px, py) {
    userView();
    s = clamp(s, 0.02 * dpr, 64 * dpr);
    const dx = (px - view.ox) / view.s, dy = (py - view.oy) / view.s;
    view.s = s;
    view.ox = px - dx * s;
    view.oy = py - dy * s;
    requestRender();
  }
  function zoomStep(dir) {
    const cur = view.s / dpr;
    const next = dir > 0 ? ZOOMS.find(z => z > cur * 1.001) || 64 : [...ZOOMS].reverse().find(z => z < cur / 1.001) || 0.03;
    const p = lastMouse || { x: vc.width / 2, y: vc.height / 2 };
    zoomAt(next * dpr, p.x, p.y);
  }
  function zoom100() {
    const p = lastMouse || { x: vc.width / 2, y: vc.height / 2 };
    zoomAt(dpr, p.x, p.y);
  }
  function viewCenterDoc() { return toDoc({ x: vc.width / 2, y: vc.height / 2 }); }
  function screenPt(e) {
    const r = vc.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  }
  function toDoc(p) { return { x: (p.x - Math.round(view.ox)) / view.s, y: (p.y - Math.round(view.oy)) / view.s }; }

  let colors = {};
  let checker = null;
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    colors = { stage: v('--stage'), dim: v('--stage-dim'), edge: v('--artboard-edge'), accent: v('--accent'), grid: v('--grid'), ca: v('--checker-a'), cb: v('--checker-b'), muted: v('--muted') };
    const sz = Math.round(8 * dpr), p = makeCanvas(sz * 2, sz * 2), g = p.getContext('2d');
    g.fillStyle = colors.ca; g.fillRect(0, 0, sz * 2, sz * 2);
    g.fillStyle = colors.cb; g.fillRect(sz, 0, sz, sz); g.fillRect(0, sz, sz, sz);
    checker = vg.createPattern(p, 'repeat');
    thumbCache = new WeakMap();
  }

  let selPath = null, selPathFor = null;
  function getSelPath() {
    const s = state.sel;
    if (s === selPathFor) return selPath;
    const p = new Path2D(), { x, y, w, h, mask } = s;
    // horizontal edges
    for (let yy = 0; yy <= h; yy++) {
      let run = -1;
      for (let xx = 0; xx <= w; xx++) {
        let edge = false;
        if (xx < w) {
          const a = yy > 0 ? mask[(yy - 1) * w + xx] : 0, b = yy < h ? mask[yy * w + xx] : 0;
          edge = a !== b;
        }
        if (edge && run < 0) run = xx;
        else if (!edge && run >= 0) { p.moveTo(x + run, y + yy); p.lineTo(x + xx, y + yy); run = -1; }
      }
    }
    // vertical edges
    for (let xx = 0; xx <= w; xx++) {
      let run = -1;
      for (let yy = 0; yy <= h; yy++) {
        let edge = false;
        if (yy < h) {
          const a = xx > 0 ? mask[yy * w + xx - 1] : 0, b = xx < w ? mask[yy * w + xx] : 0;
          edge = a !== b;
        }
        if (edge && run < 0) run = yy;
        else if (!edge && run >= 0) { p.moveTo(x + xx, y + run); p.lineTo(x + xx, y + yy); run = -1; }
      }
    }
    selPath = p;
    selPathFor = s;
    return p;
  }

  let renderQueued = false, ants = 0, hoverId = null, labelRect = null;

  /* ---------- artboard handles */
  function artboardScreenRect() {
    const s = view.s, ox = Math.round(view.ox), oy = Math.round(view.oy), A = state.artboard;
    return { x: ox, y: oy, w: Math.round(ox + A.w * s) - ox, h: Math.round(oy + A.h * s) - oy };
  }
  function handlePoints(x, y, w, h) {
    return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
  }
  /** Which artboard edge/corner is under the screen point: 'n','ne','e',… or null. */
  function handleAt(p) {
    const r = artboardScreenRect(), tol = 6 * dpr;
    const inX = p.x > r.x - tol && p.x < r.x + r.w + tol, inY = p.y > r.y - tol && p.y < r.y + r.h + tol;
    if (!inX || !inY) return null;
    let v = '', h = '';
    if (Math.abs(p.y - r.y) <= tol) v = 'n'; else if (Math.abs(p.y - (r.y + r.h)) <= tol) v = 's';
    if (Math.abs(p.x - r.x) <= tol) h = 'w'; else if (Math.abs(p.x - (r.x + r.w)) <= tol) h = 'e';
    return v + h || null;
  }
  /* ---------- layer scale handles */
  const dispRect = l => ({ x: l.x, y: l.y, w: l.dw || l.canvas.width, h: l.dh || l.canvas.height });
  /** The one selected, visible layer that shows scale handles (pointer tool only). */
  function scalableLayer() {
    if (state.tool !== 'pointer' || state.selected.size !== 1) return null;
    const l = getLayer([...state.selected][0]);
    return l && l.visible ? l : null;
  }
  function layerScreenRect(l) {
    const s = view.s, ox = Math.round(view.ox), oy = Math.round(view.oy), r = dispRect(l);
    const x = Math.round(ox + r.x * s), y = Math.round(oy + r.y * s);
    return { x, y, w: Math.round(ox + (r.x + r.w) * s) - x, h: Math.round(oy + (r.y + r.h) * s) - y };
  }
  /** Which layer handle is under the screen point — corners win over sides. */
  function layerHandleAt(p, l) {
    const r = layerScreenRect(l), tol = 6 * dpr;
    const names = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'], pts = handlePoints(r.x, r.y, r.w, r.h);
    const order = [0, 2, 4, 6, 1, 3, 5, 7];
    for (const i of order) {
      if (Math.abs(p.x - pts[i][0]) <= tol && Math.abs(p.y - pts[i][1]) <= tol) return names[i];
    }
    return null;
  }

  const HANDLE_CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  const inLabel = p => labelRect && containsPt(labelRect, p.x, p.y);
  const inArtboard = d => d.x >= 0 && d.y >= 0 && d.x < state.artboard.w && d.y < state.artboard.h;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }
  function render() {
    renderQueued = false;
    const g = vg, W = vc.width, H = vc.height, s = view.s;
    const ox = Math.round(view.ox), oy = Math.round(view.oy), A = state.artboard;
    const X = x => Math.round(ox + x * s), Y = y => Math.round(oy + y * s);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.setLineDash([]);
    g.fillStyle = colors.stage;
    g.fillRect(0, 0, W, H);

    const ax = X(0), ay = Y(0), aw = X(A.w) - ax, ah = Y(A.h) - ay;
    if (A.bg) g.fillStyle = A.bg;
    else { checker.setTransform(new DOMMatrix().translate(ax, ay)); g.fillStyle = checker; }
    g.fillRect(ax, ay, aw, ah);

    g.imageSmoothingEnabled = s < 1;
    g.imageSmoothingQuality = 'high';
    for (const l of state.layers) {
      if (!l.visible) continue;
      const x = X(l.x), y = Y(l.y), r = dispRect(l);
      if (l.dw) { // live scale preview: draw the original pixels smoothly at the new size
        g.save();
        g.imageSmoothingEnabled = true;
        g.drawImage(l.src || l.canvas, x, y, X(l.x + r.w) - x, Y(l.y + r.h) - y);
        g.restore();
      } else {
        // Exact (unrounded) position and size, so every layer samples the same pixel grid: rounding
        // each layer's edges on its own left a 1 px seam between a cut-out hole and the piece put
        // back in it at zooms like 150%. drawImage doesn't soften the edges of a fractional rect.
        g.drawImage(l.canvas, ox + l.x * s, oy + l.y * s, r.w * s, r.h * s);
      }
    }

    // Dim everything outside the artboard (still visible, clearly "off canvas").
    g.fillStyle = colors.dim;
    g.beginPath();
    g.rect(0, 0, W, H);
    g.rect(ax, ay, aw, ah);
    g.fill('evenodd');
    g.strokeStyle = colors.edge;
    g.lineWidth = 1;
    g.strokeRect(ax - 0.5, ay - 0.5, aw + 1, ah + 1);

    // Pixel grid when zoomed in far enough.
    if (s / dpr >= 8) {
      const x0 = Math.floor(-ox / s), x1 = Math.ceil((W - ox) / s), y0 = Math.floor(-oy / s), y1 = Math.ceil((H - oy) / s);
      g.beginPath();
      for (let x = x0; x <= x1; x++) { const px = X(x) + 0.5; g.moveTo(px, 0); g.lineTo(px, H); }
      for (let y = y0; y <= y1; y++) { const py = Y(y) + 0.5; g.moveTo(0, py); g.lineTo(W, py); }
      g.strokeStyle = colors.grid;
      g.lineWidth = 1;
      g.stroke();
    }

    // Smart guides (while dragging a layer that snapped to something).
    if (guides.length && drag) {
      g.strokeStyle = GUIDE_COLOR;
      g.lineWidth = Math.max(1, Math.round(dpr));
      g.beginPath();
      for (const gd of guides) {
        if (gd.type === 'gap') continue;
        if (gd.axis === 'x') { const gx = X(gd.v) + 0.5; g.moveTo(gx, Y(gd.a)); g.lineTo(gx, Y(gd.b)); }
        else { const gy = Y(gd.v) + 0.5; g.moveTo(X(gd.a), gy); g.lineTo(X(gd.b), gy); }
      }
      g.stroke();
      // Equal-spacing markers: measure line with end ticks + the gap in px.
      const tick = Math.round(4 * dpr);
      g.font = `600 ${Math.round(10 * dpr)}px "Segoe UI", system-ui, sans-serif`;
      g.textBaseline = 'middle';
      for (const gd of guides) {
        if (gd.type !== 'gap') continue;
        g.strokeStyle = GAP_COLOR;
        g.beginPath();
        let mx, my;
        if (gd.axis === 'x') {
          const y0 = Y(gd.at) + 0.5, x0 = X(gd.a), x1 = X(gd.b);
          g.moveTo(x0, y0); g.lineTo(x1, y0);
          g.moveTo(x0 + 0.5, y0 - tick); g.lineTo(x0 + 0.5, y0 + tick);
          g.moveTo(x1 - 0.5, y0 - tick); g.lineTo(x1 - 0.5, y0 + tick);
          mx = (x0 + x1) / 2; my = y0 + tick + 9 * dpr;
        } else {
          const x0 = X(gd.at) + 0.5, y0 = Y(gd.a), y1 = Y(gd.b);
          g.moveTo(x0, y0); g.lineTo(x0, y1);
          g.moveTo(x0 - tick, y0 + 0.5); g.lineTo(x0 + tick, y0 + 0.5);
          g.moveTo(x0 - tick, y1 - 0.5); g.lineTo(x0 + tick, y1 - 0.5);
          mx = x0 + tick + 14 * dpr; my = (y0 + y1) / 2;
        }
        g.stroke();
        const text = String(gd.label), tw = g.measureText(text).width, ph = Math.round(15 * dpr), pw = tw + 8 * dpr;
        g.fillStyle = GAP_COLOR;
        g.beginPath(); g.roundRect(Math.round(mx - pw / 2), Math.round(my - ph / 2), pw, ph, 3 * dpr); g.fill();
        g.fillStyle = '#fff';
        g.fillText(text, Math.round(mx - tw / 2), Math.round(my) + 0.5);
      }
    }

    // Layer outlines.
    const lw = Math.max(1, Math.round(dpr));
    const outline = (l, width) => {
      const r = dispRect(l), x = X(l.x), y = Y(l.y), w = X(l.x + r.w) - x, h = Y(l.y + r.h) - y;
      g.lineWidth = width;
      g.strokeRect(x - width / 2, y - width / 2, w + width, h + width);
    };
    g.strokeStyle = colors.accent;
    if (state.tool === 'pointer' && hoverId != null && !state.selected.has(hoverId) && !drag) {
      const h = getLayer(hoverId);
      if (h && h.visible) outline(h, lw);
    }
    for (const id of state.selected) {
      const l = getLayer(id);
      if (l && l.visible) outline(l, lw * (id === state.active ? 2 : 1));
    }

    // Spacing handles: a pink pill in each gap of a selected row/column.
    if (!drag || drag.kind === 'gapDrag') {
      for (const h of gapHandles()) {
        g.fillStyle = GAP_COLOR;
        g.strokeStyle = '#fff';
        g.lineWidth = Math.max(1, dpr);
        g.beginPath();
        g.roundRect(Math.round(h.x), Math.round(h.y), h.w, h.h, Math.min(h.w, h.h) / 2);
        g.fill();
        g.stroke();
      }
    }

    // Scale handles on a single selected layer, plus a size readout while scaling.
    const sl = scalableLayer();
    if (sl && (!drag || drag.kind === 'scale')) {
      const r = layerScreenRect(sl), hs = Math.round(7 * dpr);
      g.strokeStyle = colors.accent;
      g.lineWidth = lw;
      for (const [hx, hy] of handlePoints(r.x, r.y, r.w, r.h)) {
        g.fillStyle = '#fff';
        g.fillRect(Math.round(hx - hs / 2), Math.round(hy - hs / 2), hs, hs);
        g.strokeRect(Math.round(hx - hs / 2) + 0.5, Math.round(hy - hs / 2) + 0.5, hs - 1, hs - 1);
      }
      if (drag && drag.kind === 'scale' && drag.moved) {
        const d = dispRect(sl), base = sl.src || sl.canvas;
        const pct = Math.round((d.w / base.width) * 100), pctH = Math.round((d.h / base.height) * 100);
        const text = `${d.w} × ${d.h}  ·  ${pct === pctH ? pct + '%' : pct + '% × ' + pctH + '%'}`;
        g.font = `600 ${Math.round(11 * dpr)}px "Segoe UI", system-ui, sans-serif`;
        g.textBaseline = 'middle';
        const tw = g.measureText(text).width, bw = tw + 14 * dpr, bh = 20 * dpr;
        const bx = Math.round(r.x + r.w / 2 - bw / 2), by = Math.round(r.y + r.h + 10 * dpr);
        g.fillStyle = colors.accent;
        g.fillRect(bx, by, bw, bh);
        g.fillStyle = '#fff';
        g.fillText(text, bx + 7 * dpr, by + bh / 2);
      }
    }

    // Artboard label (click it to select the artboard) + selection handles.
    const abSelected = artboardSel && state.tool === 'pointer';
    g.font = `${Math.round(11 * dpr)}px "Segoe UI", system-ui, sans-serif`;
    g.textBaseline = 'bottom';
    const label = `Artboard  ${A.w} × ${A.h}`, tw = g.measureText(label).width;
    labelRect = { x: ax, y: ay - Math.round(20 * dpr), w: tw, h: Math.round(18 * dpr) };
    g.fillStyle = abSelected ? colors.accent : colors.muted;
    g.fillText(label, ax, ay - Math.round(5 * dpr));
    if (abSelected) {
      g.strokeStyle = colors.accent;
      g.lineWidth = lw;
      g.strokeRect(ax - lw / 2, ay - lw / 2, aw + lw, ah + lw);
      const hs = Math.round(7 * dpr);
      for (const [hx, hy] of handlePoints(ax, ay, aw, ah)) {
        g.fillStyle = '#fff';
        g.fillRect(Math.round(hx - hs / 2), Math.round(hy - hs / 2), hs, hs);
        g.strokeRect(Math.round(hx - hs / 2) + 0.5, Math.round(hy - hs / 2) + 0.5, hs - 1, hs - 1);
      }
    }

    // Drag previews.
    if (drag && (drag.kind === 'marquee' || drag.kind === 'rubber')) {
      const r = drag.kind === 'marquee' ? marqueeRect(drag) : dragRect(drag);
      const x = X(r.x), y = Y(r.y), w = X(r.x + r.w) - x, h = Y(r.y + r.h) - y;
      if (drag.kind === 'rubber') {
        g.fillStyle = 'rgba(13,153,255,0.08)';
        g.fillRect(x, y, w, h);
        g.strokeStyle = colors.accent;
        g.lineWidth = lw;
        g.strokeRect(x + 0.5, y + 0.5, w, h);
      } else {
        g.lineWidth = lw;
        g.strokeStyle = '#fff';
        g.strokeRect(x + 0.5, y + 0.5, w, h);
        g.setLineDash([4 * dpr, 4 * dpr]);
        g.strokeStyle = '#000';
        g.strokeRect(x + 0.5, y + 0.5, w, h);
        g.setLineDash([]);
      }
    }

    // Eraser brush outline (white + dark ring so it shows on any color).
    if (state.tool === 'eraser' && lastMouse && !spaceDown) {
      const r = Math.max(1.5 * dpr, (state.opts.eraserSize / 2) * s);
      g.lineWidth = Math.max(1, dpr);
      g.beginPath(); g.arc(lastMouse.x, lastMouse.y, r, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.stroke();
      g.beginPath(); g.arc(lastMouse.x, lastMouse.y, r + g.lineWidth, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke();
    }

    // Wand tolerance drag readout.
    if (drag && drag.kind === 'wandDrag' && drag.moved) {
      const r = drag.dist * dpr;
      g.lineWidth = lw;
      g.strokeStyle = colors.accent;
      g.fillStyle = 'rgba(13,153,255,0.06)';
      g.beginPath();
      g.arc(drag.sp.x, drag.sp.y, r, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      const text = `Tolerance ${state.opts.wandTol}`;
      g.font = `600 ${Math.round(11 * dpr)}px "Segoe UI", system-ui, sans-serif`;
      g.textBaseline = 'middle';
      const tw = g.measureText(text).width, bx = drag.sp.x + 12 * dpr, by = drag.sp.y - 22 * dpr;
      g.fillStyle = colors.accent;
      g.fillRect(bx, by - 9 * dpr, tw + 12 * dpr, 18 * dpr);
      g.fillStyle = '#fff';
      g.fillText(text, bx + 6 * dpr, by);
    }

    // Marching ants.
    if (state.sel) {
      const p = getSelPath();
      g.setTransform(s, 0, 0, s, ox, oy);
      g.lineWidth = lw / s;
      g.strokeStyle = '#fff';
      g.stroke(p);
      g.setLineDash([4 * dpr / s, 4 * dpr / s]);
      g.lineDashOffset = -ants * dpr / s;
      g.strokeStyle = '#000';
      g.stroke(p);
      g.setLineDash([]);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    const zl = $('#zoomLabel'), zt = `${Math.round((s / dpr) * 100)}%`;
    if (zl.textContent !== zt) { zl.textContent = zt; zl.setAttribute('aria-label', `Zoom ${zt}. Set to 100%`); }
  }
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  // (with reduced motion the ants stand still; the dashed outline still shows the selection)
  setInterval(() => { if (state.sel && !reduceMotion.matches) { ants = (ants + 1) % 8; requestRender(); } }, 90);

  /* ======================================================================
   * Pointer input
   * ==================================================================== */
  let drag = null, spaceDown = false;
  /** The undo step the current drag made (if any), so Esc can take the whole drag back. */
  let dragStep = null;
  function dragHistory() { pushHistory(); dragStep = undoStack[undoStack.length - 1]; }
  /** Esc mid-drag: everything goes back to how it was when the mouse went down. */
  function cancelDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    if (dragStep && undoStack[undoStack.length - 1] === dragStep) { undoStack.pop(); restore(dragStep); }
    if (d.kind === 'abResize') { view.ox = d.orig.ox; view.oy = d.orig.oy; }
    if (d.kind === 'rubber') { state.selected = new Set(d.base); state.active = [...d.base].pop() ?? null; }
    dragStep = null;
    guides = [];
    updateCursor();
    changed();
  }

  /* ---------- smart guides (snapping while moving / resizing layers; hold Ctrl to turn off) */
  const SNAP_PX = 6;            // snap distance, in screen pixels
  const GUIDE_COLOR = '#F24822'; // Figma-style red
  let guides = [];              // [{ axis: 'x'|'y', v, a, b }] lines to draw while dragging
  /** Edges + centers of the artboard and every visible layer not being dragged. */
  function snapTargets(exclude) {
    const xs = [], ys = [], A = state.artboard;
    const add = r => {
      xs.push({ v: r.x, r }, { v: r.x + r.w / 2, r }, { v: r.x + r.w, r });
      ys.push({ v: r.y, r }, { v: r.y + r.h / 2, r }, { v: r.y + r.h, r });
    };
    add({ x: 0, y: 0, w: A.w, h: A.h });
    for (const l of state.layers) if (l.visible && !exclude.has(l.id)) add(layerRect(l));
    return { xs, ys };
  }
  /** Closest target to any of the moving values, within thr. → { delta, v, r } or null */
  function bestSnap(vals, targets, thr) {
    let best = null;
    for (const m of vals) {
      for (const t of targets) {
        const dd = t.v - m;
        if (Math.abs(dd) <= thr && (!best || Math.abs(dd) < Math.abs(best.delta))) best = { delta: dd, v: t.v, r: t.r };
      }
    }
    return best;
  }
  /* ---------- equal-spacing snapping (Figma's pink distance markers)
   * axis 'x' = spacing along a row (horizontal gaps), 'y' = along a column (vertical gaps). */
  const GAP_COLOR = '#E8449B';
  const AX = { x: { p: 'x', s: 'w', cp: 'y', cs: 'h' }, y: { p: 'y', s: 'h', cp: 'x', cs: 'w' } };
  /** Do a and b overlap across the axis (i.e. sit in the same row / column)? */
  function crossOverlap(a, b, axis) {
    const { cp, cs } = AX[axis];
    return Math.min(a[cp] + a[cs], b[cp] + b[cs]) - Math.max(a[cp], b[cp]) > 0;
  }
  function crossMid(a, b, axis) {
    const { cp, cs } = AX[axis];
    return (Math.max(a[cp], b[cp]) + Math.min(a[cp] + a[cs], b[cp] + b[cs])) / 2;
  }
  /** Gaps between neighbouring layers in the same row/column (nothing in between). */
  function existingGaps(rects, axis) {
    const { p, s } = AX[axis], out = [];
    for (const a of rects) {
      for (const b of rects) {
        if (a === b || !crossOverlap(a, b, axis)) continue;
        const g = b[p] - (a[p] + a[s]);
        if (g <= 0) continue;
        const blocked = rects.some(c => c !== a && c !== b && c[p] >= a[p] + a[s] && c[p] + c[s] <= b[p] && crossOverlap(c, a, axis) && crossOverlap(c, b, axis));
        if (!blocked) out.push({ g, a, b });
      }
    }
    return out;
  }
  /** Best equal-spacing position for the moving box on one axis. → { delta, kind, L, R, ref } or null */
  function spacingSnap(axis, box, rects, gaps, thr) {
    const { p, s } = AX[axis];
    let L = null, R = null; // nearest neighbours before / after the box, in the same row/column
    for (const r of rects) {
      if (!crossOverlap(r, box, axis)) continue;
      if (r[p] + r[s] <= box[p] + thr && (!L || r[p] + r[s] > L[p] + L[s])) L = r;
      if (r[p] >= box[p] + box[s] - thr && (!R || r[p] < R[p])) R = r;
    }
    const cands = [];
    if (L && R) { // centered between two: equal gaps on both sides
      const g = (R[p] - (L[p] + L[s]) - box[s]) / 2;
      if (g > 0) cands.push({ v: L[p] + L[s] + g, kind: 'between', L, R });
    }
    for (const G of gaps) { // same gap as an existing pair
      if (L && G.a !== L) cands.push({ v: L[p] + L[s] + G.g, kind: 'after', L, ref: G });
      if (R && G.b !== R) cands.push({ v: R[p] - G.g - box[s], kind: 'before', R, ref: G });
    }
    let best = null;
    for (const c of cands) {
      const dd = c.v - box[p];
      if (Math.abs(dd) <= thr && (!best || Math.abs(dd) < Math.abs(best.delta))) best = { ...c, delta: dd };
    }
    return best;
  }
  /** Pink markers for a spacing snap, measured against the final (rounded) box. */
  function gapGuides(axis, sp, box) {
    const { p, s } = AX[axis], out = [];
    const seg = (a, b, at) => ({ type: 'gap', axis, a, b, at, label: Math.round(b - a) });
    // The new gap(s) next to the moving box…
    if (sp.kind === 'between' || sp.kind === 'after') out.push(seg(sp.L[p] + sp.L[s], box[p], crossMid(sp.L, box, axis)));
    if (sp.kind === 'between' || sp.kind === 'before') out.push(seg(box[p] + box[s], sp.R[p], crossMid(box, sp.R, axis)));
    // …and the existing gap it matches.
    if (sp.ref) out.push(seg(sp.ref.a[p] + sp.ref.a[s], sp.ref.b[p], crossMid(sp.ref.a, sp.ref.b, axis)));
    return out;
  }

  /** Screen rects of the spacing handles: one pink pill per gap of the selected row/column. */
  function gapHandles() {
    if (state.tool !== 'pointer' || state.sel) return [];
    const run = selectionRun();
    if (!run) return [];
    const u = run.ls.reduce((a, l) => rectUnion(a, layerRect(l)), null);
    const s = view.s, ox = Math.round(view.ox), oy = Math.round(view.oy);
    const long = Math.round(16 * dpr), thin = Math.round(4 * dpr);
    return run.gaps.map((gap, i) => {
      const a = run.ls[i], b = run.ls[i + 1];
      if (run.axis === 'x') {
        const cx = ox + ((a.x + a.canvas.width + b.x) / 2) * s, cy = oy + (u.y + u.h / 2) * s;
        return { i, run, x: cx - thin / 2, y: cy - long / 2, w: thin, h: long };
      }
      const cx = ox + (u.x + u.w / 2) * s, cy = oy + ((a.y + a.canvas.height + b.y) / 2) * s;
      return { i, run, x: cx - long / 2, y: cy - thin / 2, w: long, h: thin };
    });
  }
  function gapHandleAt(p) {
    const pad = 4 * dpr;
    return gapHandles().find(h => p.x >= h.x - pad && p.x <= h.x + h.w + pad && p.y >= h.y - pad && p.y <= h.y + h.h + pad) || null;
  }
  /** Pink measure markers for every gap of a run (shown while dragging a spacing handle). */
  function runGapGuides(run) {
    const p = run.axis;
    return run.gaps.map((gap, i) => {
      const a = layerRect(run.ls[i]), b = layerRect(run.ls[i + 1]);
      return { type: 'gap', axis: p, a: a[p] + (p === 'x' ? a.w : a.h), b: b[p], at: crossMid(a, b, p), label: gap };
    });
  }

  /** A guide line spanning both the moving box and the thing it snapped to. */
  function guideFor(axis, s, box) {
    return axis === 'x'
      ? { axis, v: s.v, a: Math.min(box.y, s.r.y), b: Math.max(box.y + box.h, s.r.y + s.r.h) }
      : { axis, v: s.v, a: Math.min(box.x, s.r.x), b: Math.max(box.x + box.w, s.r.x + s.r.w) };
  }
  const pixel = d => ({ x: Math.floor(d.x), y: Math.floor(d.y) });
  function dragRect(d) {
    const x0 = Math.min(d.start.x, d.cur.x), y0 = Math.min(d.start.y, d.cur.y);
    return { x: x0, y: y0, w: Math.abs(d.cur.x - d.start.x), h: Math.abs(d.cur.y - d.start.y) };
  }
  /** A marquee drag stops at the artboard's edges (drag past them to select right up to the edge). */
  function marqueeRect(d) {
    const r = dragRect(d);
    return rectIntersect(r, { x: 0, y: 0, w: state.artboard.w, h: state.artboard.h }) || { x: r.x, y: r.y, w: 0, h: 0 };
  }
  /** Shift / Alt override the mode chosen in the options bar (New / Add / Subtract). */
  function selModifier(e) { return e.altKey ? 'sub' : e.shiftKey ? 'add' : state.opts.selMode || 'replace'; }

  /* ---------- live magic wand: re-runs the last click when tolerance / contiguous change */
  let lastWand = null, wandQueued = false;
  function runWand() {
    const lw = lastWand, l = lw && getLayer(lw.layerId);
    if (!l || l.canvas !== lw.canvas) { lastWand = null; return; } // layer pixels changed since the click
    const m = matchMaskData(lw.data, lw.w, lw.h, lw.lx, lw.ly, state.opts.wandTol, state.opts.wandContig);
    const s = selNormalize({ x: l.x, y: l.y, w: lw.w, h: lw.h, mask: m, matte: lw.matte });
    state.sel = selCombine(lw.base, selClip(s), lw.mode);
    lw.result = state.sel;
  }
  /** Re-run the wand if the current selection is still the one it made. Coalesced per frame. */
  function refreshWand() {
    if (!lastWand || state.sel !== lastWand.result || wandQueued) return;
    wandQueued = true;
    setTimeout(() => {
      wandQueued = false;
      if (lastWand && state.sel === lastWand.result) { runWand(); updateChrome(); requestRender(); }
    }, 16);
  }
  function setWandTolerance(v) {
    state.opts.wandTol = v;
    $('#wandTol').value = $('#wandTolNum').value = v;
    refreshWand();
  }

  /* ---------- right-click menus */
  const menuEl = $('#menu');
  let menuOpener = null, menuReturn = null; // the button that opened the menu, and where focus goes back to
  function closeMenu() {
    if (menuEl.hidden) return false;
    const hadFocus = menuEl.contains(document.activeElement);
    menuEl.hidden = true;
    if (menuOpener) menuOpener.setAttribute('aria-expanded', 'false');
    menuOpener = null;
    // From the keyboard, focus goes back to where it was (a menu item that just vanished would drop it)
    if (hadFocus && menuReturn && document.contains(menuReturn)) menuReturn.focus();
    menuReturn = null;
    return true;
  }
  const menuItems = () => $$('.menu-item:not(:disabled)', menuEl);
  /** opts.opener: the button that opened it (aria-expanded); opts.keyboard: focus the first item. */
  function showMenu(items, cx, cy, opts = {}) {
    menuEl.textContent = '';
    menuEl.setAttribute('role', 'menu');
    menuReturn = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    menuOpener = opts.opener || null;
    if (menuOpener) menuOpener.setAttribute('aria-expanded', 'true');
    const hasChecks = items.some(it => it && it.checked !== undefined);
    for (const it of items) {
      if (it === '-') { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' })); continue; }
      if (it.heading) { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'menu-heading', textContent: it.heading })); continue; }
      const b = document.createElement('button');
      b.className = 'menu-item';
      b.disabled = !!it.disabled;
      b.tabIndex = -1;
      b.setAttribute('role', it.checked !== undefined ? 'menuitemradio' : 'menuitem');
      if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
      b.innerHTML = `<span></span><kbd class="menu-key"></kbd>`;
      b.firstChild.textContent = it.label;
      if (hasChecks) b.firstChild.prepend(Object.assign(document.createElement('span'), { className: 'check', textContent: it.checked ? '✓' : '' }));
      if (it.key) b.lastChild.textContent = fmtKeys(it.key); else b.lastChild.remove();
      b.setAttribute('aria-label', it.label);
      if (it.key && /^(Ctrl|Alt|Shift|Del|F\d)/.test(it.key)) b.setAttribute('aria-keyshortcuts', it.key.replace(/Ctrl/g, IS_MAC ? 'Meta' : 'Control').replace(/^Del$/, 'Delete'));
      b.addEventListener('click', () => { closeMenu(); it.run(); });
      menuEl.appendChild(b);
    }
    menuEl.hidden = false;
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(cx, innerWidth - r.width - 6)}px`;
    menuEl.style.top = `${Math.min(cy, innerHeight - r.height - 6)}px`;
    if (opts.keyboard) { const first = menuItems()[0]; if (first) first.focus(); }
  }
  // Arrow keys move through the menu, Enter or Space picks, Esc or Tab closes (as in any native menu).
  menuEl.addEventListener('keydown', e => {
    const list = menuItems(), i = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    else { e.stopPropagation(); return; } // Enter / Space press the focused item; other shortcuts wait while the menu is open
    e.preventDefault(); e.stopPropagation();
    if (next) next.focus();
  });
  document.addEventListener('pointerdown', e => {
    // (menu buttons like More and the Cutout menu toggle the menu themselves)
    if (!menuEl.hidden && !menuEl.contains(e.target) && !e.target.closest('#selMore, #appMenu')) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);

  /** Paste commands for menus — only when Cutout can read the clipboard itself (native app). */
  const pasteMenuItems = () => (Platform.canReadClipboard ? [
    { label: 'Paste', key: 'Ctrl+V', run: () => pasteFromButton() },
  ] : []);
  const artboardMenu = () => [
    { label: 'Copy artboard', key: 'Ctrl+C', run: () => { state.selected.clear(); state.active = null; state.sel = null; changed(); copy(false); } },
    ...pasteMenuItems(),
    '-',
    { label: 'Save', key: 'Ctrl+S', run: () => save(false) },
    { label: 'Save as…', key: 'Ctrl+Shift+S', run: () => save(true) },
    '-',
    { label: 'Canvas size…', key: 'Ctrl+Alt+C', run: openCanvasDialog },
    { label: 'Image size…', key: 'Ctrl+Alt+I', run: openImageDialog },
    { label: 'Trim to content', key: 'Ctrl+Alt+T', run: trimArtboard },
    { label: 'Fit to layers', key: 'Ctrl+Alt+F', run: fitArtboard },
  ];
  const layerMenu = () => {
    const l = activeLayer(), one = state.selected.size === 1;
    return [
      { label: 'Copy', key: 'Ctrl+C', run: () => copy(false) },
      { label: 'Cut', key: 'Ctrl+X', run: () => copy(true) },
      { label: 'Duplicate', run: duplicateSelected },
      { label: 'Rename', key: 'F2', disabled: !one, run: () => startRename(l.id) },
      { label: 'Delete', key: 'Del', run: deleteSelectedLayers },
      '-',
      { label: 'Edit pixels', key: 'Double-click', disabled: !one, run: () => setTool('marquee') },
      { label: 'Original size', disabled: !state.layers.some(x => state.selected.has(x.id) && isScaled(x)), run: originalSize },
      '-',
      { label: 'Flip horizontal', key: 'Shift+H', run: () => transformLayers('h') },
      { label: 'Flip vertical', key: 'Shift+V', run: () => transformLayers('v') },
      { label: 'Rotate 90° right', run: () => transformLayers('cw') },
      { label: 'Rotate 90° left', run: () => transformLayers('ccw') },
      { label: 'Straighten', run: straighten },
      '-',
      { label: 'Shrink to content', run: shrinkToContent },
      { label: 'Clear corners', run: clearCorners },
      '-',
      { label: 'Save layer as…', disabled: !one, run: () => saveCanvasAs(l.canvas, l.name) },
      { label: 'Fit artboard to layer', disabled: !one, run: () => setArtboardRect(layerRect(l)) },
      '-',
      { label: 'Bring to front', key: 'Ctrl+Shift+]', run: () => arrange('top') },
      { label: 'Bring forward', key: 'Ctrl+]', run: () => arrange('up') },
      { label: 'Send backward', key: 'Ctrl+[', run: () => arrange('down') },
      { label: 'Send to back', key: 'Ctrl+Shift+[', run: () => arrange('bottom') },
      '-',
      { label: l && !l.visible ? 'Show' : 'Hide', disabled: !l, run: () => { pushHistory(); for (const id of state.selected) { const x = getLayer(id); if (x) x.visible = !l.visible; } changed(); } },
    ];
  };
  const selectionMenu = () => [
    { label: 'Copy', key: 'Ctrl+C', run: () => copy(false) },
    { label: 'Cut', key: 'Ctrl+X', run: () => copy(true) },
    { label: 'Copy to new layer', key: 'Ctrl+J', run: () => selToLayer(false) },
    { label: 'Cut to new layer', key: 'Ctrl+Shift+J', run: () => selToLayer(true) },
    '-',
    { label: 'Delete pixels', key: 'Del', run: deleteSelectionPixels },
    { label: 'Fill with color', key: 'Alt+Backspace', run: () => fillSelection('color') },
    { label: 'Smart fill', key: 'Shift+Backspace', run: () => fillSelection('smart') },
    { label: 'Invert selection', key: 'Ctrl+Shift+I', run: invertSelection },
    { label: 'Shrink to content', run: shrinkToContent },
    { label: 'Straighten', run: straighten },
    { label: 'Clear corners', run: clearCorners },
    '-',
    { label: 'Save selection as…', run: saveSelectionAs },
    { label: 'Trim to selection', run: trimToSelection },
    '-',
    { label: 'Deselect', key: 'Ctrl+D', run: deselect },
  ];
  const emptyMenu = () => [
    ...pasteMenuItems(),
    { label: 'Open…', key: 'Ctrl+O', run: () => openFiles() },
    '-',
    { label: 'Zoom to fit', key: 'Ctrl+0', run: () => fitView(false) },
    { label: 'Canvas size…', key: 'Ctrl+Alt+C', run: openCanvasDialog },
  ];

  /* ---------- theme: System (follows Windows) / Light / Dark */
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const pref = state.opts.theme || 'system';
    const dark = pref === 'dark' || (pref === 'system' && darkMq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    Platform.setTheme(pref); // desktop app: native title bar
    // Title bar (Edge app window) follows the theme too — same color as the top bar (--panel).
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
    readColors(); // canvas colors (stage, checkerboard) come from the CSS variables
    changed();
  }
  function setTheme(t) {
    state.opts.theme = t;
    savePrefs();
    applyTheme();
  }
  $('#appMenu').addEventListener('click', e => {
    if (closeMenu()) return; // second click closes it
    const r = e.currentTarget.getBoundingClientRect(), t = state.opts.theme || 'system';
    const kb = { opener: e.currentTarget, keyboard: e.detail === 0 }; // detail 0: Enter or Space, not a click
    showMenu([
      { heading: 'Theme' },
      { label: 'System', checked: t === 'system', run: () => setTheme('system') },
      { label: 'Light', checked: t === 'light', run: () => setTheme('light') },
      { label: 'Dark', checked: t === 'dark', run: () => setTheme('dark') },
      // On the Mac app, About is in the menu bar (Cutout → About Cutout)
      ...(IS_MAC && Platform.isNative ? [] : ['-', { label: 'About Cutout', run: openAbout }]),
    ], r.left, r.bottom + 4, kb);
  });

  /** About: the icon, the name and the version (as on the Mac's About window). */
  async function openAbout() {
    const v = await Platform.version();
    $('#aboutVersion').textContent = v ? `Version ${v}` : 'Web version';
    $('#dlgAbout').showModal();
  }
  // A click outside the About box closes it (the backdrop belongs to the dialog element)
  $('#dlgAbout').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  numField($('#gapNum'), () => { const r = selectionRun(); return r ? r.gaps[0] : 0; }, v => setSpacing(Math.max(0, v)));
  $('#alignProps').addEventListener('click', e => {
    const a = e.target.closest('[data-align]'), dist = e.target.closest('[data-distribute]');
    if (a) alignLayers(a.dataset.align);
    else if (dist && !dist.disabled) distributeLayers(dist.dataset.distribute);
  });

  // "More" in the selection actions: the less-used selection commands.
  $('#selMore').addEventListener('click', e => {
    if (closeMenu()) return; // second click closes it
    const r = e.currentTarget.getBoundingClientRect(), kb = { opener: e.currentTarget, keyboard: e.detail === 0 };
    showMenu([
      { label: 'Invert selection', key: 'Ctrl+Shift+I', run: invertSelection },
      { label: 'Shrink to content', run: shrinkToContent },
      { label: 'Straighten', run: straighten },
      { label: 'Clear corners', run: clearCorners },
      { label: 'Save selection as…', run: saveSelectionAs },
      { label: 'Trim to selection', run: trimToSelection },
      '-',
      { label: 'Deselect', key: 'Ctrl+D', run: deselect },
    ], r.left, r.bottom + 4, kb);
  });
  /** The canvas's right-click menu without a pointer (Menu key, Shift+F10, Control+Return): the menu
   *  for the pixel selection, else the selected layer, else the artboard, in the middle of the canvas. */
  function keyboardCanvasMenu() {
    const r = vc.getBoundingClientRect(), l = activeLayer();
    const items = state.sel ? selectionMenu() : l ? layerMenu() : state.layers.length ? (selectArtboard(), artboardMenu()) : emptyMenu();
    changed();
    showMenu(items, r.left + r.width / 2, r.top + r.height / 2, { keyboard: true });
  }
  vc.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (drag) return;
    // From the keyboard (Menu key, Shift+F10: Chromium sends button -1, positioned at the canvas's
    // center) there's no pointer: show the menu for what's selected, in the middle.
    if (e.button === -1 || (e.button !== 2 && !e.clientX && !e.clientY)) { keyboardCanvasMenu(); return; }
    const p = screenPt(e), d = toDoc(p), px = pixel(d);
    let items;
    // With a pixel selection, right-click anywhere gives the selection menu (as in Fireworks).
    if (state.sel) {
      items = selectionMenu();
    } else {
      const hit = hitLayer(px.x, px.y);
      if (hit) {
        if (!state.selected.has(hit.id)) selectOnly(hit.id); else state.active = hit.id;
        items = layerMenu();
      } else if (inArtboard(d) || inLabel(p)) {
        if (state.tool !== 'pointer') setTool('pointer');
        selectArtboard();
        items = artboardMenu();
      } else {
        items = emptyMenu();
      }
    }
    changed();
    showMenu(items, e.clientX, e.clientY);
  });
  vc.addEventListener('pointerdown', e => {
    // Firefox throws for a pointer it doesn't consider active (e.g. a synthetic event); a drag
    // works without capture, it just stops at the window edge.
    try { vc.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
    dragStep = null;
    const p = screenPt(e), d = toDoc(p), px = pixel(d);
    if (e.button === 1 || spaceDown || state.tool === 'hand') {
      drag = { kind: 'pan', sx: p.x, sy: p.y, ox: view.ox, oy: view.oy };
      updateCursor();
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    switch (state.tool) {
      case 'pointer': {
        const gh = gapHandleAt(p);
        if (gh) { // drag a spacing handle: every gap in the row/column changes together
          drag = { kind: 'gapDrag', sp: p, axis: gh.run.axis, g0: gh.run.gaps[gh.i], moved: false };
          return;
        }
        const sl = scalableLayer(), lh = sl ? layerHandleAt(p, sl) : null;
        if (lh) {
          drag = { kind: 'scale', id: sl.id, handle: lh, sp: p, moved: false, orig: { x: sl.x, y: sl.y, w: sl.canvas.width, h: sl.canvas.height }, snap: snapTargets(new Set([sl.id])) };
          return;
        }
        const hd = artboardSel ? handleAt(p) : null;
        if (hd) {
          drag = {
            kind: 'abResize', handle: hd, sp: p, moved: false,
            orig: { w: state.artboard.w, h: state.artboard.h, ox: view.ox, oy: view.oy, sel: state.sel },
            layers: state.layers.map(l => ({ l, x: l.x, y: l.y })),
          };
          return;
        }
        if (inLabel(p)) { selectArtboard(); return; }
        const hit = hitLayer(px.x, px.y);
        if (!hit) {
          if (!e.shiftKey) { state.selected.clear(); state.active = null; }
          artboardSel = false;
          drag = { kind: 'rubber', start: d, cur: d, sp: p, moved: false, base: new Set(state.selected) };
          changed();
          return;
        }
        artboardSel = false;
        // Picking another layer on the canvas drops the pixel selection (Fireworks never leaves
        // one behind here); picking it in the Layers panel keeps it, as in Fireworks.
        if (state.sel && hit.id !== state.active) state.sel = null;
        if (e.shiftKey) {
          if (state.selected.has(hit.id)) {
            state.selected.delete(hit.id);
            if (state.active === hit.id) state.active = [...state.selected].pop() ?? null;
            changed();
            return;
          }
          state.selected.add(hit.id);
          state.active = hit.id;
        } else if (!state.selected.has(hit.id)) {
          selectOnly(hit.id);
        } else {
          state.active = hit.id;
        }
        let ids = state.layers.filter(l => state.selected.has(l.id)).map(l => l.id);
        let pushed = false;
        if (e.altKey) { // Alt+drag duplicates, like Figma / Fireworks
          dragHistory();
          pushed = true;
          const dup = [];
          for (const id of ids) {
            const l = getLayer(id), n = newLayer(l.canvas, l.x, l.y, `${l.name} copy`);
            if (l.src) n.src = l.src;
            insertAbove(n, l.id);
            dup.push(n.id);
          }
          state.selected = new Set(dup);
          state.active = dup[dup.length - 1];
          ids = dup;
        }
        drag = { kind: 'move', start: d, orig: ids.map(id => { const l = getLayer(id); return { id, x: l.x, y: l.y }; }), moved: false, pushed };
        drag.box = ids.reduce((u, id) => rectUnion(u, layerRect(getLayer(id))), null); // the moving group's bounds
        drag.snap = snapTargets(new Set(ids));
        drag.rects = state.layers.filter(x => x.visible && !ids.includes(x.id)).map(layerRect); // stationary layers
        drag.gaps = { x: existingGaps(drag.rects, 'x'), y: existingGaps(drag.rects, 'y') };
        changed();
        return;
      }
      case 'marquee': {
        if (!activeLayer()) { const t = targetLayerAt(px.x, px.y); if (t) selectOnly(t.id); }
        const pt = { x: Math.round(d.x), y: Math.round(d.y) }, style = state.opts.mqStyle;
        drag = { kind: 'marquee', mode: selModifier(e), style, start: pt, cur: pt };
        // Fixed size: a selection of exactly W × H appears at the click; dragging positions it.
        if (style === 'size') drag.cur = { x: pt.x + state.opts.mqW, y: pt.y + state.opts.mqH };
        changed();
        return;
      }
      case 'wand': {
        const mode = selModifier(e), t = targetLayerAt(px.x, px.y);
        if (!t) { if (mode === 'replace') { state.sel = null; lastWand = null; changed(); } return; }
        selectOnly(t.id);
        const lx = px.x - t.x, ly = px.y - t.y, data = pixelsOf(t.canvas), o = (ly * t.canvas.width + lx) * 4;
        lastWand = {
          layerId: t.id, canvas: t.canvas, data, w: t.canvas.width, h: t.canvas.height, lx, ly, mode,
          base: mode === 'replace' ? null : state.sel,
          // Remember the clicked color so Delete / cut-outs can clean edge halos against it.
          matte: data[o + 3] === 255 ? { color: [data[o], data[o + 1], data[o + 2]], inside: true } : undefined,
          result: null,
        };
        runWand();
        drag = { kind: 'wandDrag', sp: p, moved: false, dist: 0 };
        changed();
        return;
      }
      case 'bucket':
        bucketAt(px.x, px.y);
        return;
      case 'eraser': {
        const t = targetLayerAt(px.x, px.y);
        if (!t) return;
        selectOnly(t.id);
        dragHistory();
        // Copy-on-write: the stroke paints into a fresh canvas; the old one stays intact for undo.
        t.canvas = cloneCanvas(t.canvas);
        t.src = null; // pixel edit: bakes in the current scale
        const g = ctx2d(t.canvas);
        g.save();
        if (state.sel) g.clip(selectionPath(state.sel, t)); // with a selection, only erase inside it
        g.globalCompositeOperation = 'destination-out';
        g.lineCap = g.lineJoin = 'round';
        g.lineWidth = state.opts.eraserSize;
        drag = { kind: 'erase', id: t.id, g, last: null };
        eraseTo(drag, d);
        changed();
        return;
      }
    }
  });

  /* ---------- eraser */
  /** Selection mask as a fillable path in a layer's coordinates (one rect per horizontal run). */
  function selectionPath(sel, l) {
    const p = new Path2D(), ox = sel.x - l.x, oy = sel.y - l.y;
    for (let y = 0; y < sel.h; y++) {
      let run = -1;
      for (let x = 0; x <= sel.w; x++) {
        const on = x < sel.w && sel.mask[y * sel.w + x];
        if (on && run < 0) run = x;
        else if (!on && run >= 0) { p.rect(ox + run, oy + y, x - run, 1); run = -1; }
      }
    }
    return p;
  }
  function eraseTo(dr, d) {
    const l = getLayer(dr.id);
    if (!l) return;
    const x = d.x - l.x, y = d.y - l.y, g = dr.g;
    if (!dr.last) { // a single click erases a dot
      g.beginPath();
      g.arc(x, y, state.opts.eraserSize / 2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(dr.last.x, dr.last.y);
      g.lineTo(x, y);
      g.stroke();
    }
    dr.last = { x, y };
    requestRender();
  }
  function setEraserSize(v) {
    state.opts.eraserSize = clamp(Math.round(v), 1, 300);
    $('#eraserSize').value = $('#eraserSizeNum').value = state.opts.eraserSize;
    savePrefs();
    requestRender();
  }

  vc.addEventListener('pointermove', e => {
    const p = screenPt(e), d = toDoc(p), px = pixel(d);
    lastMouse = p;
    updateStatus(px);
    // The button was released where the window couldn't see it (e.g. after switching apps mid-drag)
    if (drag && e.pointerType === 'mouse' && e.buttons === 0) endDrag();
    if (!drag) {
      if (state.tool === 'pointer') {
        const sl = scalableLayer(), gh = gapHandleAt(p);
        const hd = gh ? (gh.run.axis === 'x' ? 'e' : 's') : (sl && layerHandleAt(p, sl)) || (artboardSel ? handleAt(p) : null);
        vc.style.cursor = spaceDown ? 'grab' : hd ? HANDLE_CURSORS[hd] : 'default';
        const h = hd ? null : hitLayer(px.x, px.y), id = h ? h.id : null;
        if (id !== hoverId) { hoverId = id; requestRender(); }
      }
      if (state.tool === 'eraser') requestRender(); // brush outline follows the mouse
      return;
    }
    if (drag.kind === 'erase') { eraseTo(drag, d); return; }
    switch (drag.kind) {
      case 'gapDrag': {
        const delta = (drag.axis === 'x' ? p.x - drag.sp.x : p.y - drag.sp.y) / view.s;
        const v = Math.max(0, Math.round(drag.g0 + delta));
        if (!drag.moved && v !== drag.g0) { dragHistory(); drag.moved = true; }
        if (!drag.moved) break;
        const run = selectionRun();
        if (run) { setRunGap(run, v); guides = runGapGuides(selectionRun() || run); }
        updateChrome();
        requestRender();
        break;
      }
      case 'scale': {
        const l = getLayer(drag.id);
        if (!l) break;
        const o = drag.orig, hd = drag.handle, corner = hd.length === 2;
        const k = e.altKey ? 2 : 1; // Alt: scale from the center
        const dx = ((p.x - drag.sp.x) / view.s) * k, dy = ((p.y - drag.sp.y) / view.s) * k;
        let w = o.w, h = o.h;
        if (hd.includes('e')) w = o.w + dx;
        if (hd.includes('w')) w = o.w - dx;
        if (hd.includes('s')) h = o.h + dy;
        if (hd.includes('n')) h = o.h - dy;
        if (corner && !e.shiftKey) {
          // Corners keep proportions (Shift = free). Follow whichever axis moved more.
          const f = Math.abs(w / o.w - 1) > Math.abs(h / o.h - 1) ? w / o.w : h / o.h;
          w = o.w * f;
          h = o.h * f;
        } else if (!corner && e.shiftKey) {
          // Shift on a side keeps proportions, growing evenly on the other axis.
          if (hd === 'e' || hd === 'w') h = o.h * (w / o.w); else w = o.w * (h / o.h);
        }
        w = Math.max(1, Math.round(w));
        h = Math.max(1, Math.round(h));
        let x, y;
        if (e.altKey) {
          x = o.x + (o.w - w) / 2;
          y = o.y + (o.h - h) / 2;
        } else {
          x = hd.includes('w') ? o.x + o.w - w : hd.includes('e') ? o.x : o.x + (o.w - w) / 2;
          y = hd.includes('n') ? o.y + o.h - h : hd.includes('s') ? o.y : o.y + (o.h - h) / 2;
        }
        // Smart guides: snap the edge(s) being dragged to other layers and the artboard.
        guides = [];
        if (!e.ctrlKey && !e.metaKey && !e.altKey && drag.snap) { // Ctrl (⌘ on Mac) turns snapping off
          const thr = SNAP_PX * dpr / view.s, horiz = hd.includes('e') || hd.includes('w'), vert = hd.includes('n') || hd.includes('s');
          const sx = horiz ? bestSnap([hd.includes('e') ? x + w : x], drag.snap.xs, thr) : null;
          let sy = vert ? bestSnap([hd.includes('s') ? y + h : y], drag.snap.ys, thr) : null;
          const prop = (corner && !e.shiftKey) || (!corner && e.shiftKey);
          if (prop && sx && sy) sy = null; // proportional: one axis drives the other
          if (sx) {
            if (hd.includes('e')) w = Math.max(1, Math.round(w + sx.delta));
            else { w = Math.max(1, Math.round(w - sx.delta)); x = o.x + o.w - w; }
            if (prop) { h = Math.max(1, Math.round(o.h * (w / o.w))); y = hd.includes('n') ? o.y + o.h - h : hd.includes('s') ? o.y : o.y + (o.h - h) / 2; }
          }
          if (sy) {
            if (hd.includes('s')) h = Math.max(1, Math.round(h + sy.delta));
            else { h = Math.max(1, Math.round(h - sy.delta)); y = o.y + o.h - h; }
            if (prop) { w = Math.max(1, Math.round(o.w * (h / o.h))); x = hd.includes('w') ? o.x + o.w - w : hd.includes('e') ? o.x : o.x + (o.w - w) / 2; }
          }
          const fin = { x: Math.round(x), y: Math.round(y), w, h };
          if (sx) guides.push(guideFor('x', sx, fin));
          if (sy) guides.push(guideFor('y', sy, fin));
        }
        if (!drag.moved && (w !== o.w || h !== o.h)) { dragHistory(); drag.moved = true; }
        if (!drag.moved) break;
        l.x = Math.round(x);
        l.y = Math.round(y);
        l.dw = w;
        l.dh = h;
        updateLayerFields();
        requestRender();
        break;
      }
      case 'wandDrag': {
        // Sketch-style: hold and drag away from the click to set tolerance live.
        const dist = Math.hypot(p.x - drag.sp.x, p.y - drag.sp.y) / dpr;
        if (!drag.moved && dist < 4) break;
        drag.moved = true;
        drag.dist = dist;
        setWandTolerance(Math.round(clamp(dist, 0, 255)));
        requestRender();
        break;
      }
      case 'abResize': {
        const o = drag.orig, hd = drag.handle;
        const dx = Math.round((p.x - drag.sp.x) / view.s), dy = Math.round((p.y - drag.sp.y) / view.s);
        let x0 = 0, y0 = 0, x1 = o.w, y1 = o.h;
        if (hd.includes('w')) x0 = Math.min(dx, o.w - 1);
        if (hd.includes('e')) x1 = Math.max(o.w + dx, 1);
        if (hd.includes('n')) y0 = Math.min(dy, o.h - 1);
        if (hd.includes('s')) y1 = Math.max(o.h + dy, 1);
        if (!drag.moved && (x0 || y0 || x1 !== o.w || y1 !== o.h)) { dragHistory(); drag.moved = true; }
        if (!drag.moved) break;
        // The artboard always starts at 0,0 – moving its left/top edge shifts the content instead.
        state.artboard.w = x1 - x0;
        state.artboard.h = y1 - y0;
        for (const it of drag.layers) { it.l.x = it.x - x0; it.l.y = it.y - y0; }
        if (o.sel) state.sel = { ...o.sel, x: o.sel.x - x0, y: o.sel.y - y0 };
        userView();
        view.ox = o.ox + x0 * view.s;
        view.oy = o.oy + y0 * view.s;
        updateArtboardFields();
        requestRender();
        break;
      }
      case 'pan':
        userView();
        view.ox = drag.ox + (p.x - drag.sx);
        view.oy = drag.oy + (p.y - drag.sy);
        requestRender();
        break;
      case 'move': {
        let dx = Math.round(d.x - drag.start.x), dy = Math.round(d.y - drag.start.y);
        let lockX = false, lockY = false;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) { dy = 0; lockY = true; } else { dx = 0; lockX = true; } } // axis lock
        if (!drag.moved && (dx || dy)) {
          if (!drag.pushed) dragHistory();
          drag.moved = true;
        }
        if (drag.moved) {
          // Smart guides: snap the moving box's edges/center to other layers and the artboard.
          guides = [];
          if (!e.ctrlKey && !e.metaKey && drag.snap) { // Ctrl (⌘ on Mac) turns snapping off
            const box = { x: drag.box.x + dx, y: drag.box.y + dy, w: drag.box.w, h: drag.box.h };
            const thr = SNAP_PX * dpr / view.s;
            let sx = lockX ? null : bestSnap([box.x, box.x + box.w / 2, box.x + box.w], drag.snap.xs, thr);
            let sy = lockY ? null : bestSnap([box.y, box.y + box.h / 2, box.y + box.h], drag.snap.ys, thr);
            // Equal spacing competes with edge alignment on each axis; the closer one wins.
            let gx = lockX ? null : spacingSnap('x', box, drag.rects, drag.gaps.x, thr);
            let gy = lockY ? null : spacingSnap('y', box, drag.rects, drag.gaps.y, thr);
            if (gx && sx && Math.abs(sx.delta) <= Math.abs(gx.delta)) gx = null; else if (gx) sx = null;
            if (gy && sy && Math.abs(sy.delta) <= Math.abs(gy.delta)) gy = null; else if (gy) sy = null;
            const ax = sx || gx, ay = sy || gy;
            if (ax) dx = Math.round(dx + ax.delta);
            if (ay) dy = Math.round(dy + ay.delta);
            const fin = { x: drag.box.x + dx, y: drag.box.y + dy, w: drag.box.w, h: drag.box.h };
            if (sx) guides.push(guideFor('x', sx, fin));
            if (sy) guides.push(guideFor('y', sy, fin));
            if (gx) guides.push(...gapGuides('x', gx, fin));
            if (gy) guides.push(...gapGuides('y', gy, fin));
          }
          for (const o of drag.orig) { const l = getLayer(o.id); if (l) { l.x = o.x + dx; l.y = o.y + dy; } }
          requestRender();
        }
        break;
      }
      case 'marquee': {
        let cx = Math.round(d.x), cy = Math.round(d.y);
        const { mqW, mqH } = state.opts;
        if (drag.style === 'size') {
          drag.start = { x: cx, y: cy };
          drag.cur = { x: cx + mqW, y: cy + mqH };
        } else {
          let rw = 0, rh = 0;
          if (drag.style === 'ratio') { rw = mqW; rh = mqH; }
          else if (e.shiftKey && drag.mode === 'replace') { rw = 1; rh = 1; } // Shift while dragging = square
          if (rw && rh) {
            const dx = cx - drag.start.x, dy = cy - drag.start.y;
            const k = Math.max(Math.abs(dx) / rw, Math.abs(dy) / rh);
            cx = drag.start.x + Math.sign(dx || 1) * Math.round(k * rw);
            cy = drag.start.y + Math.sign(dy || 1) * Math.round(k * rh);
          }
          drag.cur = { x: cx, y: cy };
        }
        const r = marqueeRect(drag);
        $('#selSize').textContent = `${r.w} × ${r.h}`;
        requestRender();
        break;
      }
      case 'rubber': {
        drag.cur = d;
        if (Math.hypot(p.x - drag.sp.x, p.y - drag.sp.y) > 3 * dpr) drag.moved = true;
        if (!drag.moved) break;
        const r = dragRect(drag), next = new Set(drag.base);
        for (const l of state.layers) if (l.visible && rectIntersect(layerRect(l), r)) next.add(l.id);
        state.selected = next;
        state.active = [...next].pop() ?? null;
        requestRender();
        break;
      }
    }
  });

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    dragStep = null;
    if (d.kind === 'marquee') {
      const r = marqueeRect(d);
      if (r.w > 0 && r.h > 0) state.sel = selCombine(state.sel, selFromRect(r), d.mode);
      else if (d.mode === 'replace') state.sel = null;
    }
    guides = [];
    if (d.kind === 'wandDrag' && d.moved) savePrefs();
    if (d.kind === 'erase') {
      d.g.restore();
      const l = getLayer(d.id);
      if (l) {
        thumbCache.delete(l.canvas); // pixels changed in place during the stroke
        const t = trimmed(l.canvas);
        if (!t) removeLayer(l.id); // erased everything
        else { l.canvas = t.canvas; l.x += t.dx; l.y += t.dy; }
      }
    }
    if (d.kind === 'scale') {
      const l = getLayer(d.id);
      if (l && l.dw) {
        const { dw, dh } = l;
        delete l.dw;
        delete l.dh;
        resizeLayer(l, l.x, l.y, dw, dh); // resample once, from the original pixels
      }
    }
    if (d.kind === 'rubber' && !d.moved && !d.base.size && inArtboard(d.start)) {
      artboardSel = true; // plain click on empty artboard selects the artboard
    }
    updateCursor();
    changed();
  }

  // Double-click a layer → edit its pixels with the marquee (Fireworks-style). Esc returns.
  vc.addEventListener('dblclick', e => {
    if (state.tool !== 'pointer') return;
    const px = pixel(toDoc(screenPt(e))), hit = hitLayer(px.x, px.y);
    if (!hit) return;
    selectOnly(hit.id);
    setTool('marquee');
    toast('Editing pixels');
  });
  vc.addEventListener('pointerup', endDrag);
  vc.addEventListener('pointercancel', endDrag);
  vc.addEventListener('pointerleave', () => {
    if (!drag) {
      lastMouse = null;
      if (hoverId != null) hoverId = null;
      requestRender(); // also hides the eraser outline
      $('#cursorPos').textContent = '';
      $('#cursorColor').textContent = '';
      $('#cursorChip').style.visibility = 'hidden';
    }
  });

  vc.addEventListener('wheel', e => {
    e.preventDefault();
    const p = screenPt(e), k = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(view.s * Math.exp(-e.deltaY * k * 0.0022), p.x, p.y);
    } else if (e.shiftKey) {
      userView();
      view.ox -= (e.deltaY || e.deltaX) * k * dpr;
      requestRender();
    } else {
      userView();
      view.ox -= e.deltaX * k * dpr;
      view.oy -= e.deltaY * k * dpr;
      requestRender();
    }
  }, { passive: false });

  /** I key: the system eyedropper (with magnifier) — picks from anywhere on screen. */
  function pickFromScreen() {
    if (!window.EyeDropper) { const i = $$('.fill-color').find(x => x.offsetParent); if (i) i.click(); return; }
    new window.EyeDropper().open().then(r => {
      setFillColor(r.sRGBHex);
      savePrefs();
      toast(`Fill color ${r.sRGBHex.toUpperCase()}`);
    }, () => { /* cancelled */ });
  }

  function updateStatus(px) {
    $('#cursorPos').textContent = `${px.x}, ${px.y}`;
    const c = sampleColor(px.x, px.y);
    $('#cursorChip').style.background = c ? c.hex : 'transparent';
    $('#cursorChip').style.visibility = c ? 'visible' : 'hidden';
    $('#cursorColor').textContent = c ? `${c.hex.toUpperCase()}${c.a < 255 ? ` · ${Math.round((c.a / 255) * 100)}%` : ''}` : 'transparent';
  }

  const CURSORS = { pointer: 'default', marquee: 'crosshair', wand: 'crosshair', bucket: 'crosshair', eraser: 'crosshair', hand: 'grab' };
  function updateCursor() {
    if (drag && drag.kind === 'pan') vc.style.cursor = 'grabbing';
    else if (spaceDown) vc.style.cursor = 'grab';
    else vc.style.cursor = CURSORS[state.tool];
  }

  /* ---------- drag & drop files */
  stage.addEventListener('dragover', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    if (nativeDragId != null) return; // our own layer, dragged out of the Layers panel
    e.preventDefault();
    stage.classList.add('drop');
  });
  stage.addEventListener('dragleave', e => { if (e.target === stage || e.target === vc) stage.classList.remove('drop'); });
  stage.addEventListener('drop', e => {
    e.preventDefault();
    stage.classList.remove('drop');
    if (nativeDragId != null) { nativeDragId = dragLayerId = null; return; }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) openFiles(files, toDoc(screenPt(e)));
  });

  /* ---------- clipboard paste */
  document.addEventListener('paste', async e => {
    if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
    const items = e.clipboardData ? Array.from(e.clipboardData.items) : [];
    const item = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) {
      // No image: maybe Copy as SVG (markup as text), or a normal Figma copy (private format).
      const cd = e.clipboardData;
      const text = cd ? cd.getData('text/plain') : '', html = cd ? cd.getData('text/html') : '';
      e.preventDefault();
      await pasteText(text, html);
      return;
    }
    e.preventDefault();
    try { pasteCanvas(await blobToCanvas(item.getAsFile())); }
    catch (_) { toast('Couldn’t read the image'); }
  });

  /* ======================================================================
   * Keyboard
   * ==================================================================== */
  /* How focus arrived: only controls reached with the keyboard (Tab, a menu opened with Enter) change
   * what keys do and show a focus ring. A clicked layer row or list keeps today's behavior: Space pans,
   * arrows nudge, Esc deselects. (The browser's own :focus-visible turns on at the first key press
   * even after a click, so it can't tell these apart.) */
  let lastInput = 'keyboard';
  document.addEventListener('pointerdown', () => { lastInput = 'pointer'; }, true);
  document.addEventListener('keydown', () => { lastInput = 'keyboard'; }, true);
  document.addEventListener('focusin', e => { if (e.target.classList) e.target.classList.toggle('pointer-focus', lastInput === 'pointer'); });
  const byKeyboard = t => !!(t && t.classList && !t.classList.contains('pointer-focus'));
  function keyForControl(t, key) {
    if (!t || !t.matches || t === vc || !byKeyboard(t)) return false;
    if (key === 'Escape') return t.matches('button, select, input, [tabindex]');
    if (key === ' ' || key === 'Enter') return t.matches('button, select, input, a[href]');
    if (/^(Arrow|Home$|End$|Page)/.test(key)) return t.matches('select, input[type="range"], input[type="radio"]');
    if (key.length === 1) return t.matches('select'); // a letter picks an option in a list, not a tool
    return false;
  }
  function isTyping(t) {
    if (!t || !t.matches) return false;
    if (t.matches('textarea, [contenteditable="true"]')) return true;
    return t.matches('input') && !['checkbox', 'radio', 'color', 'button'].includes(t.type);
  }
  const TOOL_KEYS = { v: 'pointer', m: 'marquee', w: 'wand', g: 'bucket', k: 'bucket', e: 'eraser' }; // pan: hold Space or scroll

  document.addEventListener('keydown', e => {
    if (!e.key || document.querySelector('dialog[open]')) return; // (autofill can send a keydown with no key)
    if (isTyping(e.target)) {
      if (e.key === 'Escape' || e.key === 'Enter') e.target.blur();
      return;
    }
    // A control reached with Tab works as usual: Space and Enter press a button, arrows change a
    // list or slider, Esc leaves it. (Clicked buttons never keep focus, so this is keyboard only.)
    if (!menuEl.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !menuEl.contains(e.target)) {
      e.preventDefault();
      const list = menuItems(); if (list.length) list[e.key === 'ArrowDown' ? 0 : list.length - 1].focus();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey && keyForControl(e.target, e.key)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    // Mid-drag (moving, scaling, erasing…), commands wait: an undo or delete in the middle of a
    // stroke would leave the drag working on layers that are no longer there. Space still pans.
    // Esc takes the drag back; a wand drag just ends where it is.
    if (drag && drag.kind !== 'pan' && e.key !== ' ') {
      e.preventDefault();
      if (e.key === 'Escape') { if (drag.kind === 'wandDrag') endDrag(); else cancelDrag(); }
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey, code = e.code;
    // On a Mac, Option+letter types a special character (Option+A = "å"), so read the physical key.
    const key = IS_MAC && alt && /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : e.key.toLowerCase();

    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; updateCursor(); }
      return;
    }
    if (ctrl && alt) {
      if (key === 'c') openCanvasDialog();
      else if (key === 'i') openImageDialog();
      else if (key === 't') trimArtboard();
      else if (key === 'f') fitArtboard();
      else return;
      e.preventDefault();
      return;
    }
    if (ctrl) {
      // Ctrl+Arrow: grow the pixel selection 1 px that way · Ctrl+Shift+Arrow: shrink it 1 px from that side.
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        if (!state.sel) return;
        const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        const next = selClip(selNudgeEdge(state.sel, dx, dy, !shift));
        if (next) { state.sel = next; changed(); }
        return;
      }
      if (key === 'v') return; // Ctrl+V: handled by the paste event
      // Control+Return opens the canvas menu from the keyboard: Macs have no Menu key, and Shift+F10 is
      // a Windows convention. (The physical Control key, not ⌘.)
      if (e.key === 'Enter' && e.ctrlKey && !e.metaKey && !alt && !shift) { e.preventDefault(); keyboardCanvasMenu(); return; }
      if (key === 'z') shift ? redo() : undo();
      else if (key === 'y') redo();
      else if (key === 's') save(shift);
      else if (key === 'c') copy(false);
      else if (key === 'x') copy(true);
      else if (key === 'a') selectAll();
      else if (key === 'd') deselect();
      else if (key === 'i' && shift) invertSelection();
      else if (key === 'j') selToLayer(shift);
      else if (key === 'o') openFiles();
      else if (key === 'n') newDocument();
      else if (key === 'e') save(true); // old Export shortcut = Save As
      else if (code === 'Equal' || code === 'NumpadAdd') zoomStep(1);
      else if (code === 'Minus' || code === 'NumpadSubtract') zoomStep(-1);
      else if (code === 'Digit0' || code === 'Numpad0') fitView(false);
      else if (code === 'Digit1' || code === 'Numpad1') zoom100();
      else if (code === 'BracketRight') arrange(shift ? 'top' : 'up');
      else if (code === 'BracketLeft') arrange(shift ? 'bottom' : 'down');
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (alt) fillSelection('color');
      else if (shift) fillSelection('smart'); // without a selection it says so (never deletes the layer)
      else if (state.sel) deleteSelectionPixels();
      else deleteSelectedLayers();
      return;
    }
    if (e.key === 'F2') { // rename the selected layer (Windows convention)
      e.preventDefault();
      if (state.selected.size === 1) startRename([...state.selected][0]);
      return;
    }
    if (e.key === 'Escape') {
      if (closeMenu()) return;
      if (state.tool !== 'pointer') { state.sel = null; setTool('pointer'); changed(); return; } // leave pixel editing
      if (state.sel) { state.sel = null; changed(); return; }
      if (artboardSel) { artboardSel = false; changed(); return; }
      deselect();
      return;
    }
    if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const n = shift ? 10 : 1;
      nudge(e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, e.key === 'ArrowUp' ? -n : e.key === 'ArrowDown' ? n : 0);
      return;
    }
    if (!alt && key === 'i') { e.preventDefault(); pickFromScreen(); return; }
    // Shift+H / Shift+V flip the selected layers (as in Figma) — checked before the H tool key.
    if (shift && !alt && (key === 'h' || key === 'v')) { e.preventDefault(); transformLayers(key); return; }
    // [ and ] change the eraser size.
    if (state.tool === 'eraser' && (code === 'BracketLeft' || code === 'BracketRight')) {
      e.preventDefault();
      const s = state.opts.eraserSize, step = s < 10 ? 1 : s < 50 ? 5 : 10;
      setEraserSize(s + (code === 'BracketRight' ? step : -step));
      return;
    }
    // Align (Figma shortcuts): Alt+A/H/D left/center/right, Alt+W/V/S top/middle/bottom;
    // Alt+Shift+H / Alt+Shift+V distribute spacing.
    if (alt && state.selected.size) {
      const ALIGN = { a: 'left', h: 'hcenter', d: 'right', w: 'top', v: 'vcenter', s: 'bottom' };
      if (shift && (key === 'h' || key === 'v')) { e.preventDefault(); distributeLayers(key); return; }
      if (!shift && ALIGN[key]) { e.preventDefault(); alignLayers(ALIGN[key]); return; }
    }
    if (!alt && TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); e.preventDefault(); }
  });
  document.addEventListener('keyup', e => {
    if (e.key === ' ') { spaceDown = false; updateCursor(); }
  });
  window.addEventListener('blur', () => { spaceDown = false; updateCursor(); });

  // Keep buttons from stealing focus, so Space/Delete always reach the canvas.
  document.addEventListener('mousedown', e => {
    if (e.target.closest('button') && !e.target.closest('dialog')) {
      e.preventDefault();
      // The click doesn't move focus, so a control focused earlier with Tab would keep it, and Space
      // would press that control instead of panning. A click anywhere ends keyboard focus on controls.
      const a = document.activeElement;
      if (a && a !== document.body && !isTyping(a) && !menuEl.contains(a) && !e.target.closest('#menu')) a.blur();
    }
  });

  /* ======================================================================
   * Chrome: tools, options, layers panel
   * ==================================================================== */
  function setTool(t) {
    state.tool = t;
    hoverId = null;
    updateCursor();
    updateChrome();
    requestRender();
  }

  function bindTolerance(rangeId, numId, key, onChange) {
    const range = $(rangeId), num = $(numId);
    range.value = num.value = state.opts[key];
    range.addEventListener('input', () => { num.value = range.value; state.opts[key] = +range.value; if (onChange) onChange(); });
    range.addEventListener('change', () => { savePrefs(); range.blur(); });
    // Same behaviour as the size fields: math, ↑/↓ nudging, select-on-focus.
    numField(num, () => state.opts[key], v => {
      v = clamp(v, 0, 255);
      state.opts[key] = v;
      range.value = v;
      savePrefs();
      if (onChange) onChange();
    });
  }
  bindTolerance('#wandTol', '#wandTolNum', 'wandTol', refreshWand); // live: dragging updates the selection
  bindTolerance('#fillTol', '#fillTolNum', 'fillTol');
  $('#wandContig').checked = state.opts.wandContig;
  $('#fillContig').checked = state.opts.fillContig;
  $('#defringe').value = String(state.opts.defringe);
  $('#defringe').addEventListener('change', e => { state.opts.defringe = +e.target.value; savePrefs(); e.target.blur(); });
  $('#eraserSize').value = $('#eraserSizeNum').value = state.opts.eraserSize;
  $('#eraserSize').addEventListener('input', e => setEraserSize(+e.target.value));
  $('#eraserSize').addEventListener('change', e => e.target.blur());
  numField($('#eraserSizeNum'), () => state.opts.eraserSize, v => setEraserSize(v));
  $('#wandContig').addEventListener('change', e => { state.opts.wandContig = e.target.checked; savePrefs(); e.target.blur(); refreshWand(); });
  $('#fillContig').addEventListener('change', e => { state.opts.fillContig = e.target.checked; savePrefs(); e.target.blur(); });
  for (const [id, key] of [['#selFill', 'fillWith'], ['#bucketFill', 'bucketFill']])
    $(id).addEventListener('change', e => { state.opts[key] = e.target.value; savePrefs(); e.target.blur(); updateChrome(); });
  // Fill color appears in two places (Bucket options, next to Fill) — keep them in sync.
  function setFillColor(hex) {
    state.opts.color = hex;
    $$('.fill-color').forEach(i => { if (i.value !== hex) i.value = hex; });
  }
  $$('.fill-color').forEach(i => {
    i.value = state.opts.color;
    i.addEventListener('input', e => setFillColor(e.target.value));
    i.addEventListener('change', e => { setFillColor(e.target.value); savePrefs(); e.target.blur(); });
  });

  const COMMANDS = {
    open: () => openFiles(),
    paste: pasteFromButton,
    undo, redo,
    canvasSize: openCanvasDialog,
    imageSize: openImageDialog,
    trim: trimArtboard,
    fit: fitArtboard,
    copy: () => copy(false),
    save: () => save(false),
    originalSize,
    selDelete: deleteSelectionPixels,
    copyToLayer: () => selToLayer(false),
    cutToLayer: () => selToLayer(true),
    fillSel: () => fillSelection(),
    invert: invertSelection,
    cropToSel: trimToSelection,
    deselect,
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    zoomFit: () => fitView(false),
    zoom100,
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-cmd]');
    if (b && !b.disabled && COMMANDS[b.dataset.cmd]) { COMMANDS[b.dataset.cmd](); return; }
    const t = e.target.closest('#tools [data-tool]');
    if (t) setTool(t.dataset.tool);
  });

  function changed() {
    renderLayers();
    updateChrome();
    requestRender();
    scheduleCompact(); // shrink undo memory shortly after edits settle
  }
  function updateChrome() {
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnRedo').disabled = !redoStack.length;
    $$('#tools [data-tool]').forEach(b => { const on = b.dataset.tool === state.tool; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    $$('.opt[data-for]').forEach(o => o.classList.toggle('show', o.dataset.for.split(' ').includes(state.tool)));
    $$('#selModeSeg button').forEach(b => { const on = b.dataset.mode === (state.opts.selMode || 'replace'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    $('#mqStyle').value = state.opts.mqStyle;
    $('#mqDims').style.display = state.opts.mqStyle === 'normal' ? 'none' : '';
    // Aspect ratio reads "16 : 9"; exact size reads "1200 × 630 px".
    const ratio = state.opts.mqStyle === 'ratio';
    $('#mqSep').textContent = ratio ? ':' : '×';
    $('#mqUnit').style.display = ratio ? 'none' : '';
    for (const [id, v] of [['#mqW', state.opts.mqW], ['#mqH', state.opts.mqH]]) { const el = $(id); if (document.activeElement !== el) el.value = v; }
    $('#selActions').classList.toggle('show', !!state.sel);
    $('#selFill').value = state.opts.fillWith;
    $('#bucketFill').value = state.opts.bucketFill;
    $('.optionsbar').dataset.fillWith = state.opts.fillWith;
    $('.optionsbar').dataset.bucketFill = state.opts.bucketFill;
    $('#btnFill').title = fmtKeys(fillMode() === 'smart' ? 'Smart fill (Shift+Backspace)' : 'Fill (Alt+Backspace)');
    $('.optionsbar').dataset.activeTool = state.tool;
    updateLayerFields();
    // Align / distribute: Pointer tool with layers selected (distribute needs 3+).
    $('#alignProps').classList.toggle('show', state.tool === 'pointer' && state.selected.size > 0 && !state.sel);
    $$('#alignProps [data-distribute]').forEach(b => { b.disabled = state.selected.size < 3; });
    // Spacing field: the gap when all gaps are equal, "Mixed" otherwise; off unless the selection is a row/column.
    const run = state.tool === 'pointer' && !state.sel ? selectionRun() : null, gn = $('#gapNum');
    $('#spacingField').classList.toggle('disabled', !run);
    gn.disabled = !run;
    $('#spacingIcon').style.transform = run && run.axis === 'y' ? 'rotate(90deg)' : '';
    if (document.activeElement !== gn) {
      const equal = run && run.gaps.every(g => g === run.gaps[0]);
      gn.value = equal ? run.gaps[0] : '';
      gn.placeholder = run ? 'Mixed' : '';
    }
    if (state.sel) $('#selSize').textContent = `${state.sel.w} × ${state.sel.h}`;
  }

  /* ---------- number fields with Sketch-style math
   * "60/2" → 30 · "(100+20)*2" → 240 · leading operator is relative: "*2", "/2", "+10"
   * "50%" → 50% of the current value · ↑/↓ nudge by 1, Shift+↑/↓ by 10.
   * A tiny parser (numbers, + − * /, parentheses) — never eval(). */
  function evalExpr(str, cur) {
    let s = String(str).trim().replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/,/g, '.');
    if (!s) return NaN;
    if (/^[*/+]/.test(s)) s = `(${cur})${s}`;
    s = s.replace(/(\d*\.?\d+)\s*%/g, (_, n) => `(${cur}*${n}/100)`);
    if (!/^[\d+\-*/().\s]+$/.test(s)) return NaN;
    let i = 0;
    const peek = () => { while (s[i] === ' ') i++; return s[i]; };
    const num = () => {
      peek();
      const m = /^\d*\.?\d+/.exec(s.slice(i));
      if (!m) throw new Error('number expected');
      i += m[0].length;
      return parseFloat(m[0]);
    };
    const factor = () => {
      const c = peek();
      if (c === '-') { i++; return -factor(); }
      if (c === '+') { i++; return factor(); }
      if (c === '(') { i++; const v = expr(); if (peek() !== ')') throw new Error(') expected'); i++; return v; }
      return num();
    };
    const term = () => {
      let v = factor();
      for (;;) {
        const c = peek();
        if (c === '*') { i++; v *= factor(); } else if (c === '/') { i++; v /= factor(); } else return v;
      }
    };
    const expr = () => {
      let v = term();
      for (;;) {
        const c = peek();
        if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v;
      }
    };
    try {
      const v = expr();
      return peek() === undefined && Number.isFinite(v) ? v : NaN;
    } catch (_) {
      return NaN;
    }
  }
  /** Wires a text field: math on Enter/blur, ↑/↓ nudging, select-all on focus. */
  function numField(el, getCur, apply) {
    el.addEventListener('focus', () => el.select());
    el.addEventListener('change', () => {
      const cur = getCur(), v = evalExpr(el.value, cur);
      if (Number.isNaN(v)) { el.value = cur; return; } // not a number/formula: put the old value back
      apply(Math.round(v));
      el.value = getCur();
    });
    el.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const typed = evalExpr(el.value, getCur()), base = Number.isNaN(typed) ? getCur() : typed;
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      apply(Math.round(base + step));
      el.value = getCur();
      el.select();
    });
  }

  /* ---------- selection mode + marquee style */
  $('#selModeSeg').addEventListener('click', e => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.opts.selMode = b.dataset.mode;
    savePrefs();
    updateChrome();
  });
  $('#mqStyle').addEventListener('change', e => {
    state.opts.mqStyle = e.target.value;
    // Sensible starting values for each: a ratio of 16:9, an exact size of 1200 × 630.
    if (e.target.value === 'ratio' && (state.opts.mqW > 100 || state.opts.mqH > 100)) { state.opts.mqW = 16; state.opts.mqH = 9; }
    if (e.target.value === 'size' && state.opts.mqW <= 100 && state.opts.mqH <= 100) { state.opts.mqW = 1200; state.opts.mqH = 630; }
    savePrefs();
    e.target.blur();
    updateChrome();
  });
  for (const k of ['mqW', 'mqH']) {
    numField($('#' + k), () => state.opts[k], v => { state.opts[k] = clamp(v, 1, 16000); savePrefs(); });
  }

  /* ---------- artboard fields: shown when nothing is selected (the artboard is the document) */
  function updateArtboardFields() {
    // Pointer only, like the layer fields — other tools show just their own settings.
    const show = state.tool === 'pointer' && state.selected.size === 0 && !state.sel;
    $('#artboardProps').classList.toggle('show', show);
    if (!show) return;
    const A = state.artboard;
    for (const [id, v] of [['#aw', A.w], ['#ah', A.h]]) { const el = $(id); if (document.activeElement !== el) el.value = v; }
    $('#abTransparent').checked = !A.bg;
    if (A.bg) $('#abBg').value = A.bg;
    $('#abBgSwatch').classList.toggle('is-transparent', !A.bg);
    $('#abLock').classList.toggle('on', abLocked());
    $('#abLock').setAttribute('aria-pressed', String(abLocked()));
  }
  const abLocked = () => !!state.opts.abLockCanvas;
  /** field: 'w' or 'h' — which one was typed (drives the proportion lock). */
  function setArtboardSize(field, v) {
    const A = state.artboard;
    v = clamp(v, 1, 16000);
    let w = field === 'w' ? v : A.w, h = field === 'h' ? v : A.h;
    if (abLocked()) {
      if (field === 'w') h = clamp(Math.round((w * A.h) / A.w), 1, 16000);
      else w = clamp(Math.round((h * A.w) / A.h), 1, 16000);
    }
    if (w === A.w && h === A.h) return;
    pushHistory();
    A.w = w; // canvas size only: grows/shrinks from the top-left, like dragging the right/bottom edges
    A.h = h;
    changed();
  }
  numField($('#aw'), () => state.artboard.w, v => setArtboardSize('w', v));
  numField($('#ah'), () => state.artboard.h, v => setArtboardSize('h', v));
  $('#abLock').addEventListener('click', () => {
    state.opts.abLockCanvas = !abLocked();
    savePrefs();
    updateArtboardFields();
  });

  /* ---------- Image size… (Fireworks-style): scale the artboard and every layer together */
  const img = { w: 0, h: 0, w0: 0, h0: 0 };
  function updateImageDialog() {
    $('#iw').value = img.w;
    $('#ih').value = img.h;
    const pw = Math.round((img.w / img.w0) * 100), ph = Math.round((img.h / img.h0) * 100);
    $('#iPct').textContent = pw === ph ? `${pw}%` : `${pw}% × ${ph}%`;
  }
  function setImageField(field, v) {
    v = clamp(Math.round(v), 1, 16000);
    img[field] = v;
    if ($('#iLock').checked) {
      if (field === 'w') img.h = clamp(Math.round((v * img.h0) / img.w0), 1, 16000);
      else img.w = clamp(Math.round((v * img.w0) / img.h0), 1, 16000);
    }
    updateImageDialog();
  }
  function openImageDialog() {
    const A = state.artboard;
    img.w = img.w0 = A.w;
    img.h = img.h0 = A.h;
    updateImageDialog();
    $('#dlgImage').returnValue = '';
    $('#dlgImage').showModal();
    $('#iw').select();
  }
  numField($('#iw'), () => img.w, v => setImageField('w', v));
  numField($('#ih'), () => img.h, v => setImageField('h', v));
  $('#iLock').addEventListener('change', () => { if ($('#iLock').checked) setImageField('w', img.w); });
  function scaleImage(w, h) {
    const A = state.artboard;
    if (w === A.w && h === A.h) return;
    pushHistory();
    const sx = w / A.w, sy = h / A.h;
    for (const l of state.layers) {
      // positions and sizes scale together; pixels come from the original (non-destructive)
      resizeLayer(l, l.x * sx, l.y * sy, l.canvas.width * sx, l.canvas.height * sy);
    }
    state.sel = null;
    A.w = w;
    A.h = h;
    changed();
    toast(`Image size ${w} × ${h}`);
  }
  $('#dlgImage form').addEventListener('submit', e => {
    if (!e.submitter || e.submitter.value !== 'ok') return;
    // Pick up a value typed but not yet committed (Enter submits before the field's change event).
    for (const f of ['w', 'h']) {
      const v = evalExpr($('#i' + f).value, img[f]);
      if (!Number.isNaN(v) && Math.round(v) !== img[f]) setImageField(f, v);
    }
    scaleImage(img.w, img.h);
  });
  $('#abTransparent').addEventListener('change', e => {
    pushHistory();
    state.artboard.bg = e.target.checked ? null : $('#abBg').value;
    e.target.blur();
    changed();
  });
  // Live preview while picking; one undo step when the picker closes.
  let bgBefore;
  $('#abBg').addEventListener('input', e => {
    if (bgBefore === undefined) bgBefore = state.artboard.bg;
    state.artboard.bg = e.target.value;
    $('#abTransparent').checked = false;
    $('#abBgSwatch').classList.remove('is-transparent');
    requestRender();
  });
  $('#abBg').addEventListener('change', e => {
    const v = e.target.value;
    state.artboard.bg = bgBefore === undefined ? state.artboard.bg : bgBefore;
    bgBefore = undefined;
    if (state.artboard.bg !== v) { pushHistory(); state.artboard.bg = v; }
    e.target.blur();
    changed();
  });

  /* ---------- X / Y / W / H fields for the selected layer */
  function updateLayerFields() {
    updateArtboardFields();
    const l = scalableLayer(), box = $('#layerProps');
    box.classList.toggle('show', !!l);
    if (!l) return;
    const r = dispRect(l), base = l.src || l.canvas;
    const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    set('#lx', r.x); set('#ly', r.y); set('#lw', r.w); set('#lh', r.h);
    const pw = Math.round((r.w / base.width) * 100), ph = Math.round((r.h / base.height) * 100);
    $('#lscale').textContent = pw === ph ? `${pw}%` : `${pw}% × ${ph}%`;
    $('#btnOrig').disabled = !isScaled(l) && !l.dw;
    $('#lockRatio').classList.toggle('on', state.opts.lockRatio !== false);
    $('#lockRatio').setAttribute('aria-pressed', String(state.opts.lockRatio !== false));
  }
  function applyLayerField(field, v) {
    const l = scalableLayer();
    if (!l) return;
    const w0 = l.canvas.width, h0 = l.canvas.height, base = l.src || l.canvas, lock = state.opts.lockRatio !== false;
    if (field === 'x' || field === 'y') {
      if (l[field] === v) return;
      pushHistory();
      l[field] = v;
    } else {
      let w = field === 'w' ? Math.max(1, v) : w0, h = field === 'h' ? Math.max(1, v) : h0;
      if (lock) { // keep the original image's proportions
        if (field === 'w') h = Math.max(1, Math.round((w * base.height) / base.width));
        else w = Math.max(1, Math.round((h * base.width) / base.height));
      }
      if (w === w0 && h === h0) { updateLayerFields(); return; }
      pushHistory();
      resizeLayer(l, l.x, l.y, w, h);
    }
    changed();
  }
  for (const f of ['x', 'y', 'w', 'h']) {
    numField($('#l' + f), () => { const l = scalableLayer(); return l ? dispRect(l)[f] : 0; }, v => applyLayerField(f, v));
  }
  $('#lockRatio').addEventListener('click', () => {
    state.opts.lockRatio = state.opts.lockRatio === false;
    savePrefs();
    updateLayerFields();
  });

  let thumbCache = new WeakMap();
  /** A preview element for a layer row. The rendered preview is cached per canvas, but every
   *  row gets its own element: layers can share pixels (pasting the same copy, duplicates),
   *  and one element can only appear in one row. */
  function thumbFor(canvas) {
    const master = thumbMaster(canvas), t = makeCanvas(master.width, master.height);
    t.className = 'thumb';
    t.getContext('2d').drawImage(master, 0, 0);
    return t;
  }
  function thumbMaster(canvas) {
    let t = thumbCache.get(canvas);
    if (t) return t;
    const size = Math.round(30 * dpr);
    t = makeCanvas(size, size);
    const g = t.getContext('2d'), q = Math.max(2, Math.round(4 * dpr));
    for (let y = 0; y < size; y += q) for (let x = 0; x < size; x += q) {
      g.fillStyle = ((x + y) / q) % 2 ? colors.cb : colors.ca;
      g.fillRect(x, y, q, q);
    }
    const sc = Math.min(size / canvas.width, size / canvas.height);
    const w = canvas.width * sc, h = canvas.height * sc;
    g.imageSmoothingEnabled = sc < 1;
    g.drawImage(canvas, (size - w) / 2, (size - h) / 2, w, h);
    thumbCache.set(canvas, t);
    return t;
  }

  const EYE_ON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2l12 12M6.6 3.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.9 2.4M10.6 11.9A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.6-3"/></svg>';
  const layersEl = $('#layers');
  function renderLayers() {
    if (renaming) return;
    // Keep keyboard focus on the same row (or its eye button) when the list is rebuilt
    const fa = document.activeElement, fRow = fa && layersEl.contains(fa) ? fa.closest('.layer') : null;
    const focusId = fRow ? fRow.dataset.id : null, focusEye = !!(fa && fa.classList && fa.classList.contains('eye'));
    const focusByPointer = !!(fa && fa.classList && fa.classList.contains('pointer-focus'));
    layersEl.textContent = '';
    if (!state.layers.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'No layers yet';
      layersEl.appendChild(li);
      return;
    }
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i], li = document.createElement('li');
      li.className = 'layer' + (state.selected.has(l.id) ? ' selected' : '') + (l.id === state.active ? ' active' : '') + (l.visible ? '' : ' off');
      li.dataset.id = l.id;
      li.draggable = true;
      li.tabIndex = 0;
      li.title = `${l.canvas.width} × ${l.canvas.height} at ${l.x}, ${l.y}`;
      li.setAttribute('aria-label', l.name + (state.selected.has(l.id) ? ', selected' : '') + (l.visible ? '' : ', hidden'));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = l.name;
      const eye = document.createElement('button');
      eye.className = 'eye';
      eye.title = l.visible ? 'Hide' : 'Show';
      eye.setAttribute('aria-label', `${l.visible ? 'Hide' : 'Show'} ${l.name}`);
      eye.innerHTML = l.visible ? EYE_ON : EYE_OFF;
      li.append(thumbFor(l.canvas), name, eye);
      layersEl.appendChild(li);
    }
    if (focusId != null) {
      const row = layersEl.querySelector(`.layer[data-id="${focusId}"]`);
      const target = row && (focusEye ? row.querySelector('.eye') : row);
      // (the new row keeps how the old one got focus: a clicked row stays "clicked" after a nudge)
      if (target) { target.focus(); target.classList.toggle('pointer-focus', focusByPointer); }
    }
  }
  layersEl.setAttribute('aria-label', 'Layers');
  layersEl.addEventListener('keydown', e => {
    const li = e.target.classList && e.target.classList.contains('layer') ? e.target : null;
    if (!li || !byKeyboard(li) || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); e.stopPropagation();
    const id = +li.dataset.id;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (state.selected.has(id)) { state.selected.delete(id); if (state.active === id) state.active = [...state.selected].pop() ?? null; }
      else { state.selected.add(id); state.active = id; }
    } else selectOnly(id);
    changed();
  });

  let renaming = false;
  layersEl.addEventListener('click', e => {
    const li = e.target.closest('.layer');
    if (!li) return;
    const id = +li.dataset.id, l = getLayer(id);
    if (e.target.closest('.eye')) {
      pushHistory();
      l.visible = !l.visible;
      changed();
      return;
    }
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (state.selected.has(id)) { state.selected.delete(id); if (state.active === id) state.active = [...state.selected].pop() ?? null; }
      else { state.selected.add(id); state.active = id; }
    } else {
      selectOnly(id);
    }
    changed();
  });
  layersEl.addEventListener('contextmenu', e => {
    const li = e.target.closest('.layer');
    e.preventDefault();
    if (!li) return;
    const id = +li.dataset.id;
    if (!state.selected.has(id)) selectOnly(id); else state.active = id;
    changed();
    showMenu(layerMenu(), e.clientX, e.clientY);
  });
  // Rename: double-click the row, F2, or right-click → Rename.
  // (A click redraws the list, so the double-click's target can be a row that no longer exists —
  //  find the row under the pointer instead.)
  layersEl.addEventListener('dblclick', e => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const li = el && el.closest('#layers .layer');
    if (li && !el.closest('.eye')) startRename(+li.dataset.id);
  });
  function startRename(id) {
    const l = getLayer(id);
    const li = l && layersEl.querySelector(`.layer[data-id="${id}"]`);
    if (!li || renaming) return;
    const nameEl = li.querySelector('.name');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = l.name;
    nameEl.textContent = '';
    nameEl.appendChild(input);
    li.draggable = false; // so selecting text in the field doesn't start a row drag
    renaming = true;
    input.focus();
    input.select();
    const done = commit => {
      if (!renaming) return;
      renaming = false;
      const v = input.value.trim();
      if (commit && v && v !== l.name) { pushHistory(); l.name = v; }
      changed();
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); done(true); }
      if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      ev.stopPropagation();
    });
    input.addEventListener('mousedown', ev => ev.stopPropagation());
  }

  // Drag to reorder.
  let dragLayerId = null;
  const clearDropMarks = () => $$('.layer', layersEl).forEach(x => x.classList.remove('drop-above', 'drop-below'));
  // Drag a row out of the window → drops the layer as a PNG file (folder, Desktop, other apps).
  // The file is prepared on mouse-down so it's ready by the time the drag starts.
  // Only the row last pressed is prepared, and its blob URL is released when another is: keeping one
  // per canvas would hold a PNG of every version of every layer in memory until the app closes.
  let dragOut = null; // { canvas, url, bytes }
  // Desktop app: the drag is a real OS file drag, so it comes back into the window as a file drag.
  // nativeDragId marks it as our own layer: reorder in the Layers panel, ignore on the canvas.
  let nativeDragId = null;
  document.addEventListener('pointerdown', () => { nativeDragId = null; }, true);
  layersEl.addEventListener('pointerdown', e => {
    const li = e.target.closest('.layer'), l = li && getLayer(+li.dataset.id);
    if (!l || (dragOut && dragOut.canvas === l.canvas)) return;
    if (dragOut && dragOut.url) URL.revokeObjectURL(dragOut.url);
    const prep = dragOut = { canvas: l.canvas, url: null, bytes: null };
    canvasToBlob(prep.canvas, 'image/png').then(b => {
      if (dragOut !== prep) return; // another row was pressed meanwhile
      prep.url = URL.createObjectURL(b);
      if (Platform.isNative) b.arrayBuffer().then(buf => { if (dragOut === prep) prep.bytes = new Uint8Array(buf); });
    }, () => {});
  });
  layersEl.addEventListener('dragstart', e => {
    const li = e.target.closest('.layer');
    if (!li) return;
    dragLayerId = +li.dataset.id;
    const l = getLayer(dragLayerId);
    e.dataTransfer.effectAllowed = 'copyMove';
    if (l) {
      const name = (l.name || 'layer').replace(/[\\/:*?"<>|]/g, '-');
      const ready = dragOut && dragOut.canvas === l.canvas ? dragOut : null;
      const bytes = Platform.isNative && ready && ready.bytes;
      if (bytes) {
        e.preventDefault();
        nativeDragId = dragLayerId;
        Platform.startDragOut(`${name}.png`, bytes);
        return;
      }
      // A self-contained data URL (made once per drag): for apps like Figma that take images dragged
      // from web pages, and as the file when the prepared PNG isn't ready yet.
      const dataUrl = l.canvas.toDataURL('image/png'), url = (ready && ready.url) || dataUrl;
      // As a file: folders, the Desktop, apps that take dropped files.
      e.dataTransfer.setData('DownloadURL', `image/png:${name}.png:${url}`);
      // As a web image (what a browser attaches when you drag an <img>).
      e.dataTransfer.setData('text/uri-list', dataUrl);
      e.dataTransfer.setData('text/html', `<img src="${dataUrl}" alt="${name.replace(/"/g, '&quot;')}">`);
    }
  });
  layersEl.addEventListener('dragover', e => {
    const li = e.target.closest('.layer');
    if (nativeDragId != null) dragLayerId = nativeDragId;
    if (dragLayerId == null || !li) return;
    e.preventDefault();
    const r = li.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
    clearDropMarks();
    li.classList.add(above ? 'drop-above' : 'drop-below');
  });
  layersEl.addEventListener('dragleave', e => { if (!layersEl.contains(e.relatedTarget)) clearDropMarks(); });
  layersEl.addEventListener('drop', e => {
    const li = e.target.closest('.layer');
    clearDropMarks();
    if (dragLayerId == null || !li) return;
    e.preventDefault();
    const targetId = +li.dataset.id;
    if (targetId !== dragLayerId) {
      const r = li.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
      pushHistory();
      const moving = getLayer(dragLayerId);
      state.layers.splice(layerIndex(dragLayerId), 1);
      const ti = layerIndex(targetId);
      state.layers.splice(above ? ti + 1 : ti, 0, moving); // list is shown top-first
      changed();
    }
    dragLayerId = nativeDragId = null;
  });
  layersEl.addEventListener('dragend', () => { dragLayerId = null; clearDropMarks(); });

  /* ======================================================================
   * Boot
   * ==================================================================== */
  let booted = false;
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = stage.getBoundingClientRect();
    vc.width = Math.max(1, Math.round(r.width * dpr));
    vc.height = Math.max(1, Math.round(r.height * dpr));
    if (!booted) { booted = true; readColors(); }
    if (!state.layers.length) fitView(true); // keep an empty artboard centered as the window settles
    else if (viewFit) fitView(viewFit.capAt100); // an image just opened: keep it fitted while the window settles
    requestRender();
  }
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('resize', resize);
  // Phones and tablets (touch only, no mouse): the web version opens, but Cutout needs a mouse and keyboard
  if (!Platform.isNative && window.matchMedia('(hover: none) and (pointer: coarse)').matches)
    setTimeout(() => toast('Cutout needs a computer with a mouse and keyboard'), 600);
  // Moving the window to a monitor with different display scaling changes devicePixelRatio
  // without resizing anything — watch for it so clicks and rendering stay aligned.
  (function watchDpr() {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', () => {
      const old = dpr;
      resize();
      const k = dpr / old;
      if (!viewFit) { view.s *= k; view.ox *= k; view.oy *= k; } // keep the same zoom level on screen (a fitted view was just re-fitted)
      readColors();
      changed();
      watchDpr();
    }, { once: true });
  })();
  darkMq.addEventListener('change', () => { if ((state.opts.theme || 'system') === 'system') applyTheme(); });
  window.addEventListener('beforeunload', e => {
    if (state.layers.length && dirty) { e.preventDefault(); e.returnValue = ''; } // only with unsaved changes
  });

  readColors();
  setTool('pointer');
  changed();
  Platform.onOpenFiles(files => openFiles(files)); // desktop app: Open with, command line, second launch
  if (Platform.canReadClipboard) $('#btnPaste').hidden = false;
  if (IS_MAC) $$('[title]').forEach(el => { el.title = fmtKeys(el.title); }); // ⌘ / ⌥ / ⇧ in tooltips
  $$('svg').forEach(el => el.setAttribute('aria-hidden', 'true')); // icons are decoration: each control has a name

  // Mac menu bar (desktop app): Undo, Redo and Select all arrive here when picked from the menu,
  // or pressed while a text field has focus. In a field they edit the text; otherwise they run
  // the same shortcut as the keyboard. Cut / Copy / Paste use the system's own commands, which
  // fire the cut / copy / paste events below.
  Platform.onMenuCommand(cmd => {
    if (isTyping(document.activeElement)) { document.execCommand(cmd); return; }
    const keys = { undo: ['z', false], redo: ['z', true], selectAll: ['a', false] }[cmd];
    if (keys) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: keys[0], code: 'Key' + keys[0].toUpperCase(), metaKey: true, shiftKey: keys[1], bubbles: true, cancelable: true }));
  });
  for (const type of ['copy', 'cut']) {
    document.addEventListener(type, e => {
      if (isTyping(e.target) || document.querySelector('dialog[open]')) return; // normal text copy
      e.preventDefault();
      copy(type === 'cut');
    });
  }

  // Handy for debugging from the console.
  window.Cutout = { state, view, render, undo, redo, addImageLayer, makeCanvas, ctx2d, changed, setTool, historyBytes, compactHistory, isDirty: () => dirty };
})();
