/**
 * Drives the example site in a real browser: edit text, edit a shared block, duplicate a
 * list item, undo / redo, reload (the draft survives), edit the data file, save, and check
 * what was committed. Then the AI panel with OpenRouter and opencode Zen mocked: settings and the
 * encrypted key, generate, hand-edited HTML, sanitize, undo, dragging the panel, picking a block on
 * the page, in-place rewrite (and its structure guard), redesign, build inside, switching
 * providers, and a new page built from a blank canvas.
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
let promptText = ''; page.on('dialog', d => d.accept(d.type() === 'prompt' ? promptText : undefined));
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
  if (/after the element/i.test(user) && body.response_format) {
    return route.fulfill(answer(JSON.stringify({ html: aiSections++ === 0
      ? '<p class="lede" data-e="t0">Fresh AI bread, warm from the oven.<script>alert(1)</script></p>'
      : '<p class="lede">Second AI block, no keys given.<script>alert(1)</script></p>' })));
  }
  if (/REDESIGN/.test(user)) return route.fulfill(answer(JSON.stringify({ html: '<blockquote class="lede"><p>A redesigned card.</p></blockquote>' })));
  if (/INSIDE: /.test(user)) return route.fulfill(answer(JSON.stringify({ html: '<p>Built inside.</p>' })));
  if (/INSIDE the HTML element/.test(user)) {
    if (/DROPKEYS/.test(user)) return route.fulfill(answer('<p>no keys here</p>'));   // would restructure
    if (/data-e="m6"/.test(user)) return route.fulfill(answer(CARD_HTML));
  }
  route.fulfill(answer('Bread, slowly — rewritten by the test.'));
});
await page.route('https://opencode.ai/zen/v1/chat/completions', route => {
  zenURL = route.request().url();
  const inside = /INSIDE: /.test(route.request().postData() || '');
  route.fulfill(answer(JSON.stringify({ html: inside ? '<section><h2>Built inside.</h2></section>' : '<p class="lede" data-e="t0">Zen bread.</p>' })));
});
const aiBlockKey = text => page.evaluate(t => {
  const n = Array.from(document.querySelectorAll('[data-e]')).find(e => e.textContent.includes(t));
  return n ? n.getAttribute('data-e') : null;
}, text);

await ready();
const P = '.ed-ai';                                   // the movable AI panel
const openAiBar = () => page.locator('.ed-bar button', { hasText: /^AI$/ }).click();
const generate = async () => { await page.locator(P + ' button', { hasText: 'Generate' }).click(); await page.locator(P + ' .ed-ai-render').waitFor({ state: 'visible' }); };
const apply = () => page.locator(P + ' button', { hasText: /^Apply$/ }).click();
await openAiBar();
await page.locator(P + ' input[type=password]').fill('sk-or-test');
await page.waitForFunction(() => Array.from(document.querySelectorAll('.ed-ai select[data-ai=model] option')).some(o => o.value === 'test/model-free'));
await page.locator(P + ' select[data-ai=model]').selectOption('test/model-free');
assert.equal(await page.locator(P + ' select[data-ai=model] option', { hasText: 'paid/model' }).count(), 0, 'paid models filtered out');
assert.equal(await page.locator(P + ' select[data-ai=mode]').inputValue(), 'edit', 'from the bar: works on the last block');
await page.locator(P + ' select[data-ai=mode]').selectOption('after');
await page.locator(P + ' textarea[data-ai=prompt]').fill('a short line about fresh bread');
await generate();
const stored = await page.evaluate(() => localStorage['ed-ai']);
assert.doesNotMatch(stored, /sk-or-test/, 'the API key is not stored in plain text');
assert.ok(JSON.parse(stored).sealed.openrouter, 'the API key is stored encrypted');
assert.match(await page.locator(P + ' .ed-ai-render').textContent(), /Fresh AI bread/, 'AI preview rendered');
assert.equal(await page.locator(P + ' .ed-ai-render script').count(), 0, 'script stripped from AI output');
assert.match(await page.locator(P + ' textarea[data-ai=html]').inputValue(), /Fresh AI bread/, 'the HTML is shown for hand edits');
await page.locator(P + ' textarea[data-ai=html]').fill('<p class="lede" data-e="t0">Fresh AI bread, edited by hand.</p>');
assert.match(await page.locator(P + ' .ed-ai-render').textContent(), /edited by hand/, 'preview follows the hand-edited HTML');
await apply();
await page.waitForFunction(() => /edited by hand/.test(document.querySelector('main').textContent));
assert.match(await saveLabel(), /\(1\)/, 'AI insert is a draft edit');
assert.match(await aiBlockKey('edited by hand'), /^[tmi]\d+$/, 'AI block got a fresh editable key');
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
assert.doesNotMatch(await page.locator('main').textContent(), /edited by hand/, 'undo removed the AI block');

// The key survives the reload (decrypted with this browser's vault); keyless output is still editable.
await openAiBar();
assert.equal(await page.locator(P + ' input[type=password]').inputValue(), 'sk-or-test', 'key decrypted after reload');
await page.locator(P + ' select[data-ai=mode]').selectOption('after');
await page.locator(P + ' textarea[data-ai=prompt]').fill('another line');
await generate();
await apply();
await page.waitForFunction(() => /Second AI block/.test(document.querySelector('main').textContent));
assert.match(await aiBlockKey('Second AI block'), /^[tmi]\d+$/, 'keyless AI output still made editable');
await page.locator(P + ' button', { hasText: 'Close' }).click();
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
console.log('ai panel generate + hand-edit HTML + sanitize + encrypted key + undo ok');

// The panel moves by its title bar.
await openAiBar();
const box0 = await page.locator(P).boundingBox();
await page.mouse.move(box0.x + 40, box0.y + 15); await page.mouse.down();
await page.mouse.move(box0.x - 260, box0.y + 60, { steps: 5 }); await page.mouse.up();
const box1 = await page.locator(P).boundingBox();
assert.ok(box1.x < box0.x - 200 && box1.y > box0.y + 40, 'panel dragged');
await page.locator(P + ' button', { hasText: 'Close' }).click();

// In place: a text unit, then a whole card — its structure, classes and keys must survive.
await page.locator('[data-e="t2"]').click();
await page.locator('.ed-item button[title^="Rewrite this block"]').click();
await page.locator(P + ' .ed-choice', { hasText: 'Rewrite' }).first().click();
await page.locator(P + ' .ed-ai-render').waitFor({ state: 'visible' });
await apply();
assert.match(await page.locator('[data-e="t2"]').textContent(), /rewritten by the test/, 'text block rewritten in place');

// Pick on page: choose the card by clicking it, then rewrite it in place.
await page.locator(P + ' button', { hasText: 'Pick on page' }).click();
await page.locator('[data-e="i12"] h3').click();
await page.locator(P + ' button', { hasText: '⤴ Bigger' }).click();
assert.match(await page.locator(P + ' .ed-ai-target').textContent(), /<article|<div|<li/, 'picked the card');
await page.locator(P + ' .ed-choice', { hasText: 'Rewrite' }).first().click();
await page.locator(P + ' .ed-ai-render').waitFor({ state: 'visible' });
await apply();
await page.waitForFunction(() => /AI country sourdough/.test(document.querySelector('[data-e="i12"]').textContent));
assert.equal(await page.locator('[data-e="i12"] img').count(), 1, 'card kept its image');
assert.equal(await page.locator('[data-e="m6"]').count(), 1, 'image key m6 preserved');
assert.equal(await page.locator('[data-e="t7"]').count(), 1, 'text key t7 preserved');

// A model that would restructure the block is refused in "Rewrite its words" (the aiSameKeys guard).
await page.locator(P + ' textarea[data-ai=prompt]').fill('DROPKEYS');
await page.locator(P + ' button', { hasText: 'Generate' }).click();
await page.waitForFunction(() => /changed the block.s structure/.test(document.querySelector('.ed-ai').textContent));
assert.match(await page.locator('[data-e="i12"] h3').textContent(), /AI country sourdough/, 'restructuring refused, block left alone');

// "Redesign it" may restructure: the card is replaced, and its new parts are editable.
await page.locator(P + ' select[data-ai=mode]').selectOption('replace');
await page.locator(P + ' textarea[data-ai=prompt]').fill('REDESIGN as a quote');
await generate();
await apply();
await page.waitForFunction(() => /A redesigned card/.test(document.querySelector('main').textContent));
assert.equal(await page.locator('[data-e="i12"]').count(), 0, 'old card replaced');
assert.match(await aiBlockKey('A redesigned card'), /^[tmi]\d+$/, 'redesign is editable');

// "Build inside it": the products list gets new content at its end.
await page.locator(P + ' button', { hasText: 'Pick on page' }).click();
await page.locator('main > section').nth(1).click({ position: { x: 3, y: 3 } });
await page.locator(P + ' select[data-ai=mode]').selectOption('in');
await page.locator(P + ' textarea[data-ai=prompt]').fill('INSIDE: a note');
await generate();
await apply();
await page.waitForFunction(() => /Built inside/.test(document.querySelector('main > section:nth-of-type(2)').textContent));
await page.locator(P + ' button', { hasText: 'Close' }).click();
for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready(); }
assert.equal(await page.locator('[data-e="i12"]').count(), 1, 'undo brought the original card back');
console.log('ai pick + in-place rewrite + structure guard + redesign + build inside ok');

// opencode Zen: a second provider with its own key and model, chat-completions models only.
await openAiBar();
await page.locator(P + ' summary', { hasText: 'Model & key' }).click();   // folded away once a key is set
await page.locator(P + ' select[data-ai=provider]').selectOption('opencode');
await page.locator(P + ' input[type=password]').fill('zen-key');
await page.waitForFunction(() => Array.from(document.querySelectorAll('.ed-ai select[data-ai=model] option')).some(o => o.value === 'glm-5.3'));
assert.equal(await page.locator(P + ' select[data-ai=model] option', { hasText: 'claude-fable-5' }).count(), 0, 'Zen models on other endpoints left out');
assert.equal(await page.locator(P + ' select[data-ai=model] option', { hasText: 'gemini-3-flash' }).count(), 0, 'Zen Google-route models left out');
assert.match(await page.locator(P + ' select[data-ai=model]').inputValue(), /free$/, 'Zen defaults to a free model');
await page.locator(P + ' select[data-ai=mode]').selectOption('after');
await page.locator(P + ' textarea[data-ai=prompt]').fill('a zen line');
await generate();
await apply();
await page.waitForFunction(() => /Zen bread/.test(document.body.textContent));
assert.match(zenURL, /opencode\.ai\/zen\/v1\/chat\/completions/, 'call went to opencode Zen');
assert.equal(await page.evaluate(() => { const s = JSON.parse(localStorage['ed-ai']); return s.provider + '|' + !!s.sealed.openrouter + '|' + !!s.sealed.opencode + '|' + /free$/.test(s.models.opencode); }),
  'opencode|true|true|true', 'each provider keeps its own settings');
await page.locator(P + ' button', { hasText: 'Close' }).click();
await page.getByRole('button', { name: 'Undo' }).click(); await page.waitForLoadState('load'); await ready();
console.log('ai provider switch (opencode Zen) ok');

// A new page from a blank canvas (EDITOR.newPages): created, opened, built with AI, saved.
fs.rmSync(SITE + 'canvas-test.html', { force: true });
promptText = 'Canvas test';
const opened = page.waitForURL(/\/canvas-test/, { timeout: 60000 });
await page.locator('.ed-bar button', { hasText: 'New page' }).click();
await opened; await ready();
assert.match(fs.readFileSync(SITE + 'canvas-test.html', 'utf8'), /<main data-e="i1" data-e-list="" data-e-canvas=""><\/main>/, 'blank canvas committed');
assert.equal(await page.locator('footer').count(), 1, 'shared footer came along');
await page.locator('[data-e-canvas]').click();
assert.equal(await page.locator(P + ' select[data-ai=mode]').inputValue(), 'in', 'clicking the empty canvas builds inside it');
await page.locator(P + ' textarea[data-ai=prompt]').fill('INSIDE: a hero');
await generate();
await apply();
await page.waitForFunction(() => /Built inside/.test(document.querySelector('[data-e-canvas]').textContent));
const saved = page.waitForEvent('load', { timeout: 60000 });
await page.locator('.ed-bar button', { hasText: /^Save/ }).click();
await saved;
assert.match(fs.readFileSync(SITE + 'canvas-test.html', 'utf8'), /Built inside/, 'canvas content saved');
fs.rmSync(SITE + 'canvas-test.html');
console.log('new page from blank canvas ok');

console.log('errors:', errors);
await browser.close();
