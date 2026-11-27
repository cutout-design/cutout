/* Cutout: pastes a normal Figma copy (Ctrl+C in Figma) as an image.
 *
 * A Figma copy puts HTML on the clipboard with two hidden parts:
 *  - (figmeta): base64 JSON. fileKey, editorType, and imageHashes (image hash → download link).
 *  - (figma): base64 "fig-kiwi" binary. Magic "fig-kiwi", uint32 version, then chunks
 *    (uint32 length + bytes). Chunk 0 is the Kiwi schema (raw deflate), chunk 1 the message
 *    (zstd, or deflate in older copies). The schema travels with every copy, so nothing about
 *    Figma's format is hardcoded here except the meaning of the fields we draw.
 * The message is a flat list of nodes (nodeChanges) plus binary geometry (blobs). Figma stores
 * precomputed outlines for shapes and every text glyph, so no fonts are needed.
 *
 * Loaded on demand by app.js, after vendor/fzstd.js and vendor/kiwi.js.
 * window.CutoutFigma.render(html, { scale }) → { canvas, name } or { reason, unsupported }.
 * Anything that can't be drawn exactly is reported as unsupported and nothing is returned:
 * a slightly wrong paste is worse than asking for Copy as PNG.
 */
(() => {
  'use strict';

  /* ---------- decoding the clipboard */
  const b64 = s => Uint8Array.from(atob(s.replace(/[^A-Za-z0-9+/=]/g, '')), c => c.charCodeAt(0));
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const isZstd = b => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
  const unpack = b => (isZstd(b) ? window.fzstd.decompress(b) : inflateRaw(b));

  async function decode(html) {
    const metaM = /\(figmeta\)([\s\S]*?)\(\/figmeta\)/.exec(html), dataM = /\(figma\)([\s\S]*?)\(\/figma\)/.exec(html);
    if (!dataM) throw new Error('No Figma data');
    const meta = metaM ? JSON.parse(new TextDecoder().decode(b64(metaM[1]))) : {};
    const bin = b64(dataM[1]);
    if (new TextDecoder().decode(bin.subarray(0, 8)) !== 'fig-kiwi') throw new Error('Unknown Figma data');
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), chunks = [];
    for (let o = 12; o + 4 <= bin.length;) { const n = dv.getUint32(o, true); o += 4; chunks.push(bin.subarray(o, o + n)); o += n; }
    if (chunks.length < 2) throw new Error('Incomplete Figma data');
    const msg = kiwiDecode(window.kiwi.decodeBinarySchema(await unpack(chunks[0])), await unpack(chunks[1]));
    return { meta, msg };
  }

  /* Decodes a Kiwi message by reading the schema directly. kiwi.js's own compileSchema writes a
   * decoder as source code and runs it with new Function; the schema comes from the clipboard, and
   * Cutout's content security policy allows no generated code at all. This makes the same reads in
   * the same order as kiwi's generated decoder (checked value for value against it on real copies). */
  function kiwiDecode(schema, bytes, root = 'Message') {
    const defs = new Map(), enums = new Map(), tags = new Map();
    for (const d of schema.definitions) {
      defs.set(d.name, d);
      if (d.kind === 'ENUM') enums.set(d.name, new Map(d.fields.map(f => [f.value, f.name])));
      else if (d.kind === 'MESSAGE') { const m = new Map(); for (const f of d.fields) if (!m.has(f.value)) m.set(f.value, f); tags.set(d.name, m); }
    }
    const n = bytes.length, f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer), B7 = BigInt(7), B1 = BigInt(1);
    let o = 0;
    const byte = () => { if (o >= n) throw new Error('Index out of bounds'); return bytes[o++]; };
    const varUint = () => { let v = 0, sh = 0, b; do { b = byte(); v |= (b & 127) << sh; sh += 7; } while (b & 128 && sh < 35); return v >>> 0; };
    const varInt = () => { const v = varUint() | 0; return v & 1 ? ~(v >>> 1) : v >>> 1; };
    const varFloat = () => {
      const b = byte(); if (b === 0) return 0;
      if (o + 3 > n) throw new Error('Index out of bounds');
      let bits = b | bytes[o] << 8 | bytes[o + 1] << 16 | bytes[o + 2] << 24; o += 3;
      bits = bits << 23 | bits >>> 9; i32[0] = bits; return f32[0];
    };
    const varUint64 = () => { let v = BigInt(0), sh = BigInt(0), b; while ((b = byte()) & 128 && sh < 56) { v |= BigInt(b & 127) << sh; sh += B7; } return v | BigInt(b) << sh; };
    const varInt64 = () => { const v = varUint64(), odd = v & B1, h = v >> B1; return odd ? ~h : h; };
    const string = () => {
      let s = '';
      for (;;) {
        let c; const a = byte();
        if (a < 192) c = a;
        else { const b = byte(); if (a < 224) c = (a & 31) << 6 | b & 63; else { const d = byte(); if (a < 240) c = (a & 15) << 12 | (b & 63) << 6 | d & 63; else { const e = byte(); c = (a & 7) << 18 | (b & 63) << 12 | (d & 63) << 6 | e & 63; } } }
        if (c === 0) break;
        if (c < 65536) s += String.fromCharCode(c); else { c -= 65536; s += String.fromCharCode((c >> 10) + 55296, (c & 1023) + 56320); }
      }
      return s;
    };
    const byteArray = () => { const len = varUint(), end = o + len; if (end > n) throw new Error('Read array out of bounds'); const out = bytes.slice(o, end); o = end; return out; };
    const NATIVE = { bool: () => !!byte(), byte, int: varInt, uint: varUint, float: varFloat, string, int64: varInt64, uint64: varUint64 };
    const value = type => {
      const read = NATIVE[type]; if (read) return read();
      const d = defs.get(type); if (!d) throw new Error(`Invalid type ${type}`);
      return d.kind === 'ENUM' ? enums.get(type).get(varUint()) : object(d);
    };
    const field = f => {
      if (!f.isArray) return value(f.type);
      if (f.type === 'byte') return byteArray();
      const len = varUint(), out = Array(len);
      for (let i = 0; i < len; i++) out[i] = value(f.type);
      return out;
    };
    function object(d) {
      const result = {};
      if (d.kind !== 'MESSAGE') { for (const f of d.fields) result[f.name] = field(f); return result; } // struct: every field, in order
      for (const byTag = tags.get(d.name);;) {
        const tag = varUint(); if (tag === 0) return result;
        const f = byTag.get(tag); if (!f) throw new Error('Attempted to parse invalid message');
        result[f.name] = field(f);
      }
    }
    const top = defs.get(root);
    if (!top || top.kind === 'ENUM') throw new Error('Unknown Figma data');
    return object(top);
  }

  const hex = bytes => Array.from(bytes || [], b => b.toString(16).padStart(2, '0')).join('');
  /** Downloads the images the copy uses. Returns a Map hash → ImageBitmap. Images that can't be
   *  downloaded (offline, expired link) are left out; a file that downloads but can't be decoded maps
   *  to null and is drawn empty, as Figma does. Images whose fill says not to color manage keep their
   *  pixel values as they are (Figma ignores their color profile, so a wide-gamut file looks duller). */
  async function loadImages(urls, hashes, unmanaged) {
    const out = new Map();
    await Promise.all([...hashes].map(async h => {
      const url = urls[h];
      if (!url) return;
      let blob;
      // A stalled download gives up after 20 s (then the paste asks for Copy as PNG)
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
        if (!res.ok) return;
        blob = await res.blob();
      } catch (_) { return; } finally { clearTimeout(timer); }
      try { out.set(h, await createImageBitmap(blob, unmanaged.has(h) ? { colorSpaceConversion: 'none' } : {})); } catch (_) { out.set(h, null); }
    }));
    return out;
  }

  /* ---------- drawing */
  const BLEND = { MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten', COLOR_DODGE: 'color-dodge', COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity' };
  // Blend modes canvas doesn't have: done pixel by pixel (separable blend, W3C compositing formula)
  const PIXEL_BLEND = { LINEAR_BURN: (b, s) => Math.max(0, b + s - 1), LINEAR_DODGE: (b, s) => Math.min(1, b + s) };
  const NORMAL_BLEND = ['PASS_THROUGH', 'NORMAL', undefined];
  // Layer types Cutout draws (BRUSH is deliberately missing: brush definitions only appear as
  // strokes, and drawing one directly means something unexpected was copied).
  const NODE_TYPES = ['FRAME', 'GROUP', 'ROUNDED_RECTANGLE', 'RECTANGLE', 'VECTOR', 'ELLIPSE', 'STAR', 'REGULAR_POLYGON', 'LINE', 'INSTANCE', 'SYMBOL', 'SECTION', 'TEXT', 'TEXT_PATH', 'BOOLEAN_OPERATION', 'STICKY', 'SHAPE_WITH_TEXT', 'CONNECTOR', 'CODE_BLOCK', 'TABLE', 'HIGHLIGHT', 'STAMP', 'WIDGET', 'CANVAS', 'DOCUMENT'];
  const EFFECTS = ['DROP_SHADOW', 'INNER_SHADOW', 'BACKGROUND_BLUR', 'FOREGROUND_BLUR'];
  // Layer and background blur need the canvas `filter` (Safari's WebKit has lacked it): without it,
  // refuse rather than paste the layer unblurred. Shadows use shadowBlur, which works everywhere.
  const CAN_BLUR = 'filter' in document.createElement('canvas').getContext('2d');
  const PAINTS = ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE', 'PATTERN'];
  /* ---------- safety net
   * Figma adds features as new fields. Any field Cutout doesn't know (and that has a value) makes the
   * paste refuse, so a new feature can't be silently skipped. Fields listed here are either drawn,
   * or have no effect on the picture (layout, prototyping, publishing, text settings already baked
   * into the glyph outlines…). */
  const words = s => new Set(s.split(/\s+/).filter(Boolean));
  const KNOWN = {
    node: words(`guid parentIndex phase type name visible opacity blendMode transform size mask maskType
      fillPaints strokePaints strokeWeight strokeAlign strokeCap strokeJoin miterLimit dashPattern effects
      cornerRadius rectangleTopLeftCornerRadius rectangleTopRightCornerRadius rectangleBottomLeftCornerRadius
      rectangleBottomRightCornerRadius rectangleCornerRadiiIndependent cornerSmoothing
      borderStrokeWeightsIndependent borderTopWeight borderRightWeight borderBottomWeight borderLeftWeight bordersTakeSpace
      fillGeometry strokeGeometry vectorData arcData count starInnerScale booleanOperation resizeToFit frameMaskDisabled
      symbolData derivedSymbolData overriddenSymbolID overrideLevel guidPath overrideKey detachedSymbolId
      derivedTextData textData styleIdForFill styleIdForStrokeFill styleIdForEffect styleIdForText styleIdForGrid styleType
      nodeGenerationData derivedImmutableFrameData internalOnly backgroundEnabled backgroundOpacity backgroundColor
      key description styleDescription locked sortPosition autoRename isSoftDeleted hyperlink emojiImageSet
      horizontalConstraint verticalConstraint proportionsConstrained targetAspectRatio minSize maxSize
      shapeUserHeight shapeTruncates shapeWithTextType stickyHasShadow handoffStatusMap annotations
      exportSettings pluginData pluginRelaunchData parameterConsumptionMap ariaRole accessibleLabel
      derivedSymbolDataLayoutVersion vectorOperationVersion editInfo isPageDivider canvasGuides guides
      detachOpticalSizeFromFontSize hangingList hangingPunctuation listSpacing leadingTrim lineHeight letterSpacing
      paragraphIndent paragraphSpacing toggledOnOTFeatures toggledOffOTFeatures styleID maxLines
      componentKey componentPropDefs componentPropRefs componentPropAssignments propsAreBubbled
      symbolLinks isSlot isSlotContent slotContent cooperTemplateData
      isStrokePaintDerived codeBlockLanguage codeBlockTheme derivedImmutableFrameDataVersion
      tableRowPositions tableColumnPositions tableRowHeights tableColumnWidths
      stampData widgetSyncedState renderedSyncedState widgetMetadata widgetCachedAncestor widgetHoverStyle
      widgetEvents widgetPropertyMenuItems widgetInputBehavior isWidgetStickable shouldHideCursorsOnWidgetHover
      textAlignHorizontal textAlignVertical textAutoResize textBidiVersion textCase textData textDecoration
      textDecorationSkipInk textDecorationStyle textExplicitLayoutVersion textPathStart textTracking textTruncation
      textUserLayoutVersion fontName fontSize fontVariantCaps fontVariantCommonLigatures fontVariantContextualLigatures
      fontVariantDiscretionaryLigatures fontVariantHistoricalLigatures fontVariantNumericFigure fontVariantNumericFraction
      fontVariantNumericSpacing fontVariantOrdinal fontVariantPosition fontVariantSlashedZero fontVariations fontVersion
      stackChildAlignSelf stackChildPrimaryGrow stackCounterAlignItems stackCounterSizing stackCounterSpacing
      stackHorizontalPadding stackLayoutVersion stackMode stackPaddingBottom stackPaddingRight stackPositioning
      stackPrimaryAlignItems stackPrimarySizing stackReverseZIndex stackSpacing stackVerticalPadding stackWrap
      connectorControlPoints connectorEnd connectorEndCap connectorLineStyle connectorStart connectorStartCap
      connectorType connectorVersion gridColumnAnchor gridRowAnchor scrollBehavior scrollDirection
      variableConsumptionMap variableModeBySetMap`),
    // Prefixes of metadata that can't change the picture (prototyping, publishing, export settings,
    // versions, layout guides). Anything drawable is listed field by field above: a broad prefix
    // once hid variable modes (Dark pasted as Light), and before that component properties.
    nodePrefix: /^(layoutGrid|prototype|interaction|transition|variant|stateGroup|sharedSymbol|symbolDescription|publish|source|version|userFacing|isPublishable|isSymbolPublishable|isStateGroup|export|dev|measurement)/,
    paint: words(`type color opacity visible blendMode stops transform image imageThumbnail animationFrame imageScaleMode
      imageShouldColorManage animatedImage rotation scale paintFilter originalImageWidth originalImageHeight opacityVar colorVar
      imageVar stopsVar gradientVar paintVar thumbHashBase64 thumbHash id altText sourceNodeId componentPropAssignments
      authoredColor authoredStops interpolationHueMethod interpolationColorSpace
      sourceNodeId spacing patternSpacing patternTileType verticalAlignment horizontalAlignment`),
    effect: words(`type offset radius visible blendMode spread showShadowBehindNode radiusVar colorVar spreadVar xVar yVar
      color authoredColor id effectOpacityVar componentPropAssignments blurOpType`),
    text: words(`layoutSize baselines glyphs decorations fontMetaData hyperlinkBoxes truncationStartIndex truncatedHeight
      logicalIndexToCharacterOffsetMap derivedLines mentionBoxes`),
    glyph: words('commandsBlob position styleID fontSize firstCharacter advance rotation emojiImageSet'),
  };
  /** True if a field holds something (false, 0, empty and "default" values don't count). */
  const hasValue = v => !(v == null || v === false || v === 0 || v === '' || v === 'DEFAULT' || v === 'NORMAL' || v === 'NONE' || (Array.isArray(v) && !v.length)
    || (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) && !Object.keys(v).length));
  /** Lists the fields of obj Cutout doesn't know. */
  const unknownFields = (obj, known, prefix) => Object.keys(obj || {}).filter(k => !known.has(k) && !(prefix && prefix.test(k)) && hasValue(obj[k]));

  const css = (col, o = 1) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${(col.a ?? 1) * o})`;
  const invert = t => { const det = t.m00 * t.m11 - t.m01 * t.m10, i00 = t.m11 / det, i01 = -t.m01 / det, i10 = -t.m10 / det, i11 = t.m00 / det; return { i00, i01, i10, i11, i02: -(i00 * t.m02 + i01 * t.m12), i12: -(i10 * t.m02 + i11 * t.m12) }; };
  const key = g => (g ? `${g.sessionID}:${g.localID}` : null);
  const visibleEffects = n => (n.effects || []).filter(e => e.visible !== false);

  /** Collects the image hashes a node list uses (to download them before drawing). */
  function imageHashesIn(value, out = new Set(), seen = new Set(), unmanaged = null) {
    if (!value || typeof value !== 'object' || seen.has(value) || value instanceof Uint8Array) return out;
    seen.add(value);
    if (value.type === 'IMAGE' && value.image && value.image.hash) {
      out.add(hex(value.image.hash));
      if (unmanaged && value.imageShouldColorManage === false) unmanaged.add(hex(value.image.hash));
    }
    for (const v of Array.isArray(value) ? value : Object.values(value)) imageHashesIn(v, out, seen, unmanaged);
    return out;
  }

  function draw(msg, imgs, scale, strict = true) {
    const unsupported = new Set(), missingImages = new Set();
    const nope = what => unsupported.add(what);
    const blobs = (msg.blobs || []).map(b => b.bytes);
    const nodes = new Map(), kids = new Map();
    for (const n of msg.nodeChanges || []) nodes.set(key(n.guid), n);
    for (const n of msg.nodeChanges || []) {
      const p = n.parentIndex && key(n.parentIndex.guid);
      if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
    }
    for (const list of kids.values()) list.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : a.parentIndex.position > b.parentIndex.position ? 1 : 0));
    const page = (msg.nodeChanges || []).find(n => n.type === 'CANVAS' && !n.internalOnly);
    const roots = page ? (kids.get(key(page.guid)) || []).filter(n => n.visible !== false) : [];
    if (!roots.length) return { reason: 'empty' };

    // Bounds of the copied layers, like Copy as PNG: their boxes plus room for shadows, blur and
    // outside strokes, and content that sticks out of frames that don't clip (groups, unclipped frames).
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ident = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
    const mul = (A, B) => ({ m00: A.m00 * B.m00 + A.m01 * B.m10, m01: A.m00 * B.m01 + A.m01 * B.m11, m02: A.m00 * B.m02 + A.m01 * B.m12 + A.m02,
      m10: A.m10 * B.m00 + A.m11 * B.m10, m11: A.m10 * B.m01 + A.m11 * B.m11, m12: A.m10 * B.m02 + A.m11 * B.m12 + A.m12 });
    const addBounds = (n, parentM, depth) => {
      if (n.visible === false || n.type === 'SLICE' || depth > 80) return;
      const M = mul(parentM, n.transform || ident), w = n.size ? n.size.x : 0, h = n.size ? n.size.y : 0;
      let ex0 = 0, ey0 = 0, ex1 = 0, ey1 = 0;
      const grow = (a, b, c, d) => { ex0 = Math.max(ex0, a); ey0 = Math.max(ey0, b); ex1 = Math.max(ex1, c); ey1 = Math.max(ey1, d); };
      for (const e of visibleEffects(n)) {
        if (e.type === 'DROP_SHADOW') {
          const r = (e.radius || 0) + Math.max(0, e.spread || 0), ox = e.offset ? e.offset.x : 0, oy = e.offset ? e.offset.y : 0;
          grow(r - ox, r - oy, r + ox, r + oy);
        } else if (e.type === 'FOREGROUND_BLUR') { const r = e.radius || 0; grow(r, r, r, r); }
      }
      // FigJam's Copy as PNG leaves 40 px of empty space around a copied section
      if (depth === 0 && n.type === 'SECTION' && msg.pasteEditorType === 'WHITEBOARD') grow(40, 40, 40, 40);
      // FigJam objects keep their stroke in their style data (part 40000000:0), e.g. a connector's line
      const look = n.nodeGenerationData && (n.nodeGenerationData.overrides || []).find(o => o.guidPath && o.guidPath.guids && o.guidPath.guids.length === 1 && o.guidPath.guids[0].sessionID === 40000000 && o.guidPath.guids[0].localID === 0);
      if (n.type === 'CONNECTOR' && look && look.strokeWeight && (look.strokePaints || []).some(p => p.visible !== false)) { const o = look.strokeWeight / 2; grow(o, o, o, o); }
      if ((n.strokePaints || []).some(p => p.visible !== false) && n.strokeWeight) {
        const o = n.strokeAlign === 'OUTSIDE' ? n.strokeWeight : n.strokeAlign === 'INSIDE' && n.type !== 'LINE' ? 0 : n.strokeWeight / 2;
        grow(o, o, o, o);
      }
      for (const [px, py] of [[-ex0, -ey0], [w + ex1, -ey0], [-ex0, h + ey1], [w + ex1, h + ey1]]) {
        const X = M.m00 * px + M.m01 * py + M.m02, Y = M.m10 * px + M.m11 * py + M.m12;
        x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
      }
      const clips = ['FRAME', 'INSTANCE', 'SYMBOL'].includes(n.type) && !n.resizeToFit && n.frameMaskDisabled === false;
      if (clips || n.type === 'TEXT' || n.type === 'BOOLEAN_OPERATION') return;
      const sym = n.type === 'INSTANCE' && n.symbolData && nodes.get(key(n.symbolData.symbolID));
      for (const c of kids.get(key(sym ? sym.guid : n.guid)) || []) addBounds(c, M, depth + 1);
    };
    for (const r of roots) addBounds(r, ident, 0);
    // Figma rounds the edges to the nearest pixel (a half-pixel stroke edge at .5 goes up)
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const W = Math.max(1, Math.round((x1 - x0) * scale)), H = Math.max(1, Math.round((y1 - y0) * scale));
    if (W * H > 16384 * 16384 / 2) return { reason: 'size', unsupported: ['very large copy'] };
    const makeCanvas = () => { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; return cv; };
    const c = makeCanvas();
    let g = c.getContext('2d');
    g.scale(scale, scale); g.translate(-x0, -y0);

    /* Scratch layers are full-size canvases (a big FigJam board makes each one hundreds of MB), so
     * they're recycled: take() hands out a cleared one, give() returns it once nothing uses it. */
    const pool = [];
    const take = () => { const cv = pool.pop(); if (!cv) return makeCanvas(); cv.getContext('2d').reset(); return cv; };
    const give = (...cvs) => { for (const cv of cvs) if (cv && cv !== c && !pool.includes(cv) && pool.length < 6) pool.push(cv); };
    // Run fn drawing into a cleared full-size layer (same transform), return the layer canvas.
    function offscreen(fn) {
      const main = g, layer = take();
      g = layer.getContext('2d'); g.setTransform(main.getTransform());
      try { fn(); } finally { g = main; }
      return layer;
    }
    // Composites a layer onto the current canvas, keeping the opacity of the groups it sits in.
    function putLayer(layer, op = 'source-over', alpha = g.globalAlpha, filter = 'none') {
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = alpha; g.globalCompositeOperation = op; g.filter = filter; g.drawImage(layer, 0, 0); g.restore();
    }
    /** Blends layer into the current canvas with a per-channel blend function f(backdrop, source). */
    function blendPixels(layer, f, alpha) {
      const tg = g.canvas.getContext('2d'), W2 = g.canvas.width, H2 = g.canvas.height;
      const dst = tg.getImageData(0, 0, W2, H2), src = layer.getContext('2d').getImageData(0, 0, W2, H2), D = dst.data, S = src.data;
      for (let k = 0; k < D.length; k += 4) {
        const as = S[k + 3] / 255 * alpha;
        if (!as) continue;
        const ab = D[k + 3] / 255, ao = as + ab * (1 - as);
        for (let ch = 0; ch < 3; ch++) {
          const cs = S[k + ch] / 255, cb = D[k + ch] / 255;
          const co = as * (1 - ab) * cs + as * ab * f(cb, cs) + (1 - as) * ab * cb;
          D[k + ch] = Math.round(co / ao * 255);
        }
        D[k + 3] = Math.round(ao * 255);
      }
      tg.putImageData(dst, 0, 0);
    }
    const maskWith = (layer, mask) => { const lg = layer.getContext('2d'); lg.save(); lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalCompositeOperation = 'destination-in'; lg.drawImage(mask, 0, 0); lg.restore(); };

    /* geometry */
    function commandsPath(b, m) {
      const p = new Path2D();
      if (!b) { nope('missing outline'); return p; }
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), N = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
      let o = 0;
      while (o < b.byteLength) {
        const cmd = dv.getUint8(o++), a = [];
        if (!(cmd in N)) { nope('unknown path command'); break; }
        for (let i = 0; i < N[cmd]; i++) { a.push(dv.getFloat32(o, true)); o += 4; }
        const pt = i => m(a[i], a[i + 1]);
        if (cmd === 0) p.closePath(); else if (cmd === 1) p.moveTo(...pt(0)); else if (cmd === 2) p.lineTo(...pt(0)); else if (cmd === 3) p.quadraticCurveTo(...pt(0), ...pt(2)); else p.bezierCurveTo(...pt(0), ...pt(2), ...pt(4));
      }
      return p;
    }
    function vectorPath(n) {
      const b = blobs[n.vectorData.vectorNetworkBlob];
      if (!b) { nope('missing vector'); return { path: new Path2D() }; }
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let o = 0;
      const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; }, f32 = () => { const v = dv.getFloat32(o, true); o += 4; return v; };
      const nv = u32(), ns = u32(), nr = u32(), V = [], S = [];
      for (let i = 0; i < nv; i++) V.push({ style: u32(), x: f32(), y: f32() }); // style: entry in vectorData.styleOverrideTable
      const styles = new Map((n.vectorData.styleOverrideTable || []).map(st => [st.styleID, st]));
      for (let i = 0; i < ns; i++) { u32(); S.push({ a: u32(), ax: f32(), ay: f32(), e: u32(), ex: f32(), ey: f32() }); }
      const ns0 = n.vectorData.normalizedSize || n.size, sx = n.size.x / (ns0.x || 1), sy = n.size.y / (ns0.y || 1);
      const p = new Path2D(), dash = [];
      let rule = 'nonzero';
      const flip = s => ({ a: s.e, ax: s.ex, ay: s.ey, e: s.a, ex: s.ax, ey: s.ay });
      const pts = s => [[V[s.a].x * sx, V[s.a].y * sy], [(V[s.a].x + s.ax) * sx, (V[s.a].y + s.ay) * sy], [(V[s.e].x + s.ex) * sx, (V[s.e].y + s.ey) * sy], [V[s.e].x * sx, V[s.e].y * sy]];
      let sub = null; // current subpath, for dashes: { path, segs: [length...] }
      const begin = s => { sub = { path: new Path2D(), segs: [], verts: [s.a], curved: false }; dash.push(sub); const [a] = pts(s); sub.path.moveTo(...a); p.moveTo(...a); };
      const addSeg = s => { const [, c1, c2, e] = pts(s); sub.path.bezierCurveTo(...c1, ...c2, ...e); p.bezierCurveTo(...c1, ...c2, ...e); sub.segs.push(cubicLength(...pts(s))); sub.verts.push(s.e); if (s.ax || s.ay || s.ex || s.ey) sub.curved = true; };
      // Rounded corners (cornerRadius on the layer or per point): drawn for straight-line paths
      const radiusAt = v => { const st = styles.get(V[v].style); return (st && st.cornerRadius) ?? n.cornerRadius ?? 0; };
      const rounded = () => {
        if (!dash.some(sp => sp.verts.some(v => radiusAt(v) > 0))) return null;
        if (dash.some(sp => sp.curved && sp.verts.some(v => radiusAt(v) > 0))) { nope('rounded corners on a curved pen path'); return null; }
        if (n.dashPattern && n.dashPattern.some(v => v > 0)) nope('dashes on a rounded pen path');
        const q = new Path2D();
        for (const sp of dash) {
          const closed = sp.verts.length > 2 && sp.verts[0] === sp.verts[sp.verts.length - 1];
          const vs = closed ? sp.verts.slice(0, -1) : sp.verts;
          const P = vs.map(v => [V[v].x * sx, V[v].y * sy]), R = vs.map((v, i) => (!closed && (i === 0 || i === vs.length - 1) ? 0 : radiusAt(v)));
          sp.path = roundedPolyline(P, R, closed); q.addPath(sp.path);
        }
        return q;
      };
      if (nr === 0) { // open paths: segments chained into strokes where they connect
        let last = null;
        for (const s0 of S) { let s = s0; if (last !== null && s.e === last && s.a !== last) s = flip(s); if (s.a !== last) begin(s); addSeg(s); last = s.e; }
        // Ends (vertices with one segment) and the direction pointing out of the path there, for line-end caps
        const deg = V.map(() => 0); for (const s of S) { deg[s.a]++; deg[s.e]++; }
        const ends = [];
        for (const s of S) for (const [v, tx, ty, other] of [[s.a, s.ax, s.ay, s.e], [s.e, s.ex, s.ey, s.a]]) {
          if (deg[v] !== 1) continue;
          let ux = -tx * sx, uy = -ty * sy;
          if (Math.hypot(ux, uy) < 1e-6) { ux = (V[v].x - V[other].x) * sx; uy = (V[v].y - V[other].y) * sy; }
          const l = Math.hypot(ux, uy) || 1;
          const own = styles.get(V[v].style);
          ends.push({ x: V[v].x * sx, y: V[v].y * sy, ux: ux / l, uy: uy / l, cap: (own && own.strokeCap) || n.strokeCap || 'NONE' });
        }
        const rp = rounded();
        return { path: rp || p, rule, open: true, ends, dash };
      }
      for (let r = 0; r < nr; r++) {
        rule = (u32() & 1) ? 'nonzero' : 'evenodd';
        const loops = u32();
        for (let l = 0; l < loops; l++) {
          const cnt = u32(), segs = [];
          for (let i = 0; i < cnt; i++) segs.push(S[u32()]);
          let cur = null;
          segs.forEach((s0, i) => {
            let s = s0;
            if (i === 0) {
              const nx = segs[1];
              if (nx && (s.a === nx.a || s.a === nx.e) && !(s.e === nx.a || s.e === nx.e)) s = flip(s);
              begin(s);
            } else if (s.a !== cur) s = flip(s);
            addSeg(s); cur = s.e;
          });
          p.closePath(); if (sub) sub.path.closePath();
        }
      }
      const rp = rounded();
      return { path: rp || p, rule, dash };
    }
    /* A polyline / polygon with each point rounded by a circle of its radius R[i] that touches both
     * edges; an edge too short for its two corners shrinks both (as Figma does for stars and pen paths). */
    function roundedPolyline(P, R, closed) {
      const N = P.length, p = new Path2D(), len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      const at = i => P[(i + N) % N];
      const angle = i => { const prev = at(i - 1), cur = P[i], next = at(i + 1), v1 = [prev[0] - cur[0], prev[1] - cur[1]], v2 = [next[0] - cur[0], next[1] - cur[1]];
        return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1)))); };
      const corner = i => (closed || (i > 0 && i < N - 1)) && R[i] > 0 && angle(i) > 1e-3 && angle(i) < Math.PI - 1e-3;
      const need = P.map((_, i) => (corner(i) ? R[i] / Math.tan(angle(i) / 2) : 0));
      const edges = closed ? N : N - 1;
      const scale = Array.from({ length: edges }, (_, i) => Math.min(1, len(P[i], at(i + 1)) / ((need[i] + need[(i + 1) % N]) || 1)));
      const rad = P.map((_, i) => (corner(i) ? R[i] * Math.min(scale[i] ?? 1, scale[(i - 1 + edges) % edges] ?? 1) : 0));
      const towards = (a, b, d) => { const l = len(a, b) || 1; return [a[0] + (b[0] - a[0]) * d / l, a[1] + (b[1] - a[1]) * d / l]; };
      if (closed) { const t = corner(N - 1) ? rad[N - 1] / Math.tan(angle(N - 1) / 2) : 0; p.moveTo(...towards(P[N - 1], P[0], t)); }
      else p.moveTo(...P[0]);
      for (let i = closed ? 0 : 1; i < N; i++) {
        if (corner(i)) p.arcTo(P[i][0], P[i][1], ...at(i + 1), rad[i]); else p.lineTo(...P[i]);
      }
      if (closed) p.closePath();
      return p;
    }
    function cubicLength(a, b, c, d) {
      let L = 0, px = a[0], py = a[1];
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, u = 1 - t;
        const x = u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], y = u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1];
        L += Math.hypot(x - px, y - py); px = x; py = y;
      }
      return L;
    }
    function ellipseArc(n) {
      const w = n.size.x, h = n.size.y, rx = w / 2, ry = h / 2, a = n.arcData || { startingAngle: 0, endingAngle: Math.PI * 2, innerRadius: 0 };
      const p = new Path2D(), full = Math.abs(a.endingAngle - a.startingAngle) >= Math.PI * 2 - 1e-4, ir = a.innerRadius || 0;
      if (full) {
        p.ellipse(rx, ry, rx, ry, 0, 0, Math.PI * 2);
        if (ir) p.ellipse(rx, ry, rx * ir, ry * ir, 0, Math.PI * 2, 0, true);
        // For dashes: Figma's ellipse is 4 curves (quarters), starting at the right
        const perimeter = (A, B) => Math.PI * (3 * (A + B) - Math.sqrt((3 * A + B) * (A + 3 * B)));
        const ring = (A, B, ccw) => { const q = new Path2D(); q.ellipse(rx, ry, A, B, 0, ccw ? Math.PI * 2 : 0, ccw ? 0 : Math.PI * 2, ccw); return { path: q, segs: Array(4).fill(perimeter(A, B) / 4) }; };
        return { path: p, rule: 'evenodd', dash: ir ? [ring(rx, ry), ring(rx * ir, ry * ir, true)] : [ring(rx, ry)] };
      }
      p.ellipse(rx, ry, rx, ry, 0, a.startingAngle, a.endingAngle);
      if (ir) p.ellipse(rx, ry, rx * ir, ry * ir, 0, a.endingAngle, a.startingAngle, true); else p.lineTo(rx, ry);
      p.closePath();
      return { path: p };
    }
    function polygonPath(n, star) {
      const w = n.size.x, h = n.size.y, cnt = n.count || (star ? 5 : 3), p = new Path2D(), inner = star ? (n.starInnerScale ?? 0.38) : 1;
      const pts = star ? cnt * 2 : cnt, unit = [];
      for (let i = 0; i < pts; i++) { const ang = -Math.PI / 2 + i * Math.PI * 2 / pts, r = star && i % 2 ? inner : 1; unit.push([Math.cos(ang) * r, Math.sin(ang) * r]); }
      // The points sit on the ellipse inside the layer box (so a star doesn't reach the bottom edge)
      const P = unit.map(([x, y]) => [w / 2 + x * w / 2, h / 2 + y * h / 2]);
      const r = n.cornerRadius || 0;
      const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!r) { P.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return { path: p, dash: [{ path: p, segs: P.map((q, i) => dist(q, P[(i + 1) % P.length])) }] }; }
      // Rounded corners: a circle of radius r touching both edges at every point. Each corner needs
      // r / tan(angle / 2) of both its edges; where an edge is too short for its two corners, both shrink.
      const N = P.length, len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      const angle = i => {
        const prev = P[(i + N - 1) % N], cur = P[i], next = P[(i + 1) % N];
        const v1 = [prev[0] - cur[0], prev[1] - cur[1]], v2 = [next[0] - cur[0], next[1] - cur[1]];
        return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2)))));
      };
      const need = P.map((_, i) => r / Math.tan(angle(i) / 2));
      const edgeScale = P.map((_, i) => Math.min(1, len(P[i], P[(i + 1) % N]) / (need[i] + need[(i + 1) % N]))); // edge i → i+1
      const radius = P.map((_, i) => r * Math.min(edgeScale[i], edgeScale[(i + N - 1) % N]));
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      // Start where the last corner's curve ends (an arc's start can be past an edge's middle)
      const last = P[N - 1], tl = radius[N - 1] / Math.tan(angle(N - 1) / 2), el = len(last, P[0]);
      p.moveTo(last[0] + (P[0][0] - last[0]) * tl / el, last[1] + (P[0][1] - last[1]) * tl / el);
      for (let i = 0; i < N; i++) p.arcTo(P[i][0], P[i][1], ...mid(P[i], P[(i + 1) % N]), radius[i]);
      p.closePath();
      // For dashes: each edge's straight part, then each corner's arc
      const tan = i => radius[i] / Math.tan(angle(i) / 2), segs = [];
      for (let i = 0; i < N; i++) { segs.push(len(P[(i + N - 1) % N], P[i]) - tan((i + N - 1) % N) - tan(i)); segs.push(radius[i] * (Math.PI - angle(i))); }
      return { path: p, dash: [{ path: p, segs }] };
    }
    function shapeOf(n) {
      const w = n.size.x, h = n.size.y;
      switch (n.type) {
        case 'VECTOR': case 'HIGHLIGHT': return n.vectorData ? vectorPath(n) : { path: new Path2D() };
        case 'ELLIPSE': return ellipseArc(n);
        case 'STAR': return polygonPath(n, true);
        case 'REGULAR_POLYGON': return polygonPath(n, false);
        case 'LINE': {
          // Figma draws a line's stroke on top of the line (its bottom edge on y = 0), not centered on it.
          // Arrow ends: two arms 5 × the stroke weight long at 45°, with the line pulled in by half a stroke.
          const sw = n.strokeWeight || 0, y = -sw / 2, p = new Path2D();
          p.moveTo(0, y); p.lineTo(w, y);
          return { path: p, open: true, ends: [{ x: 0, y, ux: -1, uy: 0 }, { x: w, y, ux: 1, uy: 0 }], dash: [{ path: p, segs: [w] }] };
        }
        default: {
          const p = new Path2D();
          const r = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius]
            .map(v => Math.max(0, Math.min(v ?? n.cornerRadius ?? 0, w / 2, h / 2)));
          if (n.cornerSmoothing > 0 && r.some(Boolean)) return { path: smoothRect(w, h, r, n.cornerSmoothing) };
          p.roundRect(0, 0, w, h, r);
          // For dashes: top, top-right corner, right... in the order roundRect draws them
          const [tl, tr, br, bl] = r, q = Math.PI / 2;
          return { path: p, dash: [{ path: p, segs: [w - tl - tr, q * tr, h - tr - br, q * br, w - br - bl, q * bl, h - bl - tl, q * tl] }] };
        }
      }
    }
    /* Figma's smooth corners ("corner smoothing", iOS-style squircles). Same construction as Figma's
     * published method: each corner is a short circular arc joined to the straight edges by two
     * Bézier curves, spread over a length p = (1 + smoothing) × radius, limited to half the shorter side.
     * r: radii [top-left, top-right, bottom-right, bottom-left]. */
    function smoothRect(w, h, r, smoothing) {
      const budget = Math.min(w, h) / 2, rad = d => d * Math.PI / 180;
      const corner = R => {
        if (!R) return { a: 0, b: 0, c: 0, d: 0, p: 0, L: 0, R: 0 };
        R = Math.min(R, budget);
        const sm = Math.min(smoothing, budget / R - 1), p = Math.min((1 + smoothing) * R, budget);
        const arc = 90 * (1 - sm), L = Math.sin(rad(arc / 2)) * R * Math.SQRT2;
        const alpha = (90 - arc) / 2, p34 = R * Math.tan(rad(alpha / 2)), beta = 45 * sm;
        const c = p34 * Math.cos(rad(beta)), d = c * Math.tan(rad(beta)), b = (p - L - c - d) / 3;
        return { a: 2 * b, b, c, d, p, L, R };
      };
      const [tl, tr, br, bl] = r.map(corner);
      const arcCmd = (k, dx, dy) => (k.R ? `a ${k.R} ${k.R} 0 0 1 ${dx} ${dy}` : '');
      const d = [
        `M ${w - tr.p} 0`,
        `c ${tr.a} 0 ${tr.a + tr.b} 0 ${tr.a + tr.b + tr.c} ${tr.d}`, arcCmd(tr, tr.L, tr.L), `c ${tr.d} ${tr.c} ${tr.d} ${tr.b + tr.c} ${tr.d} ${tr.a + tr.b + tr.c}`,
        `L ${w} ${h - br.p}`,
        `c 0 ${br.a} 0 ${br.a + br.b} ${-br.d} ${br.a + br.b + br.c}`, arcCmd(br, -br.L, br.L), `c ${-br.c} ${br.d} ${-(br.b + br.c)} ${br.d} ${-(br.a + br.b + br.c)} ${br.d}`,
        `L ${bl.p} ${h}`,
        `c ${-bl.a} 0 ${-(bl.a + bl.b)} 0 ${-(bl.a + bl.b + bl.c)} ${-bl.d}`, arcCmd(bl, -bl.L, -bl.L), `c ${-bl.d} ${-bl.c} ${-bl.d} ${-(bl.b + bl.c)} ${-bl.d} ${-(bl.a + bl.b + bl.c)}`,
        `L 0 ${tl.p}`,
        `c 0 ${-tl.a} 0 ${-(tl.a + tl.b)} ${tl.d} ${-(tl.a + tl.b + tl.c)}`, arcCmd(tl, tl.L, -tl.L), `c ${tl.c} ${-tl.d} ${tl.b + tl.c} ${-tl.d} ${tl.a + tl.b + tl.c} ${-tl.d}`,
        'Z',
      ];
      return new Path2D(d.join(' '));
    }
    function geometryPath(geo) {
      const p = new Path2D();
      let rule = 'nonzero';
      for (const gm of geo) {
        if (gm.commandsBlob == null) continue;
        p.addPath(commandsPath(blobs[gm.commandsBlob], (x, y) => [x, y]));
        if (gm.windingRule === 'ODD') rule = 'evenodd';
      }
      return { path: p, rule };
    }

    /* paints */
    function withPaintSpace(n, p, fn) {
      // A paint's transform maps the layer's 0..1 box into paint space; draw in paint space via the inverse.
      const w = n.size.x, h = n.size.y, i = invert(p.transform || { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 });
      g.transform(w * i.i00, h * i.i10, w * i.i01, h * i.i11, w * i.i02, h * i.i12);
      fn();
    }
    const addStops = (gr, p) => { for (const s of p.stops || []) gr.addColorStop(Math.min(1, Math.max(0, s.position)), css(s.color)); return gr; };
    /* Figma's image adjustments. Measured against Figma: lowering saturation mixes each pixel toward
     * its luminance in linear light (exact). Exposure, contrast, raised saturation and the others are
     * tone-mapped depending on the color, so they're refused. */
    const filtered = new Map();
    function filteredImage(im, f, hash) {
      // The Saturation slider is stored as "vibrance"
      for (const k of Object.keys(f)) if (f[k] && k !== 'vibrance' && k !== 'saturation') nope(`image ${k} adjustment`);
      const sat = f.vibrance || f.saturation || 0;
      if (!sat) return im;
      if (sat > 0) { nope('image saturation increase'); return im; }
      const id = hash + ':' + sat;
      if (filtered.has(id)) return filtered.get(id);
      const cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
      const cg = cv.getContext('2d'); cg.drawImage(im, 0, 0);
      const d = cg.getImageData(0, 0, cv.width, cv.height), px = d.data;
      const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const srgb = v => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
      const k = 1 + sat;
      for (let i = 0; i < px.length; i += 4) {
        const r = lin(px[i]), gg = lin(px[i + 1]), b = lin(px[i + 2]), Y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
        px[i] = srgb(Y + (r - Y) * k); px[i + 1] = srgb(Y + (gg - Y) * k); px[i + 2] = srgb(Y + (b - Y) * k);
      }
      cg.putImageData(d, 0, 0);
      filtered.set(id, cv);
      return cv;
    }
    /* Enlarged images: Figma scales up with a sharp bicubic filter (Keys kernel, a = -1), measured
     * 0.2 off against Figma, where the browser's own smoothing is 6+ off. Used when the image is drawn
     * larger than its pixels and not rotated or skewed; everything else uses the browser's scaling. */
    let isolated = 0; // > 0 while drawing inside a masked / blended / faded layer
    const upscaled = new WeakMap(); // image → Map of size → enlarged copy (an adjusted image is its own object)
    function drawScaled(im, x, y, w, h, hash) {
      const t = g.getTransform(), dw = Math.round(Math.abs(w * t.a)), dh = Math.round(Math.abs(h * t.d));
      // Inside masked or blended layers Figma's result matches the browser's own smoothing better
      if (isolated || t.b || t.c || dw <= im.width || dh <= im.height || dw * dh > 16e6) { g.drawImage(im, x, y, w, h); return; }
      if (!upscaled.has(im)) upscaled.set(im, new Map());
      const sizes = upscaled.get(im), id = `${dw}x${dh}`;
      let big = sizes.get(id);
      if (!big) { big = bicubic(im, dw, dh); sizes.set(id, big); }
      g.drawImage(big, x, y, w, h);
    }
    function bicubic(im, W2, H2) {
      const sw = im.width, sh = im.height;
      const sc = (window.OffscreenCanvas ? new OffscreenCanvas(sw, sh) : Object.assign(document.createElement('canvas'), { width: sw, height: sh })).getContext('2d');
      sc.drawImage(im, 0, 0);
      const S = sc.getImageData(0, 0, sw, sh).data, out = new ImageData(W2, H2), O = out.data;
      const kern = x => { x = Math.abs(x); return x <= 1 ? x * x * x - 2 * x * x + 1 : x < 2 ? -x * x * x + 5 * x * x - 8 * x + 4 : 0; }; // a = -1
      // weights per output column / row (separable)
      const taps = (n, m) => Array.from({ length: n }, (_, o) => { const s0 = (o + 0.5) * m / n - 0.5, i0 = Math.floor(s0); const w = [], idx = []; let sum = 0;
        for (let j = -1; j <= 2; j++) { const wt = kern(s0 - (i0 + j)); w.push(wt); idx.push(Math.min(m - 1, Math.max(0, i0 + j))); sum += wt; }
        return { w: w.map(v => v / sum), idx }; });
      const cx = taps(W2, sw), cy = taps(H2, sh);
      const tmp = new Float32Array(W2 * sh * 4); // horizontal pass (premultiplied)
      for (let y = 0; y < sh; y++) for (let x = 0; x < W2; x++) { const { w, idx } = cx[x]; let r = 0, gg = 0, b = 0, a = 0;
        for (let j = 0; j < 4; j++) { const k = (y * sw + idx[j]) * 4, al = S[k + 3] / 255; r += S[k] * al * w[j]; gg += S[k + 1] * al * w[j]; b += S[k + 2] * al * w[j]; a += S[k + 3] * w[j]; }
        const o = (y * W2 + x) * 4; tmp[o] = r; tmp[o + 1] = gg; tmp[o + 2] = b; tmp[o + 3] = a; }
      for (let y = 0; y < H2; y++) { const { w, idx } = cy[y]; for (let x = 0; x < W2; x++) { let r = 0, gg = 0, b = 0, a = 0;
        for (let j = 0; j < 4; j++) { const k = (idx[j] * W2 + x) * 4; r += tmp[k] * w[j]; gg += tmp[k + 1] * w[j]; b += tmp[k + 2] * w[j]; a += tmp[k + 3] * w[j]; }
        const o = (y * W2 + x) * 4, al = Math.max(0, Math.min(255, a)); O[o + 3] = al;
        const inv = al > 0 ? 255 / al : 0; O[o] = Math.max(0, Math.min(255, r * inv)); O[o + 1] = Math.max(0, Math.min(255, gg * inv)); O[o + 2] = Math.max(0, Math.min(255, b * inv)); } }
      const cv = document.createElement('canvas'); cv.width = W2; cv.height = H2; cv.getContext('2d').putImageData(out, 0, 0);
      return cv;
    }
    /* Pattern fills: the source layer (carried in the copy on Figma's internal page) repeated across
     * the shape. Tile = the source's box × scale; spacing is a fraction of the tile; alignment says
     * where the first tile sits (start, center or end); hexagonal tiling shifts every other row
     * (horizontal) or column (vertical) by half a tile. */
    function drawPattern(n, p, stroke) {
      const src = nodes.get(key(p.sourceNodeId));
      if (!src || !src.size) { nope('pattern source missing from the copy'); return; }
      const t = src.transform || {};
      if ((t.m01 || 0) !== 0 || (t.m10 || 0) !== 0 || (t.m00 ?? 1) < 0 || (t.m11 ?? 1) < 0) nope('rotated or flipped pattern source');
      if (visibleEffects(src).length) nope('effects on a pattern source');
      // (Patterns made from images: Figma's Export button leaves them empty, but Copy as PNG and the
      // editor draw them, and Cutout matches Copy as PNG.)
      if (patternDepth > 2) { nope('pattern inside a pattern'); return; }
      const sc = p.scale ?? 1, sp = p.patternSpacing || { x: 0, y: 0 };
      const tw = src.size.x * sc, th = src.size.y * sc;
      if (!(tw > 0.5 && th > 0.5)) return;
      const cw = tw * (1 + (sp.x || 0)), chh = th * (1 + (sp.y || 0));
      const w = n.size.x || 1, h = n.size.y || 1, pad = (n.strokeWeight || 0) * 2 + Math.max(cw, chh);
      const type = p.patternTileType || 'RECTANGULAR';
      if (!['RECTANGULAR', 'HORIZONTAL_HEXAGONAL', 'VERTICAL_HEXAGONAL'].includes(type)) nope('pattern tiling ' + type);
      const start = (al, len, tile) => (al === 'CENTER' ? (len - tile) / 2 : al === 'END' ? len - tile : 0);
      // On a stroke, Figma lays the pattern out from the stroke's outer bounds (box grown by the weight)
      const sw = stroke ? (n.strokeWeight || 0) : 0;
      const x0 = -sw + start(p.horizontalAlignment, w + 2 * sw, tw), y0 = -sw + start(p.verticalAlignment, h + 2 * sw, th);
      const cols = Math.ceil((w + 2 * pad) / cw) + 2, rows = Math.ceil((h + 2 * pad) / chh) + 2;
      if (cols * rows > 20000) { nope('very fine pattern'); return; }
      const iMin = Math.floor((-pad - x0) / cw) - 1, jMin = Math.floor((-pad - y0) / chh) - 1;
      const plain = { ...src, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, visible: true };
      patternDepth++;
      try {
        for (let j = jMin; j < jMin + rows; j++) for (let i = iMin; i < iMin + cols; i++) {
          let x = x0 + i * cw, y = y0 + j * chh;
          if (type === 'HORIZONTAL_HEXAGONAL' && (j & 1)) x += cw / 2;
          if (type === 'VERTICAL_HEXAGONAL' && (i & 1)) y += chh / 2;
          if (x > w + pad || y > h + pad || x + tw < -pad || y + th < -pad) continue;
          g.save(); g.translate(x, y); g.scale(sc, sc); drawLayer(plain, null); g.restore();
        }
      } finally { patternDepth--; }
    }
    let patternDepth = 0;
    function paintArea(n, p, stroke = false) { // fills the current clip with paint p (node coordinates)
      const w = n.size.x || 1, h = n.size.y || 1;
      if (!PAINTS.includes(p.type)) { nope(`${p.type.toLowerCase()} fill`); return; }
      for (const k of unknownFields(p, KNOWN.paint)) nope(`fill property ${k}`);
      if (p.interpolationColorSpace && p.interpolationColorSpace !== 'DEFAULT') nope('gradient color space');
      if (p.type === 'SOLID') { g.fillStyle = css(p.color, p.opacity ?? 1); g.fillRect(-1e5, -1e5, 2e5, 2e5); return; }
      g.globalAlpha *= p.opacity ?? 1;
      if (p.type === 'GRADIENT_DIAMOND') { // four linear gradients, one per quadrant around the center
        withPaintSpace(n, p, () => {
          for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
            g.save(); g.beginPath(); g.rect(0.5, 0.5, sx * 100, sy * 100); g.clip();
            g.fillStyle = addStops(g.createLinearGradient(0.5, 0.5, 0.5 + sx * 0.25, 0.5 + sy * 0.25), p);
            g.fillRect(-100, -100, 200, 200); g.restore();
          }
        });
        return;
      }
      if (p.type.startsWith('GRADIENT_')) {
        withPaintSpace(n, p, () => {
          g.fillStyle = addStops(p.type === 'GRADIENT_LINEAR' ? g.createLinearGradient(0, 0.5, 1, 0.5)
            : p.type === 'GRADIENT_RADIAL' ? g.createRadialGradient(0.5, 0.5, 0, 0.5, 0.5, 0.5)
              : g.createConicGradient(0, 0.5, 0.5), p);
          g.fillRect(-100, -100, 200, 200);
        });
        return;
      }
      if (p.type === 'PATTERN') { drawPattern(n, p, stroke); return; }
      // IMAGE
      // Animated GIFs: "image" is a still of the first frame, which is what Figma exports
      if (p.animatedImage && p.animationFrame) nope('GIF frame other than the first');
      const hash = p.image && hex(p.image.hash);
      let im = hash && imgs.get(hash);
      if (im === null) return; // broken image file: Figma shows nothing either
      if (!im) { missingImages.add(hash || '?'); return; }
      const f = p.paintFilter;
      if (f && Object.values(f).some(v => v)) im = filteredImage(im, f, hash);
      const mode = p.imageScaleMode || 'FILL';
      if (mode === 'FILL' || mode === 'FIT') {
        // Rotation comes in quarter turns: turn the image around the box center, then cover / fit
        const rot = ((Math.round((p.rotation || 0) / 90) % 4) + 4) % 4;
        if (p.rotation && Math.abs(p.rotation / 90 - Math.round(p.rotation / 90)) > 1e-3) nope('image fill rotation');
        const iw = rot % 2 ? im.height : im.width, ih = rot % 2 ? im.width : im.height;
        const k = (mode === 'FILL' ? Math.max : Math.min)(w / iw, h / ih);
        g.translate(w / 2, h / 2); g.rotate(rot * Math.PI / 2);
        drawScaled(im, -im.width * k / 2, -im.height * k / 2, im.width * k, im.height * k, hash);
      } else if (mode === 'STRETCH') withPaintSpace(n, p, () => g.drawImage(im, 0, 0, 1, 1));
      else if (mode === 'TILE') {
        const k = p.scale ?? 1, tw = im.width * k, th = im.height * k;
        if (tw < 0.5 || th < 0.5) { nope('tiny image tiles'); return; }
        if (Math.ceil(w / tw) * Math.ceil(h / th) > 100000) { nope('very fine image tiles'); return; }
        for (let y = 0; y < h; y += th) for (let x = 0; x < w; x += tw) drawScaled(im, x, y, tw, th, hash);
      } else nope(`image mode ${mode}`);
    }
    function fillShape(n, shape, paints) {
      for (const p of paints || []) {
        if (p.visible === false) continue;
        g.save();
        if (BLEND[p.blendMode]) g.globalCompositeOperation = BLEND[p.blendMode];
        else if (!NORMAL_BLEND.includes(p.blendMode)) nope(`${p.blendMode} blend`);
        g.clip(shape.path, shape.rule || 'nonzero'); paintArea(n, p); g.restore();
      }
    }
    /* Line ends, measured against Figma (w = stroke weight; distances along the line from its end):
     * arrow lines: two 5w arms at 45° from a tip w/2 in; equilateral arrow: filled triangle, tip at the
     * end, 5w long; triangle: wide side (6w) w/2 in, 6w long; diamond: half-size 2.875w, circle: radius
     * 2.625w, both centered w/2 in. The stroke is cut off where the end shape starts. */
    const LINE_ENDS = {
      ARROW_LINES: { cut: 0.5, draw: (P, w) => { g.lineWidth = w; g.lineJoin = 'miter'; g.lineCap = 'butt'; const a = P(0.5, 0), L = 5 * w * Math.SQRT1_2;
        g.beginPath(); g.moveTo(...P(0.5 + L / w, L / w)); g.lineTo(...a); g.lineTo(...P(0.5 + L / w, -L / w)); g.stroke(); } },
      ARROW_EQUILATERAL: { cut: 2.5, draw: (P, w) => { const h = 5, b = h / Math.sqrt(3); g.beginPath(); g.moveTo(...P(0, 0)); g.lineTo(...P(h, b)); g.lineTo(...P(h, -b)); g.closePath(); g.fill(); } },
      TRIANGLE_FILLED: { cut: 0.5, draw: (P, w) => { g.beginPath(); g.moveTo(...P(0.5, 3)); g.lineTo(...P(6.5, 0)); g.lineTo(...P(0.5, -3)); g.closePath(); g.fill(); } },
      DIAMOND_FILLED: { cut: 0.5, draw: (P, w) => { const c = 0.5, r = 2.875; g.beginPath(); g.moveTo(...P(c - r, 0)); g.lineTo(...P(c, r)); g.lineTo(...P(c + r, 0)); g.lineTo(...P(c, -r)); g.closePath(); g.fill(); } },
      ROUND: { cut: 0, draw: (P, w) => { const [cx, cy] = P(0, 0); g.beginPath(); g.arc(cx, cy, w / 2, 0, 2 * Math.PI); g.fill(); } },
      SQUARE: { cut: 0, draw: (P, w) => { g.beginPath(); g.moveTo(...P(0, 0.5)); g.lineTo(...P(-0.5, 0.5)); g.lineTo(...P(-0.5, -0.5)); g.lineTo(...P(0, -0.5)); g.closePath(); g.fill(); } },
      HIGHLIGHT: { cut: 0, draw: (P, w) => { g.beginPath(); g.moveTo(...P(0, 0.5)); g.lineTo(...P(-0.1, 0.5)); g.lineTo(...P(-0.4, -0.5)); g.lineTo(...P(0, -0.5)); g.closePath(); g.fill(); } },
      CIRCLE_FILLED: { cut: 0.5, draw: (P, w) => { const [cx, cy] = P(0.5, 0); g.beginPath(); g.arc(cx, cy, 2.625 * w, 0, 2 * Math.PI); g.fill(); } },
    };
    /** Draws one line end into the stroke outline layer. end: point + outward direction. */
    function drawLineEnd(end, w, cap) {
      // P(along, across): point measured inward from the end, in stroke weights
      const nx = -end.uy, ny = end.ux;
      const P = (along, across) => [end.x - end.ux * along * w + nx * across * w, end.y - end.uy * along * w + ny * across * w];
      g.save();
      // cut the stroke off beyond the end shape's start (only near the end)
      const c = P(cap.cut, 0), R = 8 * w;
      g.beginPath(); g.arc(end.x, end.y, R, 0, 2 * Math.PI); g.clip();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); g.moveTo(c[0] + nx * R, c[1] + ny * R); g.lineTo(c[0] - nx * R, c[1] - ny * R);
      g.lineTo(c[0] - nx * R + end.ux * R * 2, c[1] - ny * R + end.uy * R * 2); g.lineTo(c[0] + nx * R + end.ux * R * 2, c[1] + ny * R + end.uy * R * 2); g.closePath(); g.fill();
      g.restore();
      g.save(); g.setLineDash([]); g.fillStyle = g.strokeStyle = '#000'; cap.draw(P, w); g.restore();
    }
    /** Canvas dash array for a subpath: per segment, a whole number of (stretched) patterns, each
     *  segment starting and ending with half a dash, so dashes sit centered on the path's points. */
    function dashArray(segs, pattern) {
      const pat = pattern.length % 2 ? [...pattern, ...pattern] : pattern, period = pat.reduce((a, b) => a + b, 0), out = [];
      for (const L of segs) {
        if (!(L > 1e-6)) continue;
        const reps = Math.max(1, Math.round(L / period)), k = L / (reps * period), seq = [];
        for (let i = 0; i < reps; i++) for (const v of pat) seq.push(v * k);
        seq[0] /= 2; seq.push(seq[0]); // half a dash at both ends
        if (out.length) { out[out.length - 1] += seq[0]; out.push(...seq.slice(1)); } else out.push(...seq);
      }
      if (out.length % 2) out.push(0);
      return out;
    }
    function strokeShape(n, shape) {
      const w = n.strokeWeight || 0, paints = (n.strokePaints || []).filter(p => p.visible !== false);
      const sides = n.borderStrokeWeightsIndependent && (n.borderTopWeight || n.borderRightWeight || n.borderBottomWeight || n.borderLeftWeight);
      if ((!w && !sides) || !paints.length) return;
      // Brushes (textured strokes), scatter brushes and variable-width strokes: drawn by Figma
      // from its own brush data, which Cutout can't match.
      if (n.strokeBrushGuid || n.brushType || (n.scatterBrushTransforms && n.scatterBrushTransforms.length)) nope('brush strokes');
      if (n.variableWidthPoints && n.variableWidthPoints.length) nope('variable width strokes');
      if (directStroke(n, shape, paints, w)) return;
      // The stroke's outline goes into a layer, then each stroke paint fills it
      const outline = offscreen(() => {
        g.lineJoin = (n.strokeJoin || 'MITER').toLowerCase();
        g.miterLimit = n.miterLimit || 4; // Figma's default
        g.lineCap = { ROUND: 'round', SQUARE: 'square' }[n.strokeCap] || 'butt';
        // Line ends: one setting for the layer, or (pen paths) one per end point
        const ends = shape.ends || [];
        const capOf = e => e.cap || n.strokeCap || 'NONE';
        const perEnd = ends.some(e => capOf(e) !== (n.strokeCap || 'NONE')) || ends.some(e => LINE_ENDS[capOf(e)] && !['ROUND', 'SQUARE', 'NONE'].includes(capOf(e)));
        if (perEnd) g.lineCap = 'butt';
        for (const c of new Set([...ends.map(capOf), n.strokeCap || 'NONE'])) if (!LINE_ENDS[c] && c !== 'NONE') nope(`${c.toLowerCase().replace(/_/g, ' ')} line ends`);
        // Dashes: Figma fits a whole number of dash patterns into every segment of the path (a circle
        // has 4), stretching the pattern slightly, with a dash centered on every point
        const dashed = n.dashPattern && n.dashPattern.some(v => v > 0);
        if (dashed && (!shape.dash || n.borderStrokeWeightsIndependent)) nope('dashed stroke on this shape');
        const strokeIt = () => {
          if (!dashed || !shape.dash) { g.stroke(shape.path); return; }
          for (const sp of shape.dash) { g.setLineDash(dashArray(sp.segs, n.dashPattern)); g.lineDashOffset = 0; g.stroke(sp.path); }
          g.setLineDash([]);
        };
        const align = shape.open ? 'CENTER' : n.strokeAlign;
        g.strokeStyle = '#000'; g.fillStyle = '#000';
        if (n.borderStrokeWeightsIndependent && n.size) { // different width per side: one band per side
          const SW = n.size.x, SH = n.size.y, T = n.borderTopWeight || 0, R = n.borderRightWeight || 0, B = n.borderBottomWeight || 0, L = n.borderLeftWeight || 0;
          const o = align === 'OUTSIDE' ? 1 : align === 'CENTER' ? 0.5 : 0;
          if (T) g.fillRect(-L * o, -T * o, SW + (L + R) * o, T);
          if (B) g.fillRect(-L * o, SH - B + B * o, SW + (L + R) * o, B);
          if (L) g.fillRect(-L * o, -T * o, L, SH + (T + B) * o);
          if (R) g.fillRect(SW - R + R * o, -T * o, R, SH + (T + B) * o);
          if (!shape.open && align === 'INSIDE') { g.globalCompositeOperation = 'destination-in'; g.fill(shape.path, shape.rule || 'nonzero'); }
        } else if (align === 'INSIDE') { g.save(); g.clip(shape.path, shape.rule || 'nonzero'); g.lineWidth = w * 2; strokeIt(); g.restore(); }
        else if (align === 'OUTSIDE') { g.lineWidth = w * 2; strokeIt(); g.globalCompositeOperation = 'destination-out'; g.fill(shape.path, shape.rule || 'nonzero'); }
        else { g.lineWidth = w; strokeIt(); }
        if (perEnd) for (const end of ends) if (LINE_ENDS[capOf(end)]) drawLineEnd(end, w, LINE_ENDS[capOf(end)]);
      });
      for (const p of paints) {
        const layer = offscreen(() => { g.save(); paintArea(n, p, true); g.restore(); });
        maskWith(layer, outline);
        putLayer(layer, BLEND[p.blendMode] || 'source-over');
        give(layer);
      }
      give(outline);
    }

    /** Fast path (no full-size scratch layers): one solid paint, normal blend, centered or inside,
     *  same line end at both ends. Returns false when the general path is needed. */
    function directStroke(n, shape, paints, w) {
      const p = paints[0];
      if (paints.length !== 1 || p.type !== 'SOLID' || !NORMAL_BLEND.includes(p.blendMode) || !w || n.borderStrokeWeightsIndependent) return false;
      for (const k of unknownFields(p, KNOWN.paint)) { nope(`fill property ${k}`); return false; }
      const align = shape.open ? 'CENTER' : n.strokeAlign || 'CENTER';
      if (align === 'OUTSIDE') return false;
      const ends = shape.ends || [], cap0 = n.strokeCap || 'NONE';
      if (ends.some(e => (e.cap || cap0) !== cap0) || !['NONE', 'ROUND', 'SQUARE'].includes(cap0)) return false;
      const dashed = n.dashPattern && n.dashPattern.some(v => v > 0);
      const alpha = (p.color.a ?? 1) * (p.opacity ?? 1);
      if (dashed && (!shape.dash || alpha < 1)) return false; // overlapping dash pieces would double up
      g.save();
      g.lineJoin = (n.strokeJoin || 'MITER').toLowerCase(); g.miterLimit = n.miterLimit || 4;
      g.lineCap = { ROUND: 'round', SQUARE: 'square' }[cap0] || 'butt';
      g.strokeStyle = css(p.color, p.opacity ?? 1);
      if (align === 'INSIDE') { g.clip(shape.path, shape.rule || 'nonzero'); g.lineWidth = w * 2; } else g.lineWidth = w;
      if (dashed) { for (const sp of shape.dash) { g.setLineDash(dashArray(sp.segs, n.dashPattern)); g.lineDashOffset = 0; g.stroke(sp.path); } }
      else g.stroke(shape.path);
      g.restore();
      return true;
    }

    /* effects */
    /* Shadows are cast by a "caster" layer: a full-size canvas holding the shape that throws the
     * shadow. Canvas shadows are drawn with the caster moved far off-canvas, so only the shadow lands. */
    const FAR = 100000;
    function castShadow(caster, e) {
      const s = g.getTransform().a;
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
      g.shadowColor = css(e.color); g.shadowBlur = (e.radius || 0) * s;
      g.shadowOffsetX = (e.offset ? e.offset.x : 0) * s + FAR; g.shadowOffsetY = (e.offset ? e.offset.y : 0) * s;
      g.drawImage(caster, -FAR, 0);
      g.restore();
    }
    /** A shadow cast straight from the shape's path, moved far off-canvas so only the shadow lands. */
    function pathShadow(shape, e) {
      const m = g.getTransform(), s = m.a;
      g.save();
      g.setTransform(m.a, m.b, m.c, m.d, m.e - FAR, m.f);
      g.shadowColor = css(e.color); g.shadowBlur = (e.radius || 0) * s;
      g.shadowOffsetX = (e.offset ? e.offset.x : 0) * s + FAR; g.shadowOffsetY = (e.offset ? e.offset.y : 0) * s;
      g.fillStyle = '#000'; g.fill(shape.path, shape.rule || 'nonzero');
      g.restore();
    }
    /** The shape grown (spread > 0) or shrunk (spread < 0), as a caster layer. */
    function shapeCaster(shape, spread = 0) {
      return offscreen(() => {
        g.fillStyle = '#000'; g.strokeStyle = '#000'; g.lineJoin = 'round';
        g.fill(shape.path, shape.rule || 'nonzero');
        if (spread > 0) { g.lineWidth = spread * 2; g.stroke(shape.path); }
        else if (spread < 0) { g.globalCompositeOperation = 'destination-out'; g.lineWidth = -spread * 2; g.stroke(shape.path); }
      });
    }
    /** caster: a ready caster layer (boolean groups), instead of building one from shape. */
    function dropShadows(n, shape, caster = null) {
      for (const e of visibleEffects(n).filter(x => x.type === 'DROP_SHADOW')) {
        if (caster && e.spread) nope('shadow spread on a boolean group');
        if (!caster && !e.spread && e.showShadowBehindNode !== false) { pathShadow(shape, e); continue; }
        const c = caster || shapeCaster(shape, e.spread || 0);
        if (e.showShadowBehindNode === false) {
          // Hidden behind the layer itself: cut the layer's area out of the shadow
          const layer = offscreen(() => castShadow(c, e)), cut = caster || shapeCaster(shape);
          const lg = layer.getContext('2d'); lg.save(); lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalCompositeOperation = 'destination-out';
          lg.drawImage(cut, 0, 0); lg.restore();
          putLayer(layer);
          give(layer); if (!caster) give(cut);
        } else castShadow(c, e);
        if (!caster) give(c);
      }
    }
    function innerShadows(n, shape) {
      for (const e of visibleEffects(n).filter(x => x.type === 'INNER_SHADOW')) {
        // The caster is everything outside the shape, grown inward by the spread
        const c = offscreen(() => {
          g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, g.canvas.width, g.canvas.height); g.restore();
          g.globalCompositeOperation = 'destination-out'; g.fill(shape.path, shape.rule || 'nonzero');
          if (e.spread > 0) { g.globalCompositeOperation = 'source-over'; g.strokeStyle = '#000'; g.lineJoin = 'round'; g.lineWidth = e.spread * 2; g.stroke(shape.path); }
        });
        if (e.spread < 0) nope('negative inner shadow spread');
        g.save(); g.clip(shape.path, shape.rule || 'nonzero');
        // The caster has hard edges at the canvas border; pad the shadow's reach with a far-away fill
        castShadow(c, e);
        g.restore();
        give(c);
      }
    }
    function backgroundBlur(n, shape) {
      const e = visibleEffects(n).find(x => x.type === 'BACKGROUND_BLUR');
      if (!e) return;
      if (e.blurOpType === 'PROGRESSIVE') nope('progressive blur');
      const s = g.getTransform().a, snap = take();
      snap.getContext('2d').drawImage(g.canvas, 0, 0);
      g.save(); g.clip(shape.path, shape.rule || 'nonzero'); g.setTransform(1, 0, 0, 1, 0, 0);
      g.filter = `blur(${(e.radius || 0) / 2 * s}px)`; g.drawImage(snap, 0, 0); g.restore();
      give(snap);
    }
    function checkEffects(n) {
      for (const e of visibleEffects(n)) {
        if (!CAN_BLUR && (e.type === 'FOREGROUND_BLUR' || e.type === 'BACKGROUND_BLUR')) nope('blur (this browser has no canvas filter)');
        for (const k of unknownFields(e, KNOWN.effect)) nope(`effect property ${k}`);
        if (e.blendMode && !NORMAL_BLEND.includes(e.blendMode)) nope('effect blend mode');
        if (!EFFECTS.includes(e.type)) nope(`${String(e.type).toLowerCase().replace(/_/g, ' ')} effect`);
        else if (e.type === 'FOREGROUND_BLUR' && e.blurOpType === 'PROGRESSIVE') nope('progressive blur');
      }
    }

    /* text: Figma stores every glyph's outline, so no fonts are needed */
    function drawText(n) {
      const d = n.derivedTextData, td = n.textData || {};
      if (!d || !d.glyphs) { if (td.characters && td.characters.trim()) nope('text without outlines'); return; }
      for (const k of unknownFields(d, KNOWN.text)) nope(`text property ${k}`);
      for (const st of td.styleOverrideTable || []) {
        for (const k of unknownFields(st, KNOWN.node, KNOWN.nodePrefix)) nope(`text style property ${k}`);
        if (fancyUnderline(st)) nope('wavy or dotted underline');
      }
      const styles = new Map((td.styleOverrideTable || []).map(s => [s.styleID, s]));
      const ids = td.characterStyleIDs || [];
      const fillsFor = sid => (styles.get(sid) && styles.get(sid).fillPaints) || n.fillPaints;
      const groups = new Map();
      const group = sid => { if (!groups.has(sid)) groups.set(sid, new Path2D()); return groups.get(sid); };
      // Truncated text ("…"): glyphs from the cut on are hidden; the ellipsis is an extra glyph without a character
      const cut = d.truncationStartIndex >= 0 ? d.truncationStartIndex : Infinity;
      for (const gl of d.glyphs) {
        for (const k of unknownFields(gl, KNOWN.glyph)) nope(k === 'emojiCodePoints' ? 'emoji' : `glyph property ${k}`);
        if (gl.commandsBlob == null || gl.firstCharacter >= cut) continue;
        const s = gl.fontSize, x = gl.position.x, y = gl.position.y, rot = -(gl.rotation || 0), cs = Math.cos(rot), sn = Math.sin(rot); // Figma turns counterclockwise (y up)
        group(ids[gl.firstCharacter] || 0).addPath(commandsPath(blobs[gl.commandsBlob], (gx, gy) => { const X = gx * s, Y = -gy * s; return [x + X * cs - Y * sn, y + X * sn + Y * cs]; }));
      }
      for (const dec of d.decorations || []) for (const r of dec.rects || []) group(dec.styleID || 0).rect(r.x, r.y, r.w, r.h);
      const all = new Path2D();
      for (const path of groups.values()) all.addPath(path);
      // (A background blur on text isn't drawn: Figma's Copy as PNG doesn't show one either;
      // drawing it made the iOS lock screen sample match worse.)
      dropShadows(n, { path: all });
      for (const [sid, path] of groups) fillShape(n, { path }, fillsFor(sid));
      innerShadows(n, { path: all });
      strokeShape(n, { path: all });
    }

    /* component overrides
     * A scope holds the overrides that apply inside one instance, keyed by the path of layer IDs
     * below that instance ("a/b/c"). A layer is found by its overrideKey (or guid). Overrides set
     * by outer instances win over those set by inner ones. */
    const idsOf = n => [n.overrideKey && key(n.overrideKey), key(n.guid)].filter(Boolean);
    function lookup(scope, n) {
      if (!scope) return null;
      let found = null;
      for (const id of idsOf(n)) { const o = scope.get(id); if (o) found = { ...o, ...(found || {}) }; }
      return found;
    }
    function instanceScope(inst, parentScope) {
      const scope = new Map();
      const add = (pk, props, outerWins) => { const cur = scope.get(pk); scope.set(pk, outerWins ? { ...props, ...(cur || {}) } : { ...(cur || {}), ...props }); };
      if (parentScope) for (const id of idsOf(inst)) for (const [pk, props] of parentScope) if (pk.startsWith(`${id}/`)) add(pk.slice(id.length + 1), props, false);
      for (const o of [...(inst.symbolData.symbolOverrides || []), ...(inst.derivedSymbolData || [])]) {
        const { guidPath, ...props } = o;
        if (guidPath && guidPath.guids) add(guidPath.guids.map(key).join('/'), props, true);
      }
      return scope;
    }
    // A swapped instance takes its look from the component it was swapped to.
    const LOOK = ['blendMode', 'opacity', 'fillPaints', 'strokePaints', 'strokeWeight', 'strokeAlign', 'strokeJoin', 'dashPattern', 'effects', 'cornerRadius', 'rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius', 'rectangleBottomLeftCornerRadius', 'rectangleBottomRightCornerRadius', 'frameMaskDisabled', 'borderStrokeWeightsIndependent', 'borderTopWeight', 'borderRightWeight', 'borderBottomWeight', 'borderLeftWeight'];
    function swappedLook(n0, ov) {
      const sym = ov && ov.overriddenSymbolID && nodes.get(key(ov.overriddenSymbolID));
      if (!sym || n0.type !== 'INSTANCE') return {};
      const look = {};
      for (const f of LOOK) look[f] = sym[f];
      return look;
    }
    /* Variable modes. Paint colors are stored as resolved in each variable's default mode; a frame,
     * component or instance can pick another mode per collection (variableModeBySetMap, e.g. Dark),
     * which applies to it and everything inside. Colors are re-resolved in the active modes. */
    const varByKey = new Map(), varByGuid = new Map(), setByKey = new Map(), setByGuid = new Map();
    for (const v of msg.nodeChanges || []) {
      if (v.type === 'VARIABLE') { if (v.key) varByKey.set(v.key, v); varByGuid.set(key(v.guid), v); }
      if (v.type === 'VARIABLE_SET') { if (v.key) setByKey.set(v.key, v); setByGuid.set(key(v.guid), v); }
    }
    const setOf = ref => ref && (ref.assetRef ? setByKey.get(ref.assetRef.key) : ref.guid ? setByGuid.get(key(ref.guid)) : null);
    const defaultMode = set => set && set.variableSetModes && set.variableSetModes[0] && key(set.variableSetModes[0].id);
    let modeCtx = new Map(); // variable set (its node) -> chosen mode id
    const withModes = (ctx, map) => {
      if (!map || !map.entries || !map.entries.length) return ctx;
      const out = new Map(ctx);
      for (const e of map.entries) {
        const set = setOf(e.variableSetID);
        if (!set) { nope('variable mode from a library not in the copy'); continue; }
        out.set(set, key(e.variableModeID));
      }
      return out;
    };
    /** Resolves a variable value (alias chains included) in the active modes (or, with defaults,
     *  in every collection's default mode); undefined if unknown. A mode chosen outside the copy
     *  (on a parent frame or the page) isn't recorded in it: then the default mode is used, which is
     *  how Figma stores the values anyway (by design). */
    function resolveVar(data, depth = 0, defaults = false) {
      const a = data && data.value && data.value.alias;
      if (!a) return data && data.value;
      if (depth > 20) return undefined;
      const v = a.assetRef ? varByKey.get(a.assetRef.key) : a.guid ? varByGuid.get(key(a.guid)) : null;
      const set = v && setOf(v.variableSetID);
      if (!v || !set) return undefined;
      const mode = (!defaults && modeCtx.get(set)) || defaultMode(set);
      const entry = ((v.variableDataValues || {}).entries || []).find(e => key(e.modeID) === mode);
      return entry ? resolveVar(entry.variableData, depth + 1, defaults) : undefined;
    }
    const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // Underlines come as plain rectangles; only solid ones can be drawn from them
    const fancyUnderline = o => o.textDecorationStyle && o.textDecorationStyle !== 'SOLID' && o.textDecoration && o.textDecoration !== 'NONE';
    const nonDefault = () => [...modeCtx].some(([set, m]) => m !== defaultMode(set));
    // Properties Figma stores already laid out in the right mode (sizes, auto layout spacing)
    const LAID_OUT = /^(WIDTH|HEIGHT|MIN_WIDTH|MAX_WIDTH|MIN_HEIGHT|MAX_HEIGHT|STACK_.*)$/;
    /** Other variable-bound properties (corner radius, stroke weight, visibility, text…) are stored
     *  in the default mode; refuse when a mode set inside the copy would change them. */
    function checkBindings(n) {
      for (const map of [n.parameterConsumptionMap, n.variableConsumptionMap]) {
        for (const e of (map && map.entries) || []) {
          if (!e.variableData || !e.variableData.value || !e.variableData.value.alias || LAID_OUT.test(e.variableField || '')) continue;
          const now = resolveVar(e.variableData), base = resolveVar(e.variableData, 0, true);
          if (sameValue(now, base)) continue;
          // Layers outside components already carry the active mode's value (e.g. a radius in Mobile)
          const field = String(e.variableField || '').toLowerCase().replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
          const plain = now && (now.floatValue ?? now.boolValue);
          if (plain !== undefined && field in n && (typeof plain === 'number' ? Math.abs(n[field] - plain) < 1e-3 : n[field] === plain)) continue;
          nope(`variable mode changing ${String(e.variableField).toLowerCase().replace(/_/g, ' ')}`);
        }
      }
    }
    /** A color variable's value in the active modes, or null when it's the stored (default) one.
     *  Variables missing from the copy are fine in the default modes, refused in others. */
    function modeColor(colorVar) {
      const now = resolveVar(colorVar), base = resolveVar(colorVar, 0, true);
      if (!now || !now.colorValue || !base || !base.colorValue) { if (nonDefault()) nope('color variable missing from the copy'); return null; }
      return sameValue(now.colorValue, base.colorValue) ? null : { now: now.colorValue, base: base.colorValue };
    }
    function modePaints(paints) {
      if (!Array.isArray(paints) || !paints.some(p => p.colorVar)) return paints;
      return paints.map(p => {
        const c = p.colorVar && modeColor(p.colorVar);
        if (!c) return p;
        // Layers outside components already carry the active mode's color: leave them as they are
        const near = (a, b) => Math.abs(a - b) < 1 / 255;
        const storedAlpha = (p.color && p.color.a != null ? p.color.a : 1) * (p.opacity ?? 1);
        if (p.color && near(p.color.r, c.now.r) && near(p.color.g, c.now.g) && near(p.color.b, c.now.b) && Math.abs(storedAlpha - (c.now.a ?? 1)) < 0.01) return p;
        // Figma keeps a variable color's alpha in the paint's opacity (the color itself is opaque)
        const opacity = c.base.a > 0 ? (p.opacity ?? 1) * c.now.a / c.base.a : c.now.a;
        return { ...p, color: { ...c.now, a: p.color ? p.color.a : 1 }, opacity };
      });
    }
    function applyModes(n) {
      checkBindings(n);
      const out = { ...n };
      for (const k of ['fillPaints', 'strokePaints']) if (n[k]) out[k] = modePaints(n[k]);
      // Text runs with their own colors (a bold word in an accent color) keep them in textData
      const runs = n.textData && n.textData.styleOverrideTable;
      if (runs && runs.some(st => st.fillPaints)) out.textData = { ...n.textData, styleOverrideTable: runs.map(st => (st.fillPaints ? { ...st, fillPaints: modePaints(st.fillPaints) } : st)) };
      if (n.effects && n.effects.some(e => e.colorVar)) out.effects = n.effects.map(e => {
        const c = e.colorVar && modeColor(e.colorVar);
        return c ? { ...e, color: c.now } : e;
      });
      return out;
    }
    // Shared styles travel as hidden entries in the copy.
    const styleByKey = new Map((msg.nodeChanges || []).filter(s => s.styleType && s.key).map(s => [s.key, s]));
    const styled = (ref, field) => {
      const k = ref && ref.assetRef && ref.assetRef.key, s = k && styleByKey.get(k);
      if (k && !s) nope('style missing from the copy');
      return s && s[field];
    };
    // An override that links a style shows the style's current look, even when the override also
    // carries (possibly stale) paints; those are only the fallback when the style isn't in the copy.
    const styledOr = (ref, field, own) => { const k = ref && ref.assetRef && ref.assetRef.key, s = k && styleByKey.get(k);
      if (s && s[field]) return s[field];
      if (!own && ref) return styled(ref, field); // missing style and nothing else to draw: refuse
      return null; };
    function applyStyles(n, ov) {
      if (!ov) return n;
      const fills = ov.styleIdForFill && styledOr(ov.styleIdForFill, 'fillPaints', ov.fillPaints);
      const strokes = ov.styleIdForStrokeFill && styledOr(ov.styleIdForStrokeFill, 'fillPaints', ov.strokePaints);
      const fx = ov.styleIdForEffect && styledOr(ov.styleIdForEffect, 'effects', ov.effects);
      return fills || strokes || fx ? { ...n, ...(fills && { fillPaints: fills }), ...(strokes && { strokePaints: strokes }), ...(fx && { effects: fx }) } : n;
    }

    /* nodes */
    /* Component properties: layers inside a component point to a property (componentPropRefs) for
     * their visibility, text or swapped component; the instance holds the chosen values
     * (componentPropAssignments). Without an assignment, the layer's own state is the default. */
    let instanceProps = null; // Map defID -> assignment, for the instance being drawn
    const propValue = a => { const v = a.value || {}, vv = (a.varValue && a.varValue.value) || {};
      return { bool: v.boolValue ?? vv.boolValue, guid: v.guidValue ?? vv.guidValue ?? vv.symbolIdValue, text: v.textValue ?? vv.textDataValue }; };
    function applyProps(n, ov) {
      let out = n;
      for (const r of n.componentPropRefs || []) {
        if (r.isDeleted) continue;
        const a = instanceProps && instanceProps.get(key(r.defID));
        if (!a) continue;
        const val = propValue(a);
        switch (r.componentPropNodeField) {
          case 'VISIBLE': if (val.bool !== undefined) out = { ...out, visible: !!val.bool }; break;
          case 'OVERRIDDEN_SYMBOL_ID': if (val.guid) out = { ...out, ...swappedLook(n, { overriddenSymbolID: val.guid }), overriddenSymbolID: val.guid }; break;
          case 'TEXT_DATA': // the laid-out glyphs for changed text come with the instance's derived data
            if (val.text && n.textData && val.text.characters !== n.textData.characters && !(ov && ov.derivedTextData)) nope('text set by a component property');
            break;
          case 'SLOT_CONTENT_ID': { // slots: the instance's own content (a frame on the internal page) fills the slot
            const vv = (a.varValue && a.varValue.value) || {}, g2 = vv.slotContentIdValue && vv.slotContentIdValue.guid;
            if (g2 && nodes.has(key(g2))) out = { ...out, slotContent: key(g2) }; else nope('slot content missing from the copy');
            break;
          }
          default: nope('component property ' + r.componentPropNodeField);
        }
      }
      return out;
    }
    function drawLayer(n0, scope) {
      const ov = lookup(scope, n0);
      const n1 = applyProps(applyStyles(ov ? { ...n0, ...swappedLook(n0, ov), ...ov } : n0, ov), ov);
      const outerModes = modeCtx;
      if (n1.type === 'INSTANCE' && n1.symbolData) { const sym = nodes.get(key(n1.overriddenSymbolID || n1.symbolData.symbolID)); if (sym) modeCtx = withModes(modeCtx, sym.variableModeBySetMap); }
      modeCtx = withModes(modeCtx, n1.variableModeBySetMap);
      try { drawLayerIn(n0, scope, applyModes(n1)); } finally { modeCtx = outerModes; }
    }
    function drawLayerIn(n0, scope, n) {
      if (n.visible === false || n.type === 'SLICE') return; // slices never show in exports
      for (const k of unknownFields(n, KNOWN.node, KNOWN.nodePrefix)) nope(`property ${k}`);
      if (fancyUnderline(n)) nope('wavy or dotted underline');
      checkEffects(n);
      const blend = BLEND[n.blendMode], pixelBlend = PIXEL_BLEND[n.blendMode];
      if (!blend && !pixelBlend && !NORMAL_BLEND.includes(n.blendMode)) nope(`${n.blendMode} blend`);
      const blur = visibleEffects(n).find(e => e.type === 'FOREGROUND_BLUR');
      // Opacity on a layer with parts that overlap (children, or a fill under a stroke) fades the
      // finished layer as a whole, so the parts don't show through each other
      const op = n.opacity ?? 1;
      const overlapping = op < 1 && ((kids.get(key(n0.guid)) || []).length || n.type === 'INSTANCE' || n.type === 'BOOLEAN_OPERATION'
        || (n.strokePaints || []).some(p => p.visible !== false) || visibleEffects(n).length);
      if (blend || pixelBlend || blur || overlapping) { // draw the layer on its own, then blend / blur / fade it into what's behind it
        const plain = { ...n, blendMode: 'PASS_THROUGH', effects: (n.effects || []).filter(e => e !== blur), opacity: overlapping ? 1 : n.opacity };
        const alpha = g.globalAlpha * (overlapping ? op : 1);
        isolated++;
        let layer;
        try { layer = offscreen(() => drawNode(plain, n0, scope)); } finally { isolated--; }
        const filter = blur ? `blur(${(blur.radius || 0) / 2 * g.getTransform().a}px)` : 'none';
        if (pixelBlend) {
          if (blur) { const bl = take(), bg = bl.getContext('2d'); bg.filter = filter; bg.drawImage(layer, 0, 0); give(layer); layer = bl; }
          blendPixels(layer, pixelBlend, alpha);
        } else putLayer(layer, blend || 'source-over', alpha, filter);
        give(layer);
        return;
      }
      drawNode(n, n0, scope);
    }
    function drawNode(n, n0, scope) {
      if (!NODE_TYPES.includes(n.type)) nope(`${String(n.type).toLowerCase().replace(/_/g, ' ')} layer`);
      g.save();
      const t = n.transform;
      if (t) g.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
      g.globalAlpha *= (n.opacity ?? 1);
      if (n.type === 'TEXT' || n.type === 'TEXT_PATH') { drawText(n); g.restore(); return; } // text on a path: glyphs carry their own rotation
      // Instances draw their component's children, with the overrides that apply inside them
      let children = kids.get(key(n0.guid)) || [], childScope = scope;
      const outerProps = instanceProps;
      if (n.type === 'INSTANCE' && n.symbolData) {
        const sym = nodes.get(key(n.overriddenSymbolID || n.symbolData.symbolID));
        if (!sym) nope('component missing from the copy');
        else { children = kids.get(key(sym.guid)) || []; childScope = instanceScope(n, scope); }
        instanceProps = new Map((n.componentPropAssignments || []).map(a => [key(a.defID), a]));
      }
      if (n.slotContent) children = kids.get(n.slotContent) || [];
      try { drawNodeBody(n, n0, children, childScope); } finally { instanceProps = outerProps; }
    }
    function drawNodeBody(n, n0, children, childScope) {
      if (n.type === 'BOOLEAN_OPERATION') { drawBoolean(n, children, childScope); g.restore(); return; }
      if (n.derivedImmutableFrameData) { drawImmutable(n); g.restore(); return; }
      if (n.size && !['CANVAS', 'DOCUMENT'].includes(n.type)) {
        // Figma's own outline (stored for vectors and resized instances) beats rebuilding it
        const shape = n.fillGeometry && n.fillGeometry.length && !['FRAME', 'INSTANCE', 'SYMBOL'].includes(n.type) ? geometryPath(n.fillGeometry) : shapeOf(n);
        const isGroup = n.type === 'GROUP' || (n.type === 'FRAME' && n.resizeToFit);
        if (!isGroup) { dropShadows(n, shape); backgroundBlur(n, shape); fillShape(n, shape, n.fillPaints); innerShadows(n, shape); }
        // Auto layout set to "first on top" draws its layers in reverse order
        if (n.stackReverseZIndex && n.stackMode && n.stackMode !== 'NONE' && children.length > 1) {
          if (children.some(c => c.mask)) nope('mask in auto layout with the first layer on top');
          children = [...children].reverse();
        }
        // A group's shadows are cast by its content as a whole (a group has no shape of its own)
        const groupShadows = isGroup ? visibleEffects(n).filter(e => e.type === 'DROP_SHADOW') : [];
        if (isGroup && visibleEffects(n).some(e => e.type === 'INNER_SHADOW' || e.type === 'BACKGROUND_BLUR')) nope('inner shadow or background blur on a group');
        if (groupShadows.length && children.length) {
          const content = offscreen(() => drawChildren(children, childScope));
          // Like a shape's shadow, a group's comes from where it has content, whatever its opacity
          const solid = take(), sg = solid.getContext('2d');
          sg.drawImage(content, 0, 0);
          const id = sg.getImageData(0, 0, solid.width, solid.height), px = id.data;
          for (let k = 3; k < px.length; k += 4) if (px[k]) px[k] = 255;
          sg.putImageData(id, 0, 0);
          for (const e of groupShadows) {
            if (e.spread) nope('shadow spread on a group');
            if (e.showShadowBehindNode === false) { // hidden behind the group's content
              const layer = offscreen(() => castShadow(solid, e)), lg = layer.getContext('2d');
              lg.save(); lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalCompositeOperation = 'destination-out'; lg.drawImage(solid, 0, 0); lg.restore();
              putLayer(layer); give(layer);
            } else castShadow(solid, e);
          }
          putLayer(content);
          give(content, solid);
        } else if (children.length) {
          g.save();
          if (['FRAME', 'SYMBOL', 'INSTANCE'].includes(n.type) && !isGroup && n.frameMaskDisabled === false) g.clip(shape.path);
          drawChildren(children, childScope);
          g.restore();
        }
        if (!isGroup) strokeShape(n, shape);
      } else drawChildren(children, childScope);
      g.restore();
    }
    /* FigJam objects (stickies, shapes with text, connectors) are "immutable frames": a small
     * virtual layer tree. Styling is in nodeGenerationData, Figma's precomputed outlines and laid-out
     * text in derivedImmutableFrameData, both keyed by the virtual layer's path. */
    function drawImmutable(n) {
      const parts = new Map();
      for (const src of [n.nodeGenerationData, n.derivedImmutableFrameData]) {
        for (const o of (src && src.overrides) || []) {
          const { guidPath, ...props } = o;
          if (!guidPath || !guidPath.guids || !guidPath.guids.length) continue;
          const pk = guidPath.guids.map(key).join('/');
          for (const k of unknownFields(props, KNOWN.node, KNOWN.nodePrefix)) nope(`property ${k}`);
          parts.set(pk, { ...(parts.get(pk) || {}), ...props, order: guidPath.guids.map(g => g.localID) });
        }
      }
      // An empty sticky shows Figma's placeholder ("Type anything…") in Copy as PNG; the copy has no
      // letter shapes for it, so refuse rather than paste it blank
      if (n.type === 'STICKY') {
        const body = parts.get('40000000:1');
        if (body && !(body.textData && body.textData.characters)) nope('empty sticky note');
      }
      if (n.type === 'CONNECTOR' && parts.has('40000000:1') && parts.has('40000000:2')) {
        // A connector's label: text (part 1) is placed inside the label box (part 2), drawn on top of it
        const text = parts.get('40000000:1'), box = parts.get('40000000:2'), bt = box.transform, tt = text.transform;
        if (bt && tt) text.transform = { ...tt, m02: bt.m00 * tt.m02 + bt.m01 * tt.m12 + bt.m02, m12: bt.m10 * tt.m02 + bt.m11 * tt.m12 + bt.m12,
          m00: bt.m00 * tt.m00 + bt.m01 * tt.m10, m01: bt.m00 * tt.m01 + bt.m01 * tt.m11, m10: bt.m10 * tt.m00 + bt.m11 * tt.m10, m11: bt.m10 * tt.m01 + bt.m11 * tt.m11 };
        text.order = [...box.order, 1];
      }
      if (n.type === 'TABLE') {
        // Cells (40000000:0/row/column) and their text (40000000:1/row/column) take their look from
        // two template layers (40000000:2 cell, 40000000:3 text); text sits inside its cell.
        const cellLook = parts.get('40000000:2') || {}, textLook = parts.get('40000000:3') || {};
        parts.delete('40000000:2'); parts.delete('40000000:3');
        const mul = (A, B) => ({ m00: A.m00 * B.m00 + A.m01 * B.m10, m01: A.m00 * B.m01 + A.m01 * B.m11, m02: A.m00 * B.m02 + A.m01 * B.m12 + A.m02,
          m10: A.m10 * B.m00 + A.m11 * B.m10, m11: A.m10 * B.m01 + A.m11 * B.m11, m12: A.m10 * B.m02 + A.m11 * B.m12 + A.m12 });
        for (const [pk, p] of parts) {
          const [head, ...rest] = pk.split('/');
          if (head === '40000000:0') { p.fillPaints = p.fillPaints || cellLook.fillPaints; p.strokePaints = p.strokePaints || cellLook.strokePaints; }
          else if (head === '40000000:1') {
            const cell = parts.get(['40000000:0', ...rest].join('/'));
            if (cell && cell.transform && p.transform) p.transform = mul(cell.transform, p.transform);
            p.fillPaints = p.fillPaints || textLook.fillPaints;
          } else nope('table part');
        }
      }
      if (visibleEffects(n).some(e => e.type !== 'DROP_SHADOW')) nope('effects on a FigJam object');
      dropShadows(n, shapeOf(n));
      const byOrder = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); return 0; };
      for (const p of [...parts.values()].sort((a, b) => byOrder(a.order, b.order))) {
        if (p.visible === false) continue;
        g.save();
        const t = p.transform;
        if (t) g.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
        g.globalAlpha *= p.opacity ?? 1;
        const part = { ...p, size: p.size || n.size, name: n.name };
        if (p.fillGeometry && p.fillGeometry.length) fillShape(part, geometryPath(p.fillGeometry), p.fillPaints);
        // strokeGeometry is the stroke's own outline: fill it with the stroke paints
        if (p.strokeGeometry && p.strokeGeometry.length && p.strokePaints) fillShape(part, geometryPath(p.strokeGeometry), p.strokePaints);
        if (p.derivedTextData && p.derivedTextData.glyphs && p.derivedTextData.glyphs.length) drawText({ ...part, fillPaints: p.fillPaints || [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }] });
        g.restore();
      }
    }
    function drawChildren(children, scope) {
      for (let i = 0; i < children.length; i++) {
        const ch = children[i], chOv = lookup(scope, ch), live = chOv ? { ...ch, ...chOv } : ch;
        if (live.mask && live.visible !== false) {
          // A mask layer clips every sibling above it (until the end of the parent)
          const type = live.maskType || 'ALPHA';
          if (!['ALPHA', 'LUMINANCE', 'OUTLINE'].includes(type)) nope(`${type.toLowerCase()} mask`);
          const rest = children.slice(i + 1);
          isolated++;
          let content;
          try { content = offscreen(() => rest.forEach(r => drawLayer(r, scope))); } finally { isolated--; }
          const m = offscreen(() => {
            // An outline (vector) mask uses only the shape, not its fill, stroke or effects
            const saved = { mask: ch.mask, fillPaints: ch.fillPaints, strokePaints: ch.strokePaints, effects: ch.effects, opacity: ch.opacity };
            ch.mask = false;
            if (type === 'OUTLINE') Object.assign(ch, { fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }], strokePaints: [], effects: [], opacity: 1 });
            try { drawLayer(ch, scope); } finally { Object.assign(ch, saved); }
          });
          if (type === 'LUMINANCE') { // brightness of the mask layer becomes its transparency
            const mg = m.getContext('2d'), d = mg.getImageData(0, 0, m.width, m.height), px = d.data;
            for (let k = 0; k < px.length; k += 4) px[k + 3] = (0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2]) * px[k + 3] / 255;
            mg.putImageData(d, 0, 0);
          }
          maskWith(content, m);
          putLayer(content);
          give(content, m);
          return;
        }
        drawLayer(ch, scope);
      }
    }
    function drawBoolean(n, children, scope) {
      if (n.fillGeometry && n.fillGeometry.length) { // Figma's precomputed result
        const shape = geometryPath(n.fillGeometry);
        dropShadows(n, shape); backgroundBlur(n, shape); fillShape(n, shape, n.fillPaints); innerShadows(n, shape); strokeShape(n, shape);
        return;
      }
      if (visibleEffects(n).some(e => e.type !== 'DROP_SHADOW' && e.type !== 'FOREGROUND_BLUR')) nope('effects on a boolean group');
      // The combined shape is built by compositing each child's shape (nested groups recursively)
      const booleanMask = (node, kidsList) => {
        const op = { UNION: 'source-over', SUBTRACT: 'destination-out', INTERSECT: 'destination-in', XOR: 'xor', EXCLUDE: 'xor' }[node.booleanOperation] || 'source-over';
        return offscreen(() => {
          let first = true;
          for (const ch0 of kidsList) {
            const o = lookup(scope, ch0), ch = o ? { ...ch0, ...o } : ch0;
            if (ch.visible === false) continue;
            g.save();
            const t = ch.transform;
            if (t) g.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
            if (ch.type === 'BOOLEAN_OPERATION' && !(ch.fillGeometry && ch.fillGeometry.length)) {
              const inner = booleanMask(ch, kids.get(key(ch0.guid)) || []);
              g.setTransform(1, 0, 0, 1, 0, 0);
              if (!first) g.globalCompositeOperation = op;
              g.drawImage(inner, 0, 0);
              give(inner);
            } else {
              if (!first) g.globalCompositeOperation = op;
              const sh = ch.fillGeometry && ch.fillGeometry.length ? geometryPath(ch.fillGeometry) : shapeOf(ch);
              const hasFill = (ch.fillPaints || []).some(p => p.visible !== false);
              const hasStroke = (ch.strokePaints || []).some(p => p.visible !== false) && ch.strokeWeight > 0;
              if (!hasFill && hasStroke) { // a stroke-only child (like a line) takes part with its stroke outline
                const cap = (sh.ends && sh.ends.length && sh.ends[0].cap) || ch.strokeCap;
                g.lineWidth = ch.strokeWeight; g.lineCap = { ROUND: 'round', SQUARE: 'square' }[cap] || 'butt';
                g.lineJoin = (ch.strokeJoin || 'MITER').toLowerCase(); g.miterLimit = ch.miterLimit || 4; g.strokeStyle = '#000';
                if (sh.ends && sh.ends.some(e => e.cap && !['ROUND', 'SQUARE', 'NONE'].includes(e.cap))) nope('line ends inside a boolean group');
                if (!sh.open && ch.strokeAlign && ch.strokeAlign !== 'CENTER') {
                  // inside / outside: a stroke twice as wide, kept inside or outside the shape
                  const op0 = g.globalCompositeOperation, inside = ch.strokeAlign === 'INSIDE';
                  const ring = offscreen(() => {
                    g.lineWidth = ch.strokeWeight * 2; g.lineJoin = (ch.strokeJoin || 'MITER').toLowerCase(); g.miterLimit = ch.miterLimit || 4;
                    g.strokeStyle = '#000'; g.stroke(sh.path);
                    g.globalCompositeOperation = inside ? 'destination-in' : 'destination-out'; g.fillStyle = '#000'; g.fill(sh.path, sh.rule || 'nonzero');
                  });
                  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = op0; g.drawImage(ring, 0, 0); give(ring);
                } else g.stroke(sh.path);
              } else { g.fillStyle = '#000'; g.fill(sh.path, sh.rule || 'nonzero'); }
            }
            g.restore();
            first = false;
          }
        });
      };
      const shapeMask = booleanMask(n, children);
      dropShadows(n, null, shapeMask);
      for (const p of n.fillPaints || []) {
        if (p.visible === false) continue;
        const layer = offscreen(() => { g.save(); paintArea(n, p); g.restore(); });
        maskWith(layer, shapeMask);
        putLayer(layer, BLEND[p.blendMode] || 'source-over');
        give(layer);
      }
      // Stroke: a boolean group has no outline path, so the stroke band is made from the shape's pixels
      const strokes = (n.strokePaints || []).filter(p => p.visible !== false), sw = n.strokeWeight || 0;
      if (strokes.length && sw) {
        if (n.dashPattern && n.dashPattern.length) nope('dashed stroke on a boolean group');
        const s = g.getTransform().a, align = n.strokeAlign || 'CENTER';
        const grow = (m, r) => { // union of the shape moved around a circle of radius r (device pixels)
          const out = makeCanvas(), og = out.getContext('2d'), steps = Math.max(8, Math.ceil(2 * Math.PI * r));
          og.drawImage(m, 0, 0);
          for (let k = 0; k < steps; k++) { const a = k / steps * 2 * Math.PI; og.drawImage(m, r * Math.cos(a), r * Math.sin(a)); }
          return out;
        };
        const invert = m => { const out = makeCanvas(), og = out.getContext('2d'); og.fillRect(0, 0, out.width, out.height); og.globalCompositeOperation = 'destination-out'; og.drawImage(m, 0, 0); return out; };
        const shrink = (m, r) => invert(grow(invert(m), r));
        const minus = (a, b) => { const og = a.getContext('2d'); og.globalCompositeOperation = 'destination-out'; og.drawImage(b, 0, 0); return a; };
        const band = align === 'INSIDE' ? minus(invert(invert(shapeMask)), shrink(shapeMask, sw * s))
          : align === 'OUTSIDE' ? minus(grow(shapeMask, sw * s), shapeMask)
            : minus(grow(shapeMask, sw * s / 2), shrink(shapeMask, sw * s / 2));
        for (const p of strokes) {
          const layer = offscreen(() => { g.save(); paintArea(n, p, true); g.restore(); });
          maskWith(layer, band);
          putLayer(layer, BLEND[p.blendMode] || 'source-over');
          give(layer);
        }
      }
      give(shapeMask);
    }

    roots.forEach(r => drawLayer(r));
    if (!strict) return { canvas: c, unsupported: [...unsupported], missingImages: [...missingImages] };
    if (missingImages.size) return { reason: 'images', unsupported: [...unsupported] };
    if (unsupported.size) return { reason: 'unsupported', unsupported: [...unsupported] };
    return { canvas: c, name: roots.length === 1 ? roots[0].name : null };
  }

  /** strict: false draws whatever it can and lists what it couldn't (for tests only). */
  async function render(html, { scale = 1, strict = true } = {}) {
    const { meta, msg } = await decode(html);
    const unmanaged = new Set(), hashes = imageHashesIn(msg.nodeChanges, new Set(), new Set(), unmanaged);
    const imgs = hashes.size ? await loadImages(meta.imageHashes || {}, hashes, unmanaged) : new Map();
    // The downloaded images are only needed while drawing: release them right away (a board full of
    // photos otherwise stays in memory until the browser gets around to cleaning up).
    try { return draw(msg, imgs, scale, strict); }
    finally { for (const b of imgs.values()) if (b && b.close) b.close(); }
  }

  window.CutoutFigma = { render, decode };
})();
