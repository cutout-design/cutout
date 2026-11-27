// Builds normal Figma copies (the HTML Figma puts on the clipboard with Ctrl+C) from scratch, so the
// Figma paste can be tested without real Figma files. The format: HTML holding base64 "(figmeta)"
// JSON and a base64 "(figma)" binary: "fig-kiwi", a uint32 version, then chunks (uint32 length +
// bytes). Chunk 0 is a Kiwi schema, chunk 1 the message, both raw deflate (zstd for the message in
// newer copies). The schema travels with every copy, so this small one, using Figma's field names,
// is read the same way as Figma's own.
import zlib from 'node:zlib';

/* ---------- a tiny Kiwi writer (https://github.com/evanw/kiwi, binary format) */
class Writer {
  constructor() { this.bytes = []; }
  byte(v) { this.bytes.push(v & 255); }
  varUint(v) { do { let b = v & 127; v >>>= 7; this.byte(v ? b | 128 : b); } while (v); }
  varInt(v) { this.varUint(((v << 1) ^ (v >> 31)) >>> 0); }
  varFloat(v) {
    const f = new Float32Array([v]), i = new Int32Array(f.buffer)[0], bits = (i >>> 23) | (i << 9);
    if (!(bits & 255)) { this.byte(0); return; }
    this.byte(bits); this.byte(bits >> 8); this.byte(bits >> 16); this.byte(bits >> 24);
  }
  string(s) { for (const b of Buffer.from(s, 'utf8')) this.byte(b); this.byte(0); }
  get u8() { return Uint8Array.from(this.bytes); }
}

const NATIVE = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KIND = { ENUM: 0, STRUCT: 1, MESSAGE: 2 };

/* The schema: just what the tests use. Fields are [name, type, isArray]; message fields get tags
 * 1, 2, 3… in order. `futureFeature` stands in for a field Figma adds later (Cutout must refuse it). */
const DEFS = [
  ['NodeType', 'ENUM', ['NONE', 'DOCUMENT', 'CANVAS', 'GROUP', 'FRAME', 'BOOLEAN_OPERATION', 'VECTOR', 'STAR', 'LINE', 'ELLIPSE', 'RECTANGLE', 'REGULAR_POLYGON', 'ROUNDED_RECTANGLE', 'TEXT', 'SLICE', 'SYMBOL', 'INSTANCE']],
  ['PaintType', 'ENUM', ['SOLID', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND', 'IMAGE']],
  ['EffectType', 'ENUM', ['INNER_SHADOW', 'DROP_SHADOW', 'FOREGROUND_BLUR', 'BACKGROUND_BLUR']],
  ['StrokeAlign', 'ENUM', ['CENTER', 'INSIDE', 'OUTSIDE']],
  ['GUID', 'STRUCT', [['sessionID', 'uint'], ['localID', 'uint']]],
  ['Color', 'STRUCT', [['r', 'float'], ['g', 'float'], ['b', 'float'], ['a', 'float']]],
  ['Vector', 'STRUCT', [['x', 'float'], ['y', 'float']]],
  ['Matrix', 'STRUCT', [['m00', 'float'], ['m01', 'float'], ['m02', 'float'], ['m10', 'float'], ['m11', 'float'], ['m12', 'float']]],
  ['ColorStop', 'STRUCT', [['color', 'Color'], ['position', 'float']]],
  ['ParentIndex', 'MESSAGE', [['guid', 'GUID'], ['position', 'string']]],
  ['Image', 'MESSAGE', [['hash', 'byte', true], ['name', 'string']]],
  ['Paint', 'MESSAGE', [['type', 'PaintType'], ['color', 'Color'], ['opacity', 'float'], ['visible', 'bool'], ['stops', 'ColorStop', true], ['transform', 'Matrix'], ['image', 'Image']]],
  ['Effect', 'MESSAGE', [['type', 'EffectType'], ['color', 'Color'], ['offset', 'Vector'], ['radius', 'float'], ['visible', 'bool'], ['spread', 'float']]],
  ['TextData', 'MESSAGE', [['characters', 'string']]],
  ['NodeChange', 'MESSAGE', [['guid', 'GUID'], ['parentIndex', 'ParentIndex'], ['type', 'NodeType'], ['name', 'string'], ['visible', 'bool'],
    ['opacity', 'float'], ['size', 'Vector'], ['transform', 'Matrix'], ['fillPaints', 'Paint', true], ['strokePaints', 'Paint', true],
    ['strokeWeight', 'float'], ['strokeAlign', 'StrokeAlign'], ['cornerRadius', 'float'], ['effects', 'Effect', true],
    ['frameMaskDisabled', 'bool'], ['textData', 'TextData'], ['futureFeature', 'string']]],
  ['Blob', 'MESSAGE', [['bytes', 'byte', true]]],
  ['Message', 'MESSAGE', [['nodeChanges', 'NodeChange', true], ['blobs', 'Blob', true]]],
];
const byName = new Map(DEFS.map(([name, kind, fields], i) => [name, { name, kind, fields, index: i }]));

function encodeSchema() {
  const w = new Writer();
  w.varUint(DEFS.length);
  for (const [name, kind, fields] of DEFS) {
    w.string(name); w.byte(KIND[kind]); w.varUint(fields.length);
    fields.forEach((f, i) => {
      if (kind === 'ENUM') { w.string(f); w.varInt(0); w.byte(0); w.varUint(i); return; }
      const [fname, type, isArray] = f, nat = NATIVE.indexOf(type);
      w.string(fname); w.varInt(nat >= 0 ? ~nat : byName.get(type).index); w.byte(isArray ? 1 : 0); w.varUint(kind === 'MESSAGE' ? i + 1 : i);
    });
  }
  return w.u8;
}

function encodeValue(w, type, v) {
  switch (type) {
    case 'bool': case 'byte': w.byte(v ? (type === 'bool' ? 1 : v) : 0); return;
    case 'int': w.varInt(v); return;
    case 'uint': w.varUint(v); return;
    case 'float': w.varFloat(v); return;
    case 'string': w.string(v); return;
  }
  const d = byName.get(type);
  if (!d) throw new Error('No type ' + type);
  if (d.kind === 'ENUM') { const i = d.fields.indexOf(v); if (i < 0) throw new Error(`${type} has no ${v}`); w.varUint(i); return; }
  if (d.kind === 'STRUCT') { for (const [n, t] of d.fields) encodeValue(w, t, v[n] ?? 0); return; }
  d.fields.forEach(([n, t, isArray], i) => {
    if (v[n] == null) return;
    w.varUint(i + 1);
    if (!isArray) { encodeValue(w, t, v[n]); return; }
    w.varUint(v[n].length);
    if (t === 'byte') { for (const b of v[n]) w.byte(b); return; }
    for (const item of v[n]) encodeValue(w, t, item);
  });
  for (const k of Object.keys(v)) if (!d.fields.some(f => f[0] === k)) throw new Error(`${type} has no field ${k}`);
  w.varUint(0);
}

/* ---------- building copies */
export const solid = (r, g, b, a = 1, more = {}) => ({ type: 'SOLID', color: { r, g, b, a }, opacity: 1, visible: true, ...more });
export const at = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });

