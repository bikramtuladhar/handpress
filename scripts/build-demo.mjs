#!/usr/bin/env node
/**
 * Builds demo/ from the example site: same pages, but the API is answered in the browser
 * by demo/sandbox.js (see the note at the top of that file). Run: npm run demo:build
 */
import fs from 'node:fs';
import path from 'node:path';

const DEMO_CSS_TEXT = `<style>
  #demo-banner { position: fixed; inset: 0 0 auto 0; z-index: 2147482000; display: flex; flex-wrap: wrap;
    gap: 10px 16px; align-items: center; justify-content: space-between; padding: 10px 16px;
    background: #23201b; color: #f6efe3; font: 14px/1.4 system-ui, sans-serif; }
  #demo-banner a, #demo-banner button { color: inherit; font: inherit; text-decoration: underline; }
  #demo-banner button { background: none; border: 0; cursor: pointer; padding: 0; }
  .demo-actions { display: flex; gap: 16px; }
  body { padding-top: 52px; }
</style>
`;

const root = path.join(import.meta.dirname, '..');
const from = path.join(root, 'example', 'site');
const to = path.join(root, 'demo');
fs.mkdirSync(to, { recursive: true });

for (const f of ['index.html', 'about.html', 'style.css', 'data.js', 'loaf.svg']) {
  fs.copyFileSync(path.join(from, f), path.join(to, f));
}
fs.copyFileSync(path.join(root, 'src', 'editor.js'), path.join(to, 'editor.js'));

// The site's own script, minus the editor loader: in the demo the sandbox loads the editor,
// after it has put the visitor's saved version back on screen.
let site = fs.readFileSync(path.join(from, 'site.js'), 'utf8');
site = site.replace(/\n\s*\/\/ The editor is loaded only[\s\S]*?\n  }\n/, '\n');
fs.writeFileSync(path.join(to, 'site.js'), site);

for (const f of ['index.html', 'about.html']) {
  const p = path.join(to, f);
  let html = fs.readFileSync(p, 'utf8')
    .replace('<script src="data.js" defer=""></script>', '<script src="data.js" defer=""></script>\n<script src="sandbox.js"></script>')
    .replace('</head>', DEMO_CSS_TEXT + '</head>');
  fs.writeFileSync(p, html);
}
console.log('demo built from example/site');

