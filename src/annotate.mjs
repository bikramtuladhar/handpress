/**
 * Adds the keys the editor edits by. Run it once over your pages, and again whenever you
 * hand-edit HTML: existing keys are never renumbered.
 *
 *   node annotate.mjs "*.html" --global "header, footer"
 *
 *   data-e="t12"   a block of text, edited in place
 *   data-e="m12"   an image
 *   data-e="i12"   an item of a repeating list that is not itself text
 *   data-e-list    a container whose children can be duplicated, moved and deleted
 *
 * Keys inside --global blocks (the header and footer repeated on every page) start with "g"
 * and line up across pages, so editing one updates all of them.
 *
 * Output is written with the same HTML serializer browsers use, so later editor saves produce
 * clean diffs instead of reformatting the whole file.
 */
import fs from 'node:fs';
import { parse, serialize } from 'parse5';

const SKIP = new Set(['script', 'style', 'svg', 'template', 'noscript', 'select', 'textarea', 'iframe', 'input', 'math', 'video', 'audio']);
const INLINE = new Set(['a', 'abbr', 'b', 'br', 'cite', 'code', 'em', 'i', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'wbr', 'svg']);
const LISTABLE = new Set(['ul', 'ol', 'div', 'section', 'tbody', 'article', 'aside', 'dl', 'nav']);
const WRAPPER = new Set(['div', 'section', 'article']);

const kids = el => (el.childNodes || []).filter(n => n.tagName);
const attr = (el, name) => el.attrs?.find(a => a.name === name)?.value;
const setAttr = (el, name, value) => { if (attr(el, name) === undefined) el.attrs.push({ name, value }); };
const firstClass = el => (attr(el, 'class') || '').trim().split(/\s+/)[0];
const isText = n => n.nodeName === '#text' && n.value.trim();
const inlineOnly = el => kids(el).every(k => INLINE.has(k.tagName) && (k.tagName === 'svg' || inlineOnly(k)));
const hasText = el => (el.childNodes || []).some(n => isText(n) || (n.tagName && n.tagName !== 'svg' && hasText(n)));

/** Enough of a CSS selector to name shared blocks: "footer", "#menu", ".site-header", "header.top". */
function matches(el, selector) {
  const m = /^([a-z0-9]+)?(?:#([\w-]+))?(?:\.([\w-]+))?$/i.exec(selector.trim());
  if (!m) return false;
  const [, tag, id, cls] = m;
  if (tag && el.tagName !== tag.toLowerCase()) return false;
  if (id && attr(el, 'id') !== id) return false;
  if (cls && !(attr(el, 'class') || '').split(/\s+/).includes(cls)) return false;
  return !!(tag || id || cls);
}

function isUnit(el) {
  if (!inlineOnly(el) || !hasText(el)) return false;
  // Several inline children and no loose text (e.g. <h1><span>A</span> <span>B</span></h1>):
  // key each child instead, so they can be edited separately.
  return el.childNodes.some(isText) || kids(el).length < 2;
}

export function annotate(html, { globals = [] } = {}) {
  const doc = parse(html);
  const body = kids(kids(doc).find(n => n.tagName === 'html')).find(n => n.tagName === 'body');
  const all = [];
  (function collect(el) { all.push(el); if (!SKIP.has(el.tagName)) kids(el).forEach(collect); })(body);
  const max = { '': 0, g: 0 };
  all.forEach(el => {
    const m = /^(g?)[tmi](\d+)$/.exec(attr(el, 'data-e') || '');
    if (m) max[m[1]] = Math.max(max[m[1]], +m[2]);
  });
  const key = (el, kind, g) => setAttr(el, 'data-e', g + kind + ++max[g]);

  (function walk(el, g) {
    if (SKIP.has(el.tagName)) return;
    if (globals.some(sel => matches(el, sel))) g = 'g';
    if (el.tagName === 'img') return key(el, 'm', g);
    if (el !== body && isUnit(el)) return key(el, 't', g);
    const ch = kids(el);
    const list = LISTABLE.has(el.tagName) && ch.length >= 2 &&
      ch.every(k => k.tagName === ch[0].tagName && !SKIP.has(k.tagName) &&
        (!WRAPPER.has(k.tagName) || firstClass(k) === firstClass(ch[0]))); // layout wrappers must also share a class
    ch.forEach(k => walk(k, g));
    if (list) {
      setAttr(el, 'data-e-list', '');
      ch.forEach(k => key(k, 'i', g)); // no-op for children already keyed as text or image
    }
  })(body, '');
  return serialize(doc);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const gi = args.indexOf('--global');
  const globals = gi < 0 ? [] : (args[gi + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
  const patterns = gi < 0 ? args : args.slice(0, gi);
  const files = patterns.flatMap(a => (a.includes('*') ? fs.globSync(a) : [a]));
  if (!files.length) {
    console.error('usage: node annotate.mjs "*.html" [--global "header.site-header, footer"]');
    process.exit(1);
  }
  for (const f of files) {
    const out = annotate(fs.readFileSync(f, 'utf8'), { globals });
    if (annotate(out, { globals }) !== out) throw new Error(`${f}: annotate is not idempotent — please report this`);
    fs.writeFileSync(f, out);
    console.log(f, (out.match(/data-e="/g) || []).length, 'keys,', (out.match(/data-e-list/g) || []).length, 'lists');
  }
}
