#!/usr/bin/env node
/**
 * Copies the two browser files into your site directory:
 *   node scripts/install.mjs ./public
 * Re-run it after updating this package. They are plain files, so you can commit them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dest = process.argv[2];
if (!dest) {
  console.error('usage: node scripts/install.mjs <site-directory>');
  process.exit(1);
}
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
fs.mkdirSync(dest, { recursive: true });
for (const f of ['editor.js', 'admin.html']) {
  fs.copyFileSync(path.join(src, f), path.join(dest, f));
  console.log('wrote', path.join(dest, f));
}
