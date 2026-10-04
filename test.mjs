// npm test — sessions, the file allowlist, and the keying script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { signSession, readSession, isAdmin, isEditable, isUpload, checkFile, repoPath } from './src/lib.js';
import { annotate } from './src/annotate.mjs';

const cfg = {
  pages: ['index.html', 'about.html'],
  dataFiles: { 'data.js': 'Site data' },
  uploadDir: 'uploads'
};

// sessions
const tok = await signSession('a@b.com', 's3cret');
assert.equal(await readSession(tok, 's3cret'), 'a@b.com');
assert.equal(await readSession(tok, 'other'), null, 'wrong secret');
assert.equal(await readSession(tok.slice(0, -2) + 'xx', 's3cret'), null, 'tampered signature');
assert.equal(await readSession(await signSession('a@b.com', 's3cret', -1), 's3cret'), null, 'expired');
assert.equal(await readSession('junk', 's3cret'), null);

// admin list
assert.ok(isAdmin('A@B.com', 'x@y.com, a@b.com'));
assert.ok(!isAdmin('a@b.co', 'a@b.com'));
assert.ok(!isAdmin('', ''));

// what may be read and written
assert.ok(isEditable('index.html', cfg) && isEditable('data.js', cfg));
for (const p of ['secrets.js', '../index.html', 'worker.js', 'nested/index.html']) {
  assert.ok(!isEditable(p, cfg), p);
}
assert.ok(isUpload('uploads/photo-ab12.jpg', cfg));
assert.ok(!isUpload('uploads/shell.php', cfg) && !isUpload('uploads/../x.jpg', cfg));
assert.ok(isUpload('uploads/clip-ab12.mp3', cfg) && !isUpload('uploads/clip.mp3.php', cfg));

// newPages: top-level name.html pages become editable, nothing else
const np = { ...cfg, newPages: true };
assert.ok(isEditable('workshops.html', np) && !isEditable('workshops.html', cfg));
for (const p of ['admin.html', 'a/b.html', '../x.html', 'X.html', 'x.htm', '.html']) assert.ok(!isEditable(p, np), p);

// file checks
assert.equal(checkFile({ path: 'index.html', content: '<!doctype html><html></html>' }, cfg), '');
assert.match(checkFile({ path: 'index.html', content: '<p>hi</p>' }, cfg), /not a full HTML page/);
assert.match(checkFile({ path: 'index.html', content: '<!doctype html><html>' }, cfg), /cut off/);
assert.match(checkFile({ path: 'data.js', content: 'window.DATA = {oops};' }, cfg), /not valid JSON/);
assert.equal(checkFile({ path: 'data.js', content: 'window.DATA = {"a":1};\n' }, cfg), '');
assert.match(checkFile({ path: 'uploads/x.jpg' }, cfg), /no file data/);

// keying: idempotent, and it finds text, images and lists
const page = `<!doctype html><html><head><title>t</title></head><body>
<header><nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav></header>
<main><h1>Hello</h1><p>Some <em>text</em>.</p><img src="a.jpg" alt="a"></main>
<footer><p>© 2026</p></footer></body></html>`;
const once = annotate(page, { globals: ['header', 'footer'] });
assert.equal(annotate(once, { globals: ['header', 'footer'] }), once, 'annotate must be idempotent');
assert.match(once, /<h1 data-e="t\d+">Hello<\/h1>/);
assert.match(once, /<img src="a.jpg" alt="a" data-e="m\d+">/);
assert.match(once, /data-e-list/, 'the nav list is editable as a list');
assert.match(once, /<li data-e="gt\d+">/, 'header keys are global');
assert.match(once, /<p data-e="gt\d+">© 2026<\/p>/, 'footer keys are global');
assert.ok(!/<body[^>]*data-e=/.test(once), 'body itself is never a unit');

// a canvas is keyed and a list even while empty
const blank = annotate('<!doctype html><html><head></head><body><main data-e-canvas=""></main></body></html>');
assert.match(blank, /<main data-e-canvas="" data-e-list="" data-e="i\d+"><\/main>/);
assert.equal(annotate(blank), blank, 'canvas keying is idempotent');
assert.match(annotate('<!doctype html><html><head></head><body><main></main></body></html>'),
  /<main data-e-canvas="" data-e-list="" data-e="i\d+"><\/main>/, 'an empty <main> becomes a canvas');

// SITE_DIR: site paths become repo paths
for (const d of [undefined, '', '/']) assert.equal(repoPath(d, 'index.html'), 'index.html');
for (const d of ['public', 'public/', './public', '/public/']) assert.equal(repoPath(d, 'uploads/a.jpg'), 'public/uploads/a.jpg');

// handpress blank --kit: every starter kit makes a keyed page that `keys` leaves alone
const tmp = fs.mkdtempSync('/tmp/hp-');
for (const kit of ['landing', 'studio', 'bakery']) {
  execFileSync('node', ['scripts/cli.mjs', 'blank', `${tmp}/${kit}.html`, '--kit', kit]);
  const html = fs.readFileSync(`${tmp}/${kit}.html`, 'utf8'), keys = html.match(/data-e="[^"]+"/g);
  assert.ok(keys.length > 10 && new Set(keys).size === keys.length, `${kit}: keyed, no duplicates`);
  assert.equal(annotate(html), html, `${kit}: stable under keys`);
  assert.match(html, /\(\?:\^\|;\\s\*\)ed=1/, `${kit}: the editor loader regex kept its \\s`);
}
fs.rmSync(tmp, { recursive: true });

// the example site ships keyed
for (const f of fs.globSync('example/site/*.html').filter(f => !f.endsWith('admin.html'))) {
  const html = fs.readFileSync(f, 'utf8');
  assert.equal(annotate(html, { globals: ['header', 'footer'] }), html, `${f}: run npm run keys`);
}
console.log('ok');
