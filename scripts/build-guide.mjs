// Builds the user guide page of the website (cutout.design/guide/) from docs/user-guide.md, and the
// privacy page (cutout.design/privacy/) from docs/privacy.md. The pages reuse site/index.html's
// styles, header, footer and theme switch, so they always match the site. Run by .github/workflows/website.yml:
//   MARKED=<folder of the marked package> GUIDE_DOCS=<docs folder> node scripts/build-guide.mjs <site output folder>
// GUIDE_DOCS is the latest release's docs/ folder, so the guide's text matches the downloads (default: this
// checkout's docs/). Its images come from this checkout's docs/images when they exist (see imgSrc). The privacy page always comes from this checkout's docs/ (main), so a change to
// it goes live without waiting for a release. marked (MIT) is installed only for this step, outside the app.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/build-guide.mjs <site output folder>'); process.exit(1); }
const markedDir = process.env.MARKED || 'node_modules/marked';
const { Marked } = await import(pathToFileURL(path.join(markedDir, 'lib/marked.esm.js')).href);

const root = path.resolve(import.meta.dirname, '..');
const site = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
const docs = process.env.GUIDE_DOCS || path.join(root, 'docs');
const md = fs.readFileSync(path.join(docs, 'user-guide.md'), 'utf8');
const between = (s, a, b) => { const i = s.indexOf(a), j = s.indexOf(b, i); if (i < 0 || j < 0) throw new Error(`site/index.html: no ${a}…${b}`); return s.slice(i, j + b.length); };

