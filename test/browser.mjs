/**
 * Drives the example site in a real browser: edit text, edit a shared block, duplicate a
 * list item, edit the data file, save, and check what was committed.
 *
 *   npm i -D playwright-core          (and a local Chrome)
 *   SITE_ROOT=$PWD/example/site node test/mock-github.mjs &
 *   npx wrangler dev --config example/wrangler.jsonc --port 8790 &
 *   node test/browser.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs'; import assert from 'node:assert/strict';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { signSession } from '../src/lib.js';
const B = process.env.BASE || 'http://127.0.0.1:8790';
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'example', 'site') + '/';
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies([{ name: 'sess', value: await signSession('admin@example.com', 'testsecret'), url: B }, { name: 'ed', value: '1', url: B }]);
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
page.on('dialog', d => d.accept());
await page.goto(B + '/');
await page.waitForFunction(() => document.querySelector('.ed-status')?.textContent === 'Click any text to edit it', null, { timeout: 20000 });
console.log('editor booted from config; editable units:', await page.locator('[contenteditable]').count());

await page.locator('[data-e="t2"]').click();           // the h1
await page.keyboard.press('Meta+a'); await page.keyboard.type('Bread, very slowly');
await page.locator('[data-e="gt6"]').click();          // footer, shared across pages
await page.keyboard.press('End'); await page.keyboard.type(' · est. 2011');
await page.locator('[data-e="i12"]').hover();          // duplicate a product card
await page.locator('.ed-item button[title="Duplicate this item"]').click();
await page.getByRole('button', { name: 'Site data' }).click();
await page.locator('.ed-drawer summary', { hasText: /^Markets/ }).click();
await page.locator('.ed-drawer summary', { hasText: 'Saturday' }).click();
await page.locator('.ed-drawer label:has-text("Hours") input').first().fill('7am – 2pm');

const nav = page.waitForEvent('load', { timeout: 60000 });
await page.getByRole('button', { name: 'Save' }).click();
await nav;
console.log('saved and reloaded');

const idx = fs.readFileSync(SITE + 'index.html', 'utf8');
assert.match(idx, /Bread, very slowly/);
assert.equal(idx.match(/class="card"/g).length, 3, 'card duplicated');
assert.match(fs.readFileSync(SITE + 'about.html', 'utf8'), /est\. 2011/, 'footer written to the other page too');
assert.match(fs.readFileSync(SITE + 'data.js', 'utf8'), /7am – 2pm/);
console.log('commit:', fs.readFileSync(process.env.MOCK_LOG || '/tmp/mock-github.log', 'utf8').trim().slice(0, 150));
console.log('errors:', errors);
await browser.close();
