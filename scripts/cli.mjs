#!/usr/bin/env node
/**
 *   handpress install <site-directory>          copy editor.js and admin.html into the site
 *   handpress keys "<glob>" [--global "header, footer"]   add the keys the editor edits by
 *   handpress blank <page.html> [--title "My site"] [--kit landing]   a new page to build with the editor's AI
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

// The starter kits live in editor.js (the editor offers them on an empty canvas); one copy, read from there.
const kits = () => JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'editor.js'), 'utf8').split('/*starters*/')[1].split('/*end*/')[0]);

const usage = () => {
  console.error(`handpress install <site-directory> [--php]
handpress keys "<glob>" [--global "header, footer"]
handpress blank <page.html> [--title "My site"] [--kit ${kits().map(k => k.id).join('|')}]`);
  process.exit(1);
};

if (command === 'install') {
  const dest = rest.find(a => !a.startsWith('--'));
  if (!dest) usage();
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['editor.js', 'admin.html']) {
    fs.copyFileSync(path.join(here, '..', 'src', f), path.join(dest, f));
    console.log('wrote', path.join(dest, f));
  }
  if (rest.includes('--php')) {                       // shared hosting: the server half goes in too
    const php = path.join(here, '..', 'php');
    fs.copyFileSync(path.join(php, 'api.php'), path.join(dest, 'api.php'));
    fs.copyFileSync(path.join(php, 'htaccess.txt'), path.join(dest, 'htaccess.txt'));
    fs.copyFileSync(path.join(php, 'uploads-htaccess.txt'), path.join(dest, 'uploads-htaccess.txt'));
    fs.copyFileSync(path.join(php, 'config.sample.php'), path.join(dest, '..', 'handpress-config.sample.php'));
    console.log('wrote', path.join(dest, 'api.php'), '+ htaccess templates');
    console.log('wrote', path.join(dest, '..', 'handpress-config.sample.php'), '(fill in, rename to handpress-config.php)');
  }
  console.log('\nNext: key your pages, and load editor.js only when the "ed" cookie is set.');
} else if (command === 'keys') {
  const { annotate } = await import(path.join(here, '..', 'src', 'annotate.mjs'));
  const gi = rest.indexOf('--global');
  const globals = gi < 0 ? [] : (rest[gi + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
  const patterns = gi < 0 ? rest : rest.slice(0, gi);
  const files = patterns
    .flatMap(a => (a.includes('*') ? fs.globSync(a) : [a]))
    // The sign-in page is not content, and a glob usually sweeps it up.
    .filter(f => path.basename(f) !== 'admin.html');
  if (!files.length) usage();
  for (const f of files) {
    const out = annotate(fs.readFileSync(f, 'utf8'), { globals });
    fs.writeFileSync(f, out);
    console.log(f, (out.match(/data-e="/g) || []).length, 'keys,', (out.match(/data-e-list/g) || []).length, 'lists');
  }
} else if (command === 'blank') {
  // A site from nothing: a page with a few design tokens and an empty canvas. Sign in, click the
  // canvas, and the AI builds it section by section. It loads the editor itself, for editors only.
  const dest = rest.find(a => !a.startsWith('--'));
  if (!dest || !dest.endsWith('.html')) usage();
  if (fs.existsSync(dest)) { console.error(dest, 'already exists'); process.exit(1); }
  const ti = rest.indexOf('--title');
  const title = (ti < 0 ? 'New site' : rest[ti + 1] || 'New site').replace(/[<&]/g, '');
  const ki = rest.indexOf('--kit');
  const kit = ki < 0 ? null : kits().find(k => k.id === rest[ki + 1]);
  if (ki >= 0 && !kit) usage();
  let n = 1;                                          // the canvas is i1; the kit's t0/i0 keys follow it
  const body = kit ? kit.html.replace(/data-e='([tmi])0'/g, (_, k) => `data-e='${k}${++n}'`) : '';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const { annotate } = await import(path.join(here, '..', 'src', 'annotate.mjs'));   // the same output `keys` writes
  fs.writeFileSync(dest, annotate(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { --ink: #1c1b19; --muted: #6b675f; --paper: #fbfaf7; --accent: #2f5fd0; --radius: 14px; --max: 1080px; }
* { box-sizing: border-box; }
body { margin: 0; font: 17px/1.6 system-ui, sans-serif; color: var(--ink); background: var(--paper); }
main > * { padding: 72px max(20px, calc((100% - var(--max)) / 2)); }
h1, h2, h3 { line-height: 1.15; margin: 0 0 .5em; }
h1 { font-size: clamp(2.2rem, 6vw, 4rem); }
h2 { font-size: clamp(1.6rem, 4vw, 2.4rem); }
img { max-width: 100%; height: auto; border-radius: var(--radius); }
a { color: var(--accent); }
</style>
</head><body><main data-e="i1" data-e-list="" data-e-canvas="">${body}</main>
<script>if (/(?:^|;\\s*)ed=1/.test(document.cookie)) { var s = document.createElement('script'); s.src = '/editor.js'; s.defer = true; document.head.appendChild(s); }</script>
</body></html>
`));
  console.log('wrote', dest, '\nNext: list it under pages (or set newPages: true), sign in, and click the empty canvas.');
} else {
  usage();
}