// Pieces of the home page, with links made to work one folder down (/guide/, /privacy/)
const oneDown = (html, here) => html
  .replace(/href="#"/g, 'href="../"')
  .replace(/href="#([^"]+)"/g, 'href="../#$1"')
  .replace(/src="images\//g, 'src="../images/')
  .replace(/href="https:\/\/github\.com\/cutout-design\/cutout\/blob\/main\/docs\/user-guide\.md"/g, 'href="guide/"')
  .replace(/href="(guide|privacy)\/"/g, (m, p) => (p === here ? 'href="./" aria-current="page"' : `href="../${p}/"`));
const style = between(site, '<style>', '</style>');
const header = oneDown(between(site, '<header class="nav">', '</header>'), 'guide');
const footer = oneDown(between(site, '<footer>', '</footer>'), 'guide');
const theme = between(site, '  // Light / dark switch', '  })();');
// Text styles shared by the guide and the privacy page
const docStyle = `  .doc { max-width: 72ch; }
  .doc h1 { font-size: clamp(32px, 4vw, 44px); line-height: 1.1; letter-spacing: -.02em; margin: 0 0 20px; }
  .doc h2 { font-size: 26px; letter-spacing: -.01em; margin: 56px 0 14px; scroll-margin-top: 88px; }
  .doc h3 { font-size: 19px; margin: 32px 0 10px; scroll-margin-top: 88px; }
  .doc p, .doc li { color: var(--text); }
  .doc a { text-decoration: underline; text-decoration-thickness: 1px; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
  .doc a:hover { text-decoration-color: currentColor; }
  .doc ul, .doc ol { padding-left: 22px; }
  .doc li { margin: 4px 0; }`;
const preTheme = between(site, '<script>try {', '</script>');

// Headings get the same ids as on GitHub, so the guide's own links (#keyboard-shortcuts) work
const used = new Map();
const slug = text => {
  const base = text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
  const n = used.get(base) || 0; used.set(base, n + 1);
  return n ? `${base}-${n}` : base;
};
// Images: copy the ones the guide uses next to the page; use the dark versions where there are some
const darkOf = { 'window-light.png': 'window-dark.png' };
const darkVideo = { 'cut-out-background': 'cut-out-background-dark' };
// Images come from this checkout's docs (main) first, so a re-recorded picture shows without waiting for a
// release, then the release's docs, then the site images. The text is the release's, but an image's alt text
// comes from main's guide when main uses the same file, so the description matches the picture shown.
const imgSrc = name => [path.join(root, 'docs/images', name), path.join(docs, 'images', name), path.join(root, 'site/images', name)].find(f => fs.existsSync(f)) || path.join(root, 'site/images', name);
const mainAlt = new Map();
for (const m of fs.readFileSync(path.join(root, 'docs/user-guide.md'), 'utf8').matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) mainAlt.set(path.basename(m[2]), m[1]);
const copyImg = name => fs.copyFileSync(imgSrc(name), path.join(out, 'guide/images', name));
let animId = 0;
fs.mkdirSync(path.join(out, 'guide/images'), { recursive: true });
const toc = [];
const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens), id = slug(text);
      if (depth === 2 && id !== 'contents') toc.push({ id, text });
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
    image({ href, text }) {
      const name = path.basename(href);
      if (mainAlt.has(name)) text = mainAlt.get(name);
      // An animation (GIF on GitHub, or WebP in older releases) with a video version (name.mp4) becomes
      // the site's pausable video, as on the home page
      const vid = name.replace(/.(gif|webp)$/, ''), darkVid = darkVideo[vid];
      if (/.(gif|webp)$/.test(name) && fs.existsSync(imgSrc(vid + '.mp4'))) {
        for (const b of [vid, darkVid].filter(Boolean)) for (const f of ['.mp4', '-start.webp', '-end.webp']) copyImg(b + f);
        const id = 'anim' + ++animId, alt = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return `<div class="doc-anim"><div class="anim" role="button" tabindex="0" aria-label="Pause animation" aria-describedby="${id}">` +
          `<video src="images/${vid}.mp4" poster="images/${vid}-start.webp" data-light="images/${vid}" data-dark="images/${darkVid || vid}" width="1280" height="800" muted loop playsinline preload="metadata"></video>` +
          `<span class="anim-ic" aria-hidden="true"></span><span class="sr-only" id="${id}">${alt}</span></div></div>`;
      }
      fs.copyFileSync(imgSrc(name), path.join(out, 'guide/images', name));
      const dark = darkOf[name];
      if (dark) fs.copyFileSync(imgSrc(dark), path.join(out, 'guide/images', dark));
      const alt = text.replace(/"/g, '&quot;');
      return dark ? `<img src="images/${name}" data-light="images/${name}" data-dark="images/${dark}" alt="${alt}" loading="lazy">`
        : `<img src="images/${name}" alt="${alt}" loading="lazy">`;
    },
  },
});
let body = marked.parse(md);
// The guide's own Contents list is kept for phones; wide screens get the sidebar instead
body = body.replace(/<h2 id="contents">Contents<\/h2>\s*<ol>/, '<h2 id="contents" class="inline-toc">Contents</h2>\n<ol class="inline-toc">');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cutout user guide</title>
<meta name="description" content="Every tool, command and shortcut in Cutout, the small image editor for quick bitmap fixes.">
<link rel="icon" type="image/png" sizes="32x32" href="../images/icon-32.png">
<link rel="canonical" href="https://cutout.design/guide/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Cutout">
<meta property="og:url" content="https://cutout.design/guide/">
<meta property="og:title" content="Cutout user guide">
<meta property="og:description" content="Every tool, command and shortcut in Cutout, the small image editor for quick bitmap fixes.">
<meta property="og:image" content="https://cutout.design/images/share.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
${preTheme}
${style.replace('</style>', `
  /* User guide page (scripts/build-guide.mjs) */
  .guide { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 56px; padding-top: 48px; padding-bottom: 96px; align-items: start; }
  .guide nav.toc { position: sticky; top: 88px; max-height: calc(100vh - 112px); overflow-y: auto; font-size: 14px; }
  .guide nav.toc p { margin: 0 0 10px; font-weight: 600; color: var(--text); }
  .guide nav.toc ol { list-style: none; margin: 0; padding: 0; }
  .guide nav.toc a { display: block; padding: 4px 0; color: var(--muted); }
  .guide nav.toc a:hover { color: var(--text); text-decoration: none; }
  .guide nav.toc a.here { color: var(--link); }
${docStyle}
  .doc img, .doc .doc-anim { border-radius: 12px; border: 1px solid var(--line); box-shadow: var(--shadow); margin: 8px 0; }
  .doc .doc-anim { overflow: hidden; }
  .doc code { font: 13.5px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace; background: var(--bg-soft); border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; }
  .doc table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 15px; }
  .doc th, .doc td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .doc th { font-weight: 600; background: var(--bg-soft); }
  .doc td:first-child { white-space: nowrap; }
  .doc th:first-child { width: 34%; } /* the same column widths in every shortcut table */
  @media (min-width: 901px) { .doc .inline-toc { display: none; } }
  @media (max-width: 900px) { .guide { grid-template-columns: 1fr; gap: 0; padding-top: 32px; } .guide nav.toc { display: none; } .doc td:first-child { white-space: normal; } }
</style>`)}
</head>
<body>
${header}
<main class="wrap guide">
  <nav class="toc" aria-label="Contents">
    <p>Contents</p>
    <ol>