/** nodes: [{ type, name, x, y, w, h, parent (index into nodes, or absent for a top-level layer), ...fields }].
 *  Returns the clipboard HTML. zstd: compress the message with zstd (newer Figma) instead of deflate. */
export function figmaCopy(nodes, { zstd = false, imageHashes = {} } = {}) {
  let id = 10;
  const doc = { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', name: 'Document' };
  const page = { guid: { sessionID: 0, localID: 1 }, parentIndex: { guid: doc.guid, position: '!' }, type: 'CANVAS', name: 'Page 1' };
  const guids = nodes.map(() => ({ sessionID: 1, localID: id++ }));
  const changes = [doc, page, ...nodes.map((n, i) => {
    const { x = 0, y = 0, w, h, parent, ...rest } = n;
    const parentGuid = parent == null ? page.guid : guids[parent];
    return { guid: guids[i], parentIndex: { guid: parentGuid, position: String.fromCharCode(34 + i) }, visible: true, opacity: 1,
      size: { x: w, y: h }, transform: at(x, y), ...rest };
  })];
  const mw = new Writer(); encodeValue(mw, 'Message', { nodeChanges: changes, blobs: [] });
  const schema = zlib.deflateRawSync(encodeSchema());
  const message = zstd ? zlib.zstdCompressSync(mw.u8) : zlib.deflateRawSync(mw.u8);
  const head = Buffer.alloc(12); head.write('fig-kiwi', 0, 'latin1'); head.writeUInt32LE(48, 8);
  const len = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const bin = Buffer.concat([head, len(schema.length), schema, len(message.length), message]);
  const meta = Buffer.from(JSON.stringify({ fileKey: 'test', pasteID: 1, dataType: 'scene', imageHashes })).toString('base64');
  return `<meta charset="utf-8"><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${bin.toString('base64')}(/figma)-->"></span>`;
}
export const canZstd = typeof zlib.zstdCompressSync === 'function';
