/* Cutout: fill a selection from its surroundings (content-aware fill, no AI).
 *
 * Three ways, chosen by looking at the rim of the hole:
 * - Blocks of flat color (UI: cards, panels, the gaps between them): each pixel takes the block
 *   most of its four straight-line neighbours on the rim belong to, then blends within that block.
 *   Rebuilds cards and gaps that run through the hole; it can only continue colors from the rim.
 * - Smooth (one flat color or a gradient): a smooth blend from the edges (harmonic fill), exact for
 *   these and it can't make anything up.
 * - Texture or pattern: patch-based image completion (Wexler et al. 2007) with PatchMatch
 *   (Barnes et al. 2009), coarse to fine: the hole is rebuilt from 7×7 patches copied from around
 *   it, so grass, bricks and the like continue through. When the selection cuts through other
 *   things, this can stitch together shapes that weren't there.
 *
 * `cutoutPatchFill(data, W, H, mask)` is one self-contained function (no outside references)
 * so app.js can also run it in a Web Worker from its source text. `data` is RGBA
 * (Uint8ClampedArray, changed in place); `mask` is 1 where pixels should be filled.
 * Returns false when there aren't enough surroundings to copy from.
 */
function cutoutPatchFill(data, W0, H0, mask0, force) { // force: 'smooth' or 'patch' (tests only)
  const R = 3, P = 2 * R + 1; // 7×7 patches
  let seed = 12345; const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  function down(l) {
    const W = Math.max(1, l.W >> 1), H = Math.max(1, l.H >> 1), col = new Float32Array(W * H * 4), hole = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let n = 0, h = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = Math.min(l.H - 1, 2 * y + dy) * l.W + Math.min(l.W - 1, 2 * x + dx);
        if (l.hole[i]) { h = 1; continue; }
        s0 += l.col[i * 4]; s1 += l.col[i * 4 + 1]; s2 += l.col[i * 4 + 2]; s3 += l.col[i * 4 + 3]; n++;
      }
      const o = y * W + x; hole[o] = h;
      if (n) { col[o * 4] = s0 / n; col[o * 4 + 1] = s1 / n; col[o * 4 + 2] = s2 / n; col[o * 4 + 3] = s3 / n; }
    }
    return { W, H, col, hole };
  }

  // First guess at the coarsest level: blend of the nearest known pixels left, right, above, below.
  function initGuess(l) {
    const { W, H, col, hole } = l;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (!hole[i]) continue;
      let L = x, Rr = x, U = y, D = y;
      while (L >= 0 && hole[y * W + L]) L--; while (Rr < W && hole[y * W + Rr]) Rr++;
      while (U >= 0 && hole[U * W + x]) U--; while (D < H && hole[D * W + x]) D++;
      const pts = [];
      if (L >= 0) pts.push([y * W + L, 1 / (x - L)]); if (Rr < W) pts.push([y * W + Rr, 1 / (Rr - x)]);
      if (U >= 0) pts.push([U * W + x, 1 / (y - U)]); if (D < H) pts.push([D * W + x, 1 / (D - y)]);
      let ws = 0; const s = [0, 0, 0, 0];
      for (const [j, w] of pts) { ws += w; for (let c = 0; c < 4; c++) s[c] += col[j * 4 + c] * w; }
      for (let c = 0; c < 4; c++) col[i * 4 + c] = ws ? s[c] / ws : 0;
    }
  }

  function solveLevel(l, nnf, emIters, passes, searchRad) {
    const { W, H, col, hole } = l, N = W * H;
    // Where a source patch can sit: wholly inside the image and outside the hole.
    const valid = new Uint8Array(N), srcList = [];
    const rowHole = new Int32Array(N); // hole pixels in the row segment [x-R, x+R]
    for (let y = 0; y < H; y++) { let run = 0;
      for (let x = 0; x < W + R; x++) {
        if (x < W) run += hole[y * W + x];
        if (x - 2 * R - 1 >= 0) run -= hole[y * W + x - 2 * R - 1];
        if (x - R >= 0) rowHole[y * W + x - R] = run;
      } }
    for (let y = R; y < H - R; y++) for (let x = R; x < W - R; x++) {
      let n = 0; for (let dy = -R; dy <= R && !n; dy++) n += rowHole[(y + dy) * W + x];
      if (!n) { valid[y * W + x] = 1; srcList.push(y * W + x); }
    }
    if (!srcList.length) return false;
    // Targets: every pixel whose patch touches the hole.
    const isT = new Uint8Array(N), targets = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let n = 0; for (let dy = -R; dy <= R && !n; dy++) { const yy = y + dy; if (yy >= 0 && yy < H) n += rowHole[yy * W + x]; }
      if (n) { isT[y * W + x] = 1; targets.push(y * W + x); }
    }
    const dist = new Float32Array(N);
    const D = (p, q, best) => {
      const px = p % W, py = (p / W) | 0, qx = q % W, qy = (q / W) | 0; let s = 0;
      for (let dy = -R; dy <= R; dy++) { const y1 = py + dy; if (y1 < 0 || y1 >= H) continue;
        const ra = y1 * W, rb = (qy + dy) * W;
        for (let dx = -R; dx <= R; dx++) { const x1 = px + dx; if (x1 < 0 || x1 >= W) continue;
          const a = (ra + x1) * 4, b = (rb + qx + dx) * 4;
          const e0 = col[a] - col[b], e1 = col[a + 1] - col[b + 1], e2 = col[a + 2] - col[b + 2], e3 = col[a + 3] - col[b + 3];
          s += e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3; }
        if (s >= best) return s; }
      return s;
    };
    for (const p of targets) if (nnf[p] < 0 || !valid[nnf[p]]) nnf[p] = srcList[(rand() * srcList.length) | 0];
    const tryQ = (p, q) => { if (q >= 0 && q < N && valid[q]) { const d = D(p, q, dist[p]); if (d < dist[p]) { dist[p] = d; nnf[p] = q; } } };
    const pass = rev => {
      const n = targets.length, s = rev ? 1 : -1;
      for (let k = 0; k < n; k++) {
        const p = targets[rev ? n - 1 - k : k], x = p % W, y = (p / W) | 0;
        // propagation: a neighbour's match, shifted by one
        if (x + s >= 0 && x + s < W && isT[p + s]) { const q = nnf[p + s]; const qx = (q % W) - s; if (qx >= 0 && qx < W) tryQ(p, q - s); }
        if (y + s >= 0 && y + s < H && isT[p + s * W]) tryQ(p, nnf[p + s * W] - s * W);
        // random search around the current match, in shrinking windows
        const qx0 = nnf[p] % W, qy0 = (nnf[p] / W) | 0;
        for (let rad = searchRad; rad >= 1; rad >>= 1) {
          const qx = qx0 + Math.round((rand() * 2 - 1) * rad), qy = qy0 + Math.round((rand() * 2 - 1) * rad);
          if (qx >= 0 && qx < W && qy >= 0 && qy < H) tryQ(p, qy * W + qx);
        }
      }
    };
    // Each hole pixel becomes the weighted average of what the overlapping patches say it should be.
    const acc = new Float32Array(N * 4), wsum = new Float32Array(N);
    const vote = () => {
      const ds = Float32Array.from(targets, p => dist[p]).sort();
      const sigma2 = Math.max(1, ds[Math.floor(ds.length * 0.75)] || 1);
      acc.fill(0); wsum.fill(0);
      for (const p of targets) {
        const w = Math.exp(-dist[p] / (2 * sigma2)) + 1e-6;
        const px = p % W, py = (p / W) | 0, q = nnf[p], qx = q % W, qy = (q / W) | 0;
        for (let dy = -R; dy <= R; dy++) { const y1 = py + dy; if (y1 < 0 || y1 >= H) continue;
          for (let dx = -R; dx <= R; dx++) { const x1 = px + dx; if (x1 < 0 || x1 >= W) continue;
            const t = y1 * W + x1; if (!hole[t]) continue;
            const b = ((qy + dy) * W + qx + dx) * 4, o = t * 4;
            acc[o] += w * col[b]; acc[o + 1] += w * col[b + 1]; acc[o + 2] += w * col[b + 2]; acc[o + 3] += w * col[b + 3]; wsum[t] += w; } }
      }
      for (let t = 0; t < N; t++) if (hole[t] && wsum[t] > 0) { const o = t * 4, w = wsum[t]; col[o] = acc[o] / w; col[o + 1] = acc[o + 1] / w; col[o + 2] = acc[o + 2] / w; col[o + 3] = acc[o + 3] / w; }
    };
    for (let it = 0; it < emIters; it++) {
      for (const p of targets) dist[p] = D(p, nnf[p], Infinity);
      for (let k = 0; k < passes; k++) pass(k % 2 === 1);
      vote();
    }
    return true;
  }

  const N0 = W0 * H0, col0 = new Float32Array(N0 * 4);
  for (let i = 0; i < N0 * 4; i++) col0[i] = data[i];
  const levels = [{ W: W0, H: H0, col: col0, hole: Uint8Array.from(mask0) }];
  let minX = W0, minY = H0, maxX = -1, maxY = -1;
  for (let i = 0; i < N0; i++) if (mask0[i]) { const x = i % W0, y = (i / W0) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  if (maxX < 0) return true; // nothing to fill
  const ext = Math.max(maxX - minX, maxY - minY) + 1;

  // Smooth surroundings (a flat color, a gradient)? Then a smooth blend from the edges is exact
  // and can't make anything up; patches are only for texture and patterns (near a hole they can
  // copy bits of nearby things, like the end of a message bubble). Test: predict a thin band
  // around the hole from the pixels beyond it, and see whether the prediction holds.
  const interp = (col, m, i, out) => { // row and column interpolation between the nearest known pixels
    const x = i % W0, y = (i / W0) | 0; let L = x, Rr = x, U = y, Dn = y;
    while (L >= 0 && m[y * W0 + L]) L--; while (Rr < W0 && m[y * W0 + Rr]) Rr++;
    while (U >= 0 && m[U * W0 + x]) U--; while (Dn < H0 && m[Dn * W0 + x]) Dn++;
    const pts = [];
    if (L >= 0) pts.push(y * W0 + L, 1 / (x - L)); if (Rr < W0) pts.push(y * W0 + Rr, 1 / (Rr - x));
    if (U >= 0) pts.push(U * W0 + x, 1 / (y - U)); if (Dn < H0) pts.push(Dn * W0 + x, 1 / (Dn - y));
    out[0] = out[1] = out[2] = out[3] = 0; let ws = 0;
    for (let k = 0; k < pts.length; k += 2) { const j = pts[k] * 4, w = pts[k + 1]; ws += w; for (let c = 0; c < 4; c++) out[c] += col[j + c] * w; }
    if (ws) for (let c = 0; c < 4; c++) out[c] /= ws;
    return ws > 0;
  };
  const smoothAround = () => {
    const B = 6, wide = new Uint8Array(N0), tmp = new Uint8Array(N0);
    for (let y = 0; y < H0; y++) { let run = 0; // dilate the hole by B: rows, then columns
      for (let x = 0; x < W0 + B; x++) { if (x < W0) run += mask0[y * W0 + x]; if (x - 2 * B - 1 >= 0) run -= mask0[y * W0 + x - 2 * B - 1]; if (x - B >= 0 && run) tmp[y * W0 + x - B] = 1; } }
    for (let x = 0; x < W0; x++) { let run = 0;
      for (let y = 0; y < H0 + B; y++) { if (y < H0) run += tmp[y * W0 + x]; if (y - 2 * B - 1 >= 0) run -= tmp[(y - 2 * B - 1) * W0 + x]; if (y - B >= 0 && run) wide[(y - B) * W0 + x] = 1; } }
    const p = [0, 0, 0, 0]; let band = 0, off = 0;
    for (let i = 0; i < N0; i++) {
      if (!wide[i] || mask0[i]) continue;
      if (!interp(col0, wide, i, p)) continue;
      band++;
      let e = 0; for (let c = 0; c < 4; c++) e = Math.max(e, Math.abs(p[c] - col0[i * 4 + c]));
      if (e > 8) off++;
    }
    return band > 0 && off <= band * 0.02;
  };

  // Blocks of flat color (UI: cards, panels, the gaps between them)? Split the rim of the hole
  // into runs of one color ("regions"). Returns null for texture: too many regions, or not flat.
  const rimRegions = () => {
    const pos = new Int32Array(N0).fill(-1), rim = [];
    for (let i = 0; i < N0; i++) {
      if (mask0[i]) continue;
      const x = i % W0;
      if ((x > 0 && mask0[i - 1]) || (x < W0 - 1 && mask0[i + 1]) || (i >= W0 && mask0[i - W0]) || (i < N0 - W0 && mask0[i + W0])) { pos[i] = rim.length; rim.push(i); }
    }
    if (!rim.length) return null;
    const n = rim.length, par = new Int32Array(n).map((_, k) => k);
    const find = k => { while (par[k] !== k) k = par[k] = par[par[k]]; return k; };
    const diff = (a, b) => Math.max(Math.abs(col0[a * 4] - col0[b * 4]), Math.abs(col0[a * 4 + 1] - col0[b * 4 + 1]), Math.abs(col0[a * 4 + 2] - col0[b * 4 + 2]), Math.abs(col0[a * 4 + 3] - col0[b * 4 + 3]));
    for (let k = 0; k < n; k++) { // join neighbouring rim pixels of nearly the same color
      const i = rim[k], x = i % W0, y = (i / W0) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= W0 || yy >= H0) continue;
        const j = pos[yy * W0 + xx]; if (j > k && diff(i, rim[j]) <= 10) { const a = find(k), b = find(j); if (a !== b) par[a] = b; }
      }
    }
    // runs: size and mean color
    const runOf = new Int32Array(n), runs = new Map();
    for (let k = 0; k < n; k++) { const r = find(k); runOf[k] = r; let s = runs.get(r); if (!s) runs.set(r, s = { n: 0, c: [0, 0, 0, 0] }); s.n++; for (let c = 0; c < 4; c++) s.c[c] += col0[rim[k] * 4 + c]; }
    if (runs.size > 400) return null; // texture
    for (const s of runs.values()) s.c = s.c.map(v => v / s.n);
    // regions: big runs of the same color are one region (e.g. a card's left and right edges);
    // small runs (antialiased edges, specks) join the region with the closest color
    const big = [...runs.entries()].filter(([, s]) => s.n >= 6), regions = [];
    if (big.length > 24) return null; // a pattern (bricks, tiles): patches do better
    for (const [r, s] of big) {
      let g = regions.find(g => Math.max(...g.c.map((v, c) => Math.abs(v - s.c[c]))) <= 12);
      if (!g) regions.push(g = { c: s.c, n: 0, runs: [] });
      g.runs.push(r); g.n += s.n;
    }
    if (!regions.length || regions.length > 8) return null;
    let small = 0; const regionOfRun = new Map();
    regions.forEach((g, gi) => g.runs.forEach(r => regionOfRun.set(r, gi)));
    for (const [r, s] of runs) if (!regionOfRun.has(r)) {
      small += s.n; let best = 0, bd = Infinity;
      regions.forEach((g, gi) => { const d = Math.max(...g.c.map((v, c) => Math.abs(v - s.c[c]))); if (d < bd) { bd = d; best = gi; } });
      regionOfRun.set(r, best);
    }
    if (small > n * 0.05) return null; // lots of specks: texture or text along the rim (patches do better)
    // each region must be (nearly) flat
    const label = new Int32Array(N0).fill(-1), runLen = new Int32Array(N0); let off = 0;
    for (let k = 0; k < n; k++) {
      const g = regionOfRun.get(runOf[k]), i = rim[k], len = runs.get(runOf[k]).n; label[i] = g; runLen[i] = len;
      if (len >= 6 && Math.max(...regions[g].c.map((v, c) => Math.abs(v - col0[i * 4 + c]))) > 20) off++;
    }
    if (off > n * 0.05) return null;
    return { label, runLen, count: regions.length };
  };

  // Fill block by block: each hole pixel takes the region that most of its four straight-line
  // neighbours on the rim belong to, then blends smoothly within that region. When left/right agree
  // and up/down agree on different regions, the thinner one wins: a thin run on the rim (a gap,
  // a divider) is a line that continues straight through. Other ties go to the closest.
  const fillRegions = ({ label, runLen }) => {
    const L = new Int32Array(N0 * 4).fill(-1); // nearest rim pixel left, right, up, down
    for (let y = 0; y < H0; y++) {
      let last = -1; for (let x = 0; x < W0; x++) { const i = y * W0 + x; if (!mask0[i]) last = i; else { L[i * 4] = last; } }
      last = -1; for (let x = W0 - 1; x >= 0; x--) { const i = y * W0 + x; if (!mask0[i]) last = i; else L[i * 4 + 1] = last; }
    }
    for (let x = 0; x < W0; x++) {
      let last = -1; for (let y = 0; y < H0; y++) { const i = y * W0 + x; if (!mask0[i]) last = i; else L[i * 4 + 2] = last; }
      last = -1; for (let y = H0 - 1; y >= 0; y--) { const i = y * W0 + x; if (!mask0[i]) last = i; else L[i * 4 + 3] = last; }
    }
    const lab = Int32Array.from(label), holes = [];
    const J = new Int32Array(4), G = new Int32Array(4), D = new Int32Array(4);
    // (a hole pixel no rim pixel can see along a straight line keeps its region -1 and is blended from any neighbours)
    for (let i = 0; i < N0; i++) {
      if (!mask0[i]) continue;
      holes.push(i);
      const x = i % W0, y = (i / W0) | 0;
      for (let d = 0; d < 4; d++) {
        const j = L[i * 4 + d]; J[d] = j; G[d] = j >= 0 ? label[j] : -1;
        D[d] = j < 0 ? 0 : d < 2 ? Math.abs((j % W0) - x) : Math.abs(((j / W0) | 0) - y);
      }
      let best = -1;
      if (G[0] >= 0 && G[0] === G[1] && G[2] >= 0 && G[2] === G[3] && G[0] !== G[2]) {
        best = Math.max(runLen[J[0]], runLen[J[1]]) <= Math.max(runLen[J[2]], runLen[J[3]]) ? G[0] : G[2];
      } else {
        let bn = 0, bd = Infinity;
        for (let a = 0; a < 4; a++) {
          if (G[a] < 0) continue;
          let cnt = 0, md = Infinity;
          for (let b = 0; b < 4; b++) if (G[b] === G[a]) { cnt++; if (D[b] < md) md = D[b]; }
          if (cnt > bn || (cnt === bn && md < bd)) { best = G[a]; bn = cnt; bd = md; }
        }
      }
      lab[i] = best;
      // start from the rim pixels of the same region it can see (closer counts more)
      let ws = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let d = 0; d < 4; d++) {
        if (G[d] !== best || best < 0) continue;
        const w = 1 / Math.max(1, D[d]), o = J[d] * 4;
        ws += w; s0 += col0[o] * w; s1 += col0[o + 1] * w; s2 += col0[o + 2] * w; s3 += col0[o + 3] * w;
      }
      if (ws) { const o = i * 4; col0[o] = s0 / ws; col0[o + 1] = s1 / ws; col0[o + 2] = s2 / ws; col0[o + 3] = s3 / ws; }
    }
    // smooth within each region (its own rim and hole pixels only). The start is already a blend of
    // the rim, so a few rounds do; flat regions are exact at once, slight noise stops it at 40.
    // Only pixels next to one that still changed get another round.
    let act = Int32Array.from(holes); const queued = new Uint8Array(N0);
    for (let it = 0; it < 40 && act.length; it++) {
      const next = [];
      for (let k = 0; k < act.length; k++) {
        const i = act[k]; queued[i] = 0;
        const x = i % W0, g = lab[i]; let n = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0, o;
        if (x > 0 && lab[i - 1] === g) { o = (i - 1) * 4; s0 += col0[o]; s1 += col0[o + 1]; s2 += col0[o + 2]; s3 += col0[o + 3]; n++; }
        if (x < W0 - 1 && lab[i + 1] === g) { o = (i + 1) * 4; s0 += col0[o]; s1 += col0[o + 1]; s2 += col0[o + 2]; s3 += col0[o + 3]; n++; }
        if (i >= W0 && lab[i - W0] === g) { o = (i - W0) * 4; s0 += col0[o]; s1 += col0[o + 1]; s2 += col0[o + 2]; s3 += col0[o + 3]; n++; }
        if (i < N0 - W0 && lab[i + W0] === g) { o = (i + W0) * 4; s0 += col0[o]; s1 += col0[o + 1]; s2 += col0[o + 2]; s3 += col0[o + 3]; n++; }
        if (!n) continue;
        o = i * 4;
        const d0 = s0 / n - col0[o], d1 = s1 / n - col0[o + 1], d2 = s2 / n - col0[o + 2], d3 = s3 / n - col0[o + 3];
        col0[o] += 1.9 * d0; col0[o + 1] += 1.9 * d1; col0[o + 2] += 1.9 * d2; col0[o + 3] += 1.9 * d3;
        if (Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(d3)) < 0.25) continue;
        for (const j of [x > 0 ? i - 1 : -1, x < W0 - 1 ? i + 1 : -1, i - W0, i + W0])
          if (j >= 0 && j < N0 && mask0[j] && lab[j] === g && !queued[j]) { queued[j] = 1; next.push(j); }
      }
      act = next;
    }
    for (const i of holes) for (let c = 0; c < 4; c++) data[i * 4 + c] = col0[i * 4 + c];
    return true;
  };

  const regions = force ? null : rimRegions();
  if (force === 'regions' || (regions && regions.count > 1)) return fillRegions(regions || rimRegions());
  if (force === 'smooth' || (force !== 'patch' && smoothAround())) {
    // Smooth (harmonic) fill, coarse to fine: each hole pixel becomes the average of its neighbours.
    // Stops early once nothing changes any more (a flat background is exact after one round).
    const relax = (l, iters) => {
      const { W, H, col, hole } = l, N = W * H;
      let n0 = 0; for (let i = 0; i < N; i++) if (hole[i]) n0++;
      let act = new Int32Array(n0); for (let i = 0, k = 0; i < N; i++) if (hole[i]) act[k++] = i;
      const queued = new Uint8Array(N);
      for (let it = 0; it < iters && act.length; it++) { // only pixels next to one that still changed
        const next = [];
        for (let k = 0; k < act.length; k++) {
          const i = act[k], x = i % W; let n = 0, s0 = 0, s1 = 0, s2 = 0, s3 = 0, o; queued[i] = 0;
          if (x > 0) { o = (i - 1) * 4; s0 += col[o]; s1 += col[o + 1]; s2 += col[o + 2]; s3 += col[o + 3]; n++; }
          if (x < W - 1) { o = (i + 1) * 4; s0 += col[o]; s1 += col[o + 1]; s2 += col[o + 2]; s3 += col[o + 3]; n++; }
          if (i >= W) { o = (i - W) * 4; s0 += col[o]; s1 += col[o + 1]; s2 += col[o + 2]; s3 += col[o + 3]; n++; }
          if (i < N - W) { o = (i + W) * 4; s0 += col[o]; s1 += col[o + 1]; s2 += col[o + 2]; s3 += col[o + 3]; n++; }
          o = i * 4;
          const d0 = s0 / n - col[o], d1 = s1 / n - col[o + 1], d2 = s2 / n - col[o + 2], d3 = s3 / n - col[o + 3];
          col[o] += 1.9 * d0; col[o + 1] += 1.9 * d1; col[o + 2] += 1.9 * d2; col[o + 3] += 1.9 * d3;
          if (Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2), Math.abs(d3)) < 0.1) continue;
          for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W])
            if (j >= 0 && j < N && hole[j] && !queued[j]) { queued[j] = 1; next.push(j); }
        }
        act = next;
      }
    };
    const hl = [levels[0]];
    while (hl.length < 10 && (ext >> (hl.length - 1)) > 16 && Math.min(hl[hl.length - 1].W, hl[hl.length - 1].H) >= 32) hl.push(down(hl[hl.length - 1]));
    initGuess(hl[hl.length - 1]); relax(hl[hl.length - 1], 300);
    for (let k = hl.length - 2; k >= 0; k--) {
      const l = hl[k], c = hl[k + 1];
      for (let i = 0; i < l.W * l.H; i++) if (l.hole[i]) {
        const j = Math.min(c.H - 1, ((i / l.W) | 0) >> 1) * c.W + Math.min(c.W - 1, (i % l.W) >> 1);
        for (let ch = 0; ch < 4; ch++) l.col[i * 4 + ch] = c.col[j * 4 + ch];
      }
      relax(l, k === 0 ? 100 : 60);
    }
    for (let i = 0; i < N0; i++) if (mask0[i]) for (let c = 0; c < 4; c++) data[i * 4 + c] = col0[i * 4 + c];
    return true;
  }

  // Halve until the hole is only a couple of patches across (or the image gets too small).
  while (levels.length < 10) {
    const l = levels[levels.length - 1];
    if ((ext >> (levels.length - 1)) <= 2 * P || Math.min(l.W, l.H) < 6 * P) break;
    levels.push(down(l));
  }
  const top = levels[levels.length - 1];
  initGuess(top);
  let nnf = new Int32Array(top.W * top.H).fill(-1);
  for (let k = levels.length - 1; k >= 0; k--) {
    const l = levels[k];
    if (k < levels.length - 1) {
      // Carry the matches up from the coarser level, and start the hole from them.
      const c = levels[k + 1], up = new Int32Array(l.W * l.H).fill(-1);
      for (let y = 0; y < l.H; y++) for (let x = 0; x < l.W; x++) {
        const q = nnf[Math.min(c.H - 1, y >> 1) * c.W + Math.min(c.W - 1, x >> 1)];
        if (q < 0) continue;
        const qx = 2 * (q % c.W) + (x & 1), qy = 2 * ((q / c.W) | 0) + (y & 1);
        if (qx < l.W && qy < l.H) up[y * l.W + x] = qy * l.W + qx;
      }
      nnf = up;
      for (let i = 0; i < l.W * l.H; i++) if (l.hole[i]) {
        const q = nnf[i];
        const from = q >= 0 && !l.hole[q] ? { a: l.col, j: q } : { a: c.col, j: Math.min(c.H - 1, ((i / l.W) | 0) >> 1) * c.W + Math.min(c.W - 1, (i % l.W) >> 1) };
        for (let ch = 0; ch < 4; ch++) l.col[i * 4 + ch] = from.a[from.j * 4 + ch];
      }
    }
    const coarsest = k === levels.length - 1;
    // Finer levels start from good matches, so they only need to look nearby.
    // The full-size level only refines what the coarser ones found: one round, one pass;
    // the levels in between two of each. (10 rounds at the coarsest, where it is cheap.)
    if (!solveLevel(l, nnf, coarsest ? 10 : k === 0 ? 1 : 2, k === 0 ? 1 : 2, coarsest ? Math.max(l.W, l.H) : 32)) return false;
  }
  const f = levels[0].col;
  for (let i = 0; i < N0; i++) if (mask0[i]) for (let c = 0; c < 4; c++) data[i * 4 + c] = f[i * 4 + c];
  return true;
}