${toc.map(t => `      <li><a href="#${t.id}">${t.text}</a></li>`).join('\n')}
    </ol>
  </nav>
  <article class="doc">
${body}
  </article>
</main>
${footer}
<script>
${theme}

  // Contents: mark the section being read
  (() => {
    const links = [...document.querySelectorAll('nav.toc a')], heads = links.map(a => document.getElementById(a.hash.slice(1)));
    const mark = () => { let i = 0; heads.forEach((h, k) => { if (h && h.getBoundingClientRect().top < 120) i = k; }); links.forEach((a, k) => a.classList.toggle('here', k === i)); };
    addEventListener('scroll', mark, { passive: true }); mark();
  })();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(out, 'guide/index.html'), page);
console.log(`guide: ${toc.length} sections, ${used.size} headings -> ${path.join(out, 'guide/index.html')}`);

// The privacy page (/privacy/): one column, no contents list
{
  const md = fs.readFileSync(path.join(root, 'docs/privacy.md'), 'utf8');
  const ids = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const base = text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
        const n = ids.get(base) || 0; ids.set(base, n + 1);
        return `<h${depth} id="${n ? `${base}-${n}` : base}">${text}</h${depth}>\n`;
      },
    },
  });
  const desc = 'Cutout collects nothing about you: no account, no analytics, no tracking, and no uploads.';
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cutout Privacy Policy</title>
<meta name="description" content="${desc}">
<link rel="icon" type="image/png" sizes="32x32" href="../images/icon-32.png">
<link rel="canonical" href="https://cutout.design/privacy/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Cutout">
<meta property="og:url" content="https://cutout.design/privacy/">
<meta property="og:title" content="Cutout Privacy Policy">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="https://cutout.design/images/share.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
${preTheme}
${style.replace('</style>', `
  /* Privacy page (scripts/build-guide.mjs) */
  .policy { padding-top: 48px; padding-bottom: 96px; }
${docStyle}
  .doc h1 + p { color: var(--muted); margin-top: -8px; }
  @media (max-width: 900px) { .policy { padding-top: 32px; } }
</style>`)}
</head>
<body>
${oneDown(between(site, '<header class="nav">', '</header>'), 'privacy')}
<main class="wrap policy">
  <article class="doc">
${marked.parse(md)}
  </article>
</main>
${oneDown(between(site, '<footer>', '</footer>'), 'privacy')}
<script>
${theme}
</script>
</body>
</html>
`;
  fs.mkdirSync(path.join(out, 'privacy'), { recursive: true });
  fs.writeFileSync(path.join(out, 'privacy/index.html'), page);
  console.log(`privacy: ${ids.size} headings -> ${path.join(out, 'privacy/index.html')}`);
}
