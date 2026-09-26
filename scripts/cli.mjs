#!/usr/bin/env node
/**
 *   handpress install <site-directory>          copy editor.js and admin.html into the site
 *   handpress keys "<glob>" [--global "header, footer"]   add the keys the editor edits by
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

const usage = () => {
  console.error(`handpress install <site-directory> [--php]
handpress keys "<glob>" [--global "header, footer"]`);
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
} else {
  usage();
}
