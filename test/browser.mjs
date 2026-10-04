/**
 * Drives the example site in a real browser: edit text, edit a shared block, duplicate a
 * list item, undo / redo, reload (the draft survives), edit the data file, save, and check
 * what was committed. Then the AI assistant with OpenRouter and opencode Zen mocked: settings,
 * generate, sanitize, undo, in-place rewrite of an existing block (and its structure guard), and
 * switching providers.
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
const ready = () => page.waitForFunction(() => /Click any text|unsaved edit/.test(document.querySelector('.ed-status')?.textContent || ''), null, { timeout: 20000 });
const saveLabel = () => page.locator('.ed-bar button', { hasText: /^Save/ }).textContent();
await ready();
console.log('editor booted from config; editable units:', await page.locator('[contenteditable]').count());

// The guide opens by itself on the first visit to a page, with this site's tips (EDITOR_HOOKS.guide).
assert.equal(await page.locator('.ed-drawer .ed-guide').first().locator('li').count(), 3, 'guide tips for index.html');
await page.locator('.ed-drawer button', { hasText: 'Show me' }).last().click();
assert.equal(await page.locator('.ed-flash').count(), 1, 'Show me highlights the part');
await page.locator('.ed-drawer button', { hasText: 'Close' }).click();

// A list drawn from data.js (EDITOR_HOOKS.dataRegions): handles on each entry, redrawn as it changes.
const markets = () => page.locator('[data-markets] > li').count();
assert.equal(await page.locator('[data-markets] .ed-ov-tools').count(), await markets(), 'a handle bar per market');
await page.locator('.ed-ov-bar button', { hasText: '+ Add' }).click();
await page.locator('.ed-drawer details[open] label:has-text("Day") input').last().fill('Wednesday');
await page.waitForFunction(() => /Wednesday/.test(document.querySelector('[data-markets]').textContent));
await page.locator('.ed-drawer button', { hasText: 'Close' }).click();
await page.locator('[data-markets]').evaluate(el => el.scrollIntoView({ block: 'center' }));
await page.locator('[data-markets] > li').first().locator('button[title="Remove"]').click();
assert.equal(await markets(), 2, 'one removed');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
assert.equal(await markets(), 3, 'undo put the market back, and the new one is still there');
console.log('data list handles, live redraw, undo ok');

// Sections: <main> is a list, so a whole section can be copied.
const sections = () => page.locator('main > section').count();
const n0 = await sections();
await page.locator('main > section').nth(1).hover({ position: { x: 3, y: 3 } });
await page.locator('.ed-item button', { hasText: '+' }).first().click();
await page.locator('dialog .ed-choice', { hasText: 'Copy of this' }).click();
assert.equal(await sections(), n0 + 1, 'section copied');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
assert.equal(await sections(), n0, 'and undone');

await page.locator('[data-e="t2"]').click();           // the h1
await page.keyboard.press('Meta+a'); await page.keyboard.type('Bread, very slowly');
await page.locator('[data-e="gt6"]').click();          // footer, shared across pages
await page.keyboard.press('End'); await page.keyboard.type(' · est. 2011');
await page.locator('[data-e="i12"]').hover();          // duplicate a product card
await page.locator('.ed-item button[title="Duplicate this"]').click();
await page.locator('[data-e="i12"]').hover();          // remove the original card, then Undo, then Redo
await page.locator('.ed-item button[title^="Remove"]').click();
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
assert.equal(await page.locator('[data-e="i12"]').count(), 1, 'undo brought the card back');
await page.getByRole('button', { name: 'Redo' }).click(); await page.waitForLoadState('load'); await ready();
assert.equal(await page.locator('[data-e="i12"]').count(), 0, 'redo removed it again');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
assert.match(await page.locator('[data-e="t2"]').textContent(), /Bread, very slowly/, 'draft survived the reloads');
console.log('undo / redo / reload ok:', await saveLabel());
await page.getByRole('button', { name: 'Site data' }).click();
await page.locator('.ed-drawer summary', { hasText: /^Markets/ }).click();
await page.locator('.ed-drawer summary', { hasText: 'Saturday' }).click();
await page.locator('.ed-drawer label:has-text("Hours") input').first().fill('7am – 2pm');

const nav = page.waitForEvent('load', { timeout: 60000 });
await page.locator('.ed-bar button', { hasText: /^Save/ }).click();
await nav;
console.log('saved and reloaded');

const idx = fs.readFileSync(SITE + 'index.html', 'utf8');
assert.match(fs.readFileSync(SITE + 'data.js', 'utf8'), /Wednesday/, 'new market saved');
assert.match(idx, /Bread, very slowly/);
assert.equal(idx.match(/class="card"/g).length, 3, 'card duplicated');
assert.match(fs.readFileSync(SITE + 'about.html', 'utf8'), /est\. 2011/, 'footer written to the other page too');
assert.match(fs.readFileSync(SITE + 'data.js', 'utf8'), /7am – 2pm/);
console.log('commit:', fs.readFileSync(process.env.MOCK_LOG || '/tmp/mock-github.log', 'utf8').trim().slice(0, 150));
// --- AI assistant: OpenRouter and opencode Zen mocked — settings, generate, sanitize, undo,
// --- in-place rewrite of an existing block (and the structure guard), provider switching ---
await page.route('https://openrouter.ai/api/v1/models', route => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({ data: [
    { id: 'test/model-free', name: 'Test Free', pricing: { prompt: '0', completion: '0' } },
    { id: 'paid/model', name: 'Paid', pricing: { prompt: '0.001', completion: '0.002' } }
  ] })
}));
await page.route('https://opencode.ai/zen/v1/models', route => route.fulfill({
  contentType: 'application/json',
  body: JSON.stringify({ object: 'list', data: [
    { id: 'claude-fable-5' },          // Zen serves Claude on /messages
    { id: 'gemini-3-flash' },          // ...and Gemini on a Google-shaped route
    { id: 'glm-5.3' },
    { id: 'nemotron-3-ultra-free' }
  ] })
}));
const CARD_HTML = '<img src="loaf.svg" width="320" height="200" alt="AI loaf." data-e="m6">' +
  '<h3 data-e="t7">AI country sourdough</h3><p data-e="t8">Rewritten by the test.</p>';
let aiSections = 0, zenURL = '';
const answer = content => ({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }) });
await page.route('https://openrouter.ai/api/v1/chat/completions', route => {
  const body = JSON.parse(route.request().postData() || '{}');
  const user = (body.messages && body.messages[1] && body.messages[1].content) || '';
  if (body.response_format) {
    return route.fulfill(answer(JSON.stringify({ html: aiSections++ === 0
      ? '<p class="lede" data-e="t0">Fresh AI bread, warm from the oven.<script>alert(1)</script></p>'
      : '<p class="lede">Second AI block, no keys given.<script>alert(1)</script></p>' })));
  }
  if (/INSIDE the HTML element/.test(user)) {
    if (/DROPKEYS/.test(user)) return route.fulfill(answer('<p>no keys here</p>'));   // would restructure
    if (/data-e="m6"/.test(user)) return route.fulfill(answer(CARD_HTML));
  }
  route.fulfill(answer('Bread, slowly — rewritten by the test.'));
});
await page.route('https://opencode.ai/zen/v1/chat/completions', route => {
  zenURL = route.request().url();
  route.fulfill(answer(JSON.stringify({ html: '<p class="lede" data-e="t0">Zen bread.</p>' })));
});
const aiBlockKey = text => page.evaluate(t => {
  const n = Array.from(document.querySelectorAll('[data-e]')).find(e => e.textContent.includes(t));
  return n ? n.getAttribute('data-e') : null;
}, text);

await ready();
await page.locator('.ed-bar button', { hasText: /^AI$/ }).click();
await page.locator('.ed-drawer input[type=password]').fill('sk-or-test');
await page.waitForFunction(() => Array.from(document.querySelectorAll('.ed-drawer select[data-ai=model] option')).some(o => o.value === 'test/model-free'));
await page.locator('.ed-drawer select[data-ai=model]').selectOption('test/model-free');
assert.equal(await page.locator('.ed-drawer select[data-ai=model] option', { hasText: 'paid/model' }).count(), 0, 'paid models filtered out');
assert.equal(await page.evaluate(() => JSON.parse(localStorage['ed-ai']).keys.openrouter), 'sk-or-test', 'key saved to localStorage');
await page.locator('.ed-drawer textarea').fill('a short line about fresh bread');
await page.locator('.ed-ai-run button', { hasText: 'Generate' }).click();
await page.locator('.ed-drawer .ed-ai-render').waitFor({ state: 'visible' });
assert.match(await page.locator('.ed-drawer .ed-ai-render').textContent(), /Fresh AI bread/, 'AI section preview rendered');
assert.equal(await page.locator('.ed-drawer .ed-ai-render script').count(), 0, 'script stripped from AI output');
await page.locator('.ed-ai-run button', { hasText: 'Apply to page' }).click();
await page.waitForFunction(() => /Fresh AI bread/.test(document.body.textContent));
assert.match(await saveLabel(), /\(1\)/, 'AI insert is a draft edit');
assert.match(await aiBlockKey('Fresh AI bread'), /^[tmi]\d+$/, 'AI block got a fresh editable key');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
assert.doesNotMatch(await page.locator('body').textContent(), /Fresh AI bread/, 'undo removed the AI block');

// A model that forgets the data-e keys still yields an editable block (aiKeyFallback).
await page.locator('.ed-bar button', { hasText: /^AI$/ }).click();
await page.locator('.ed-drawer textarea').fill('another line');
await page.locator('.ed-ai-run button', { hasText: 'Generate' }).click();
await page.locator('.ed-drawer .ed-ai-render').waitFor({ state: 'visible' });
await page.locator('.ed-ai-run button', { hasText: 'Apply to page' }).click();
await page.waitForFunction(() => /Second AI block/.test(document.body.textContent));
assert.match(await aiBlockKey('Second AI block'), /^[tmi]\d+$/, 'keyless AI output still made editable');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
console.log('ai drawer generate + sanitize + fallback keys + undo ok');

// In place: a text unit, then a whole card — its structure, classes and keys must survive.
await page.locator('[data-e="t2"]').click();
await page.locator('.ed-item button[title^="Rewrite this block"]').click();
await page.locator('dialog .ed-choice', { hasText: 'Rewrite' }).first().click();
await page.locator('dialog .ed-ai-render').waitFor({ state: 'visible' });
await page.locator('dialog button', { hasText: /^Apply$/ }).click();
await page.locator('dialog').waitFor({ state: 'detached' });      // the preview markup leaves with it
assert.match(await page.locator('[data-e="t2"]').textContent(), /rewritten by the test/, 'text block rewritten in place');

await page.locator('[data-e="i12"]').hover();
await page.locator('.ed-item button[title^="Rewrite this block"]').click();
await page.locator('dialog .ed-choice', { hasText: 'Rewrite' }).first().click();
await page.locator('dialog .ed-ai-render').waitFor({ state: 'visible' });
await page.locator('dialog button', { hasText: /^Apply$/ }).click();
await page.locator('dialog').waitFor({ state: 'detached' });
assert.match(await page.locator('[data-e="i12"] h3').textContent(), /AI country sourdough/, 'card rewritten in place');
assert.equal(await page.locator('[data-e="i12"] img').count(), 1, 'card kept its image');
assert.equal(await page.locator('[data-e="m6"]').count(), 1, 'image key m6 preserved');
assert.equal(await page.locator('[data-e="t7"]').count(), 1, 'text key t7 preserved');

// A model that would restructure the block is refused (the aiSameKeys guard).
await page.locator('[data-e="i12"]').hover();
await page.locator('.ed-item button[title^="Rewrite this block"]').click();
await page.locator('dialog .ed-field input').fill('DROPKEYS');
await page.locator('dialog .ed-ai-run button', { hasText: 'Rewrite' }).click();
await page.waitForFunction(() => /changed the block.s structure/.test((document.querySelector('dialog') || {}).textContent || ''));
assert.match(await page.locator('[data-e="i12"] h3').textContent(), /AI country sourdough/, 'restructuring refused, block left alone');
await page.locator('dialog button', { hasText: /^Cancel$/ }).click();
console.log('ai in-place rewrite + structure guard ok');

// opencode Zen: a second provider with its own key and model, chat-completions models only.
await page.locator('.ed-bar button', { hasText: /^AI$/ }).click();
await page.locator('.ed-drawer select[data-ai=provider]').selectOption('opencode');
await page.locator('.ed-drawer input[type=password]').fill('zen-key');
await page.waitForFunction(() => Array.from(document.querySelectorAll('.ed-drawer select[data-ai=model] option')).some(o => o.value === 'glm-5.3'));
assert.equal(await page.locator('.ed-drawer select[data-ai=model] option', { hasText: 'claude-fable-5' }).count(), 0, 'Zen models on other endpoints left out');
assert.equal(await page.locator('.ed-drawer select[data-ai=model] option', { hasText: 'gemini-3-flash' }).count(), 0, 'Zen Google-route models left out');
assert.match(await page.locator('.ed-drawer select[data-ai=model]').inputValue(), /free$/, 'Zen defaults to a free model');
await page.locator('.ed-drawer textarea').fill('a zen line');
await page.locator('.ed-ai-run button', { hasText: 'Generate' }).click();
await page.locator('.ed-drawer .ed-ai-render').waitFor({ state: 'visible' });
await page.locator('.ed-ai-run button', { hasText: 'Apply to page' }).click();
await page.waitForFunction(() => /Zen bread/.test(document.body.textContent));
assert.match(zenURL, /opencode\.ai\/zen\/v1\/chat\/completions/, 'call went to opencode Zen');
assert.equal(await page.evaluate(() => { const s = JSON.parse(localStorage['ed-ai']); return s.provider + '|' + s.keys.openrouter + '|' + /free$/.test(s.models.opencode); }),
  'opencode|sk-or-test|true', 'each provider keeps its own settings');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
console.log('ai provider switch (opencode Zen) ok');

console.log('errors:', errors);
await browser.close();
