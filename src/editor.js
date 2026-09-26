/* ==========================================================================
   Edit-in-place for static sites: the browser half.

   Load it only for signed-in editors (see README — one line in your own JS,
   guarded by the "ed" cookie). Visitors never download it.

   How it works: it fetches the page's SOURCE through /api/file and keeps it as
   a second, script-free DOM. Every change is an "op" (set text, set attribute,
   insert after, move, delete, …) applied to the live page (so the editor sees
   it) and to that source DOM (so what gets saved is clean HTML, not whatever
   the site's own JavaScript did to the page at runtime). Elements are matched
   by the data-e keys that annotate.mjs adds.

   Ops are kept in localStorage until Save, so unsaved edits survive Preview,
   going to another page and reloading. On load they're replayed. Undo moves
   the last op to a redo stack and replays; Redo moves it back. Save replays
   each edited page's ops onto its current source: one commit through /api/save.

   Per-site quirks go in window.EDITOR_HOOKS (see README), not in here.
   ========================================================================== */
(function () {
  'use strict';

  var PAGES = [];          // from /api/config
  var DATA_FILES = {};     // from /api/config: { 'path/to/data.js': 'label shown in the panel' }
  var GLOBAL_BLOCKS = [];  // selectors of blocks shared by every page (header, footer, …)
  var UPLOAD_DIR = 'uploads';
  var HOOKS = window.EDITOR_HOOKS || {};
  // Parts of pages your JS draws from a data file: [selector, data file, dotted path, label].
  // While editing, a button above each opens that list in "Site data".
  var DATA_REGIONS = HOOKS.dataRegions || [];
  // "+ Add" → new blocks: [label, html]. {k} becomes a fresh key.
  var BLOCKS = HOOKS.blocks || [
    ['Paragraph', '<p data-e="{k}">New paragraph</p>'],
    ['Heading', '<h3 data-e="{k}">New heading</h3>'],
    ['Button link', '<a class="button" href="#" data-e="{k}">New button</a>']
  ];
  var FONTS = HOOKS.fonts || [['Default', ''], ['Serif', 'Georgia, serif'], ['Sans-serif', 'system-ui, sans-serif'],
    ['Monospace', 'ui-monospace, monospace']];
  var SIZES = [['Default', ''], ['Small', '0.85em'], ['Large', '1.25em'], ['Larger', '1.6em'], ['Huge', '2.2em']];
  var PAGE = pageFile(location.pathname);
  var DRAFT_KEY = 'ed-draft', CLIP_KEY = 'ed-clip';

  var src = null, srcSha = null;              // this page's source DOM + the sha it came from
  var maxKey = { '': 0, g: 0 };
  var dirtyUnits = new Set();                 // text keys typed into since the last sync
  var data = {};                              // path → { obj, sha, prefix, open, templates }
  var editing = false, busy = false, syncTimer = 0;
  var draft = readDraft();                    // { seq, pages: {page: [op]}, global: [op], data: {path: {obj, sha, prefix, n}}, redo: [op] }

  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };

  function pageFile(path) {
    var p = decodeURIComponent(path.split('/').pop() || 'index.html');
    return /\.html$/.test(p) ? p : p + '.html';
  }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { el.addEventListener(ev, attrs.on[ev]); });
      else if (k in el && k !== 'list') el[k] = attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) el.append(c); });
    return el;
  }
  function keyOf(el) { return el.getAttribute('data-e'); }
  function kindOf(k) { return k.replace(/^g/, '').charAt(0); }
  function byKey(d, k) { return d && k ? d.querySelector('[data-e="' + k + '"]') : null; }
  function srcEl(k) { return byKey(src, k); }
  function liveEl(k) { return byKey(document, k); }
  function parseHtml(text) { return new DOMParser().parseFromString(text, 'text/html'); }
  function serialize(d) { return '<!DOCTYPE html>' + d.documentElement.outerHTML; } // same output as scripts/annotate.mjs
  function fragment(d, html) { var t = d.createElement('template'); t.innerHTML = html; return t.content.firstElementChild; }
  function safeUrl(u) { return !/^\s*(javascript|data|vbscript):/i.test(u); }

  async function api(path, body) {
    var r = await fetch('/api/' + path, body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw Object.assign(new Error(d.error || 'Error ' + r.status), { status: r.status });
    return d;
  }
  // The site uses clean URLs (/about), Apache maps them to the files (about.html).
  function servedUrl(path) { return '/' + (path === 'index.html' ? '' : path.replace(/\.html$/, '')); }
  function pageOfHref(href) {
    var p = String(href || '').split(/[?#]/)[0].replace(/^\//, '').replace(/\.html$/, '');
    return p === '' ? 'index.html' : p + '.html';
  }
  function fetchServed(path) {
    return fetch(servedUrl(path) + (path.indexOf('?') < 0 ? '?' : '&') + 'v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); });
  }

  /* ------------------------------------------------------------- drafts */
  function readDraft() {
    try { var d = JSON.parse(localStorage.getItem(DRAFT_KEY)); if (d && d.pages) { d.redo = d.redo || []; return d; } } catch (e) { /* none or unreadable */ }
    return { seq: 0, pages: {}, global: [], data: {}, redo: [] };
  }
  function writeDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
    catch (e) { refreshBar('Too big to keep as a draft (large images?). Save soon, or it is lost on reload.'); }
  }
  function upKey(path) { return 'ed-up:' + path; }
  function upload(path) { try { return JSON.parse(localStorage.getItem(upKey(path))); } catch (e) { return null; } }
  function liveUrl(v) { var u = v && upload(v); return u ? 'data:' + u.type + ';base64,' + u.b64 : v; }
  function listFor(op) { return op.k && op.k.charAt(0) === 'g' ? draft.global : (draft.pages[PAGE] = draft.pages[PAGE] || []); }
  function isGlobal(op) { return listFor(op) === draft.global; }
  function opsFor(page) { return (draft.pages[page] || []).concat(draft.global).sort(function (a, b) { return a.seq - b.seq; }); }
  function pending() {
    var n = draft.global.length;
    Object.keys(draft.pages).forEach(function (p) { n += draft.pages[p].length; });
    Object.keys(draft.data).forEach(function (p) { n += draft.data[p].n || 0; });
    return n;
  }
  function editedPages() {
    return Object.keys(draft.pages).filter(function (p) { return draft.pages[p].length; });
  }

  // Apply a change to the source DOM and the live page, then remember it.
  function commit(op, skipLive) {
    apply(op, src, skipLive ? null : document);
    record(op);
  }
  function record(op) {
    var list = listFor(op);
    op.seq = ++draft.seq;
    var i = op.id ? list.findIndex(function (o) { return o.id === op.id; }) : -1;
    if (i >= 0) list.splice(i, 1);                     // text edits: only the latest version of a block is kept
    list.push(op);
    draft.redo = [];
    writeDraft();
    refreshBar();
  }

  // op.t: text | attr | link | img | after | move | del | head | select. Returns false if its target is gone.
  function apply(op, S, L) {
    var s = byKey(S, op.k), l = byKey(L, op.k);
    if (op.k && !s) return false;
    switch (op.t) {
      case 'text':
        s.innerHTML = op.html;
        if (l) { l.innerHTML = op.html; l.edReady = true; }
        if (HOOKS.syncUnit) HOOKS.syncUnit(s, l);        // per-site fix-ups (see README)
        break;
      case 'attr':
        [s, l].forEach(function (n, live) {
          if (n) Object.keys(op.a).forEach(function (a) {
            if (op.a[a] == null) n.removeAttribute(a); else n.setAttribute(a, live && a === 'src' ? liveUrl(op.a[a]) : op.a[a]);
          });
        });
        break;
      case 'link':
        [s, l].forEach(function (n) {
          var a = n && anchorAt(n, op.i);
          if (!a) return;
          a.setAttribute('href', op.href);
          if (op.blank) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
          else { a.removeAttribute('target'); a.removeAttribute('rel'); }
        });
        break;
      case 'img':                                      // every copy of the old picture in this section is replaced
        [S, L].forEach(function (d, live) {
          var n = byKey(d, op.k);
          if (!n) return;
          var url = live ? liveUrl(op.path) : op.path;
          var scope = n.closest('section, header, footer, main, figure') || d.body;
          $$('img', scope).forEach(function (im) {
            if (im.getAttribute('src') !== op.old && im !== n) return;
            im.setAttribute('src', url);
            im.removeAttribute('srcset');
            if (op.w && im.hasAttribute('width')) { im.setAttribute('width', op.w); im.setAttribute('height', op.h); }
          });
          $$('a', scope).forEach(function (a) {
            if (a.getAttribute('href') !== op.old) return;
            a.setAttribute('href', url);
            if (a.hasAttribute('data-label')) a.setAttribute('data-label', op.path.split('/').pop());
          });
        });
        break;
      case 'after': {
        var node = fragment(S, op.html);
        s.after(node);
        noteKeys(node);
        if (l) {
          var ln = document.importNode(node, true);
          $$('img', ln).forEach(function (im) { im.setAttribute('src', liveUrl(im.getAttribute('src'))); });
          l.after(ln);
          prepTree(ln);
        }
        break;
      }
      case 'move':
        [s, l].forEach(function (n) {
          if (!n) return;
          var sib = siblings(n)[siblings(n).indexOf(n) + op.dir];
          if (sib) { if (op.dir < 0) sib.before(n); else sib.after(n); }
        });
        break;
      case 'del':
        s.remove();
        if (l) l.remove();
        break;
      case 'head': {
        var m = S.querySelector(op.sel);
        if (!m) return false;
        if (op.sel === 'title') { m.textContent = op.v; if (L) L.title = op.v; } else m.setAttribute('content', op.v);
        break;
      }
      case 'select':
        [S, L].forEach(function (d) {
          var sel = d && d.getElementById(op.sel);
          if (!sel) return;
          var ws = sel.firstChild && sel.firstChild.nodeType === 3 ? sel.firstChild.data : '';   // keep the source indented
          var end = sel.lastChild && sel.lastChild.nodeType === 3 ? sel.lastChild.data : '';
          sel.textContent = '';
          op.options.forEach(function (o) { var opt = d.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; sel.append(ws, opt); });
          sel.append(end);
        });
        break;
    }
    return true;
  }
  function anchors(el) { return [el.closest('a')].concat($$('a', el)).filter(Boolean); }
  function anchorAt(el, i) { return anchors(el)[i]; }
  function noteKeys(root) {
    [root].concat($$('[data-e]', root)).forEach(function (n) {
      var m = /^(g?)[tmi](\d+)$/.exec(n.getAttribute('data-e') || '');
      if (m) maxKey[m[1]] = Math.max(maxKey[m[1]], +m[2]);
    });
  }

  /* ------------------------------------------------------------------ bar */
  var bar, status, saveBtn, editBtn, undoBtn, redoBtn;
  function tool(label, title, fn, keepFocus) {
    return h('button', { type: 'button', className: 'ed-btn', title: title, textContent: label, on: {
      mousedown: function (e) { if (keepFocus) e.preventDefault(); }, // keep the text selection for B / I / Link / Style
      click: fn
    } });
  }
  function buildBar() {
    status = h('span', { className: 'ed-status', role: 'status' });
    saveBtn = tool('Save', 'Save all pending edits (every page) and publish', save);
    saveBtn.classList.add('ed-btn--gold');
    editBtn = tool('Preview', 'Use the site normally. Your unsaved edits stay.', function () { setEditing(!editing); });
    undoBtn = tool('Undo', 'Undo the last change on this page (Ctrl/⌘+Z outside text)', undo);
    redoBtn = tool('Redo', 'Redo what Undo took back (Ctrl/⌘+Shift+Z)', redo);
    var pagePick = h('select', { className: 'ed-select', title: 'Go to page (unsaved edits are kept)', on: { change: function () { go(servedUrl(this.value)); } } },
      PAGES.map(function (p) {
        return h('option', { value: p, textContent: p.replace('.html', '') + ((draft.pages[p] || []).length ? ' •' : ''), selected: p === PAGE });
      }));
    bar = h('div', { className: 'ed-bar', 'data-ed-ui': '' }, [
      h('span', { className: 'ed-group' }, [h('strong', { textContent: 'Editor' }), pagePick]),
      h('span', { className: 'ed-group ed-format' }, [
        tool('B', 'Bold (select text first)', function () { document.execCommand('bold'); }, true),
        tool('I', 'Italic (select text first)', function () { document.execCommand('italic'); }, true),
        tool('Link', 'Add, change or remove a link', function () { editLink(); }, true),
        tool('Style', 'Colour, size and font of the selected words (or the whole block)', function () { openStyle(); }, true)
      ]),
      h('span', { className: 'ed-group' }, [
        tool('Page', 'Page title, description and all images on this page', openPagePanel),
        tool('Site data', 'Lists and settings the site renders from its data file', openDataPanel),
        tool('Help', 'How editing works', openHelp)
      ]),
      status,
      h('span', { className: 'ed-group ed-end' }, [
        undoBtn,
        redoBtn,
        editBtn,
        tool('Discard', 'Throw away all unsaved edits', discard),
        saveBtn,
        tool('Sign out', 'Sign out of the editor', signOut)
      ])
    ]);
    document.body.append(bar);
    refreshBar();
  }
  function refreshBar(msg) {
    var n = pending(), pages = editedPages().filter(function (p) { return p !== PAGE; });
    if (msg != null) status.textContent = msg;
    else if (n) status.textContent = n + ' unsaved edit' + (n > 1 ? 's' : '') + (pages.length ? ' (also on ' + pages.join(', ').replace(/\.html/g, '') + ')' : '') +
      (editing ? '' : ' · Preview');
    else status.textContent = editing ? 'Click any text to edit it' : 'Preview: the site works as normal';
    saveBtn.disabled = busy || !n;
    saveBtn.textContent = n ? 'Save (' + n + ')' : 'Save';
    undoBtn.disabled = busy || !opsFor(PAGE).length;
    redoBtn.disabled = busy || !draft.redo.length;
    editBtn.textContent = editing ? 'Preview' : 'Edit';
  }
  function lock(msg) {
    setEditing(false);
    $$('.ed-btn, .ed-select', bar).forEach(function (b) { if (!/Sign out|Reload/.test(b.textContent)) b.disabled = true; });
    status.textContent = msg;
  }
  function go(url) { syncUnits(); location.href = url; }

  /* ------------------------------------------------------------- editing */
  function setEditing(on) {
    syncUnits();
    editing = on && !!src;
    document.documentElement.classList.toggle('ed-on', editing);
    $$('[data-e]').forEach(function (el) { prep(el, editing); });
    $$('.ed-region').forEach(function (n) { n.remove(); });
    if (editing) DATA_REGIONS.forEach(function (r) {
      $$(r[0]).forEach(function (el) {
        el.before(h('button', { type: 'button', className: 'ed-btn ed-btn--gold ed-region', 'data-ed-ui': '',
          textContent: '✎ Edit ' + r[3].toLowerCase() + ' (add, change, remove)', on: { click: function () { openDataPanel(r[1], r[2]); } } }));
      });
    });
    if (!editing && itemBar) itemBar.hidden = true;
    refreshBar();
  }
  // Text blocks get their source HTML back (undoing whatever site.js did to them) and become editable.
  function prep(el, on) {
    var k = keyOf(el);
    if (kindOf(k) !== 't') return;
    var s = srcEl(k);
    if (!s) return;
    if (on) {
      if (HOOKS.beforeEdit && !el.edReady) el = HOOKS.beforeEdit(el) || el;   // e.g. detach an element the site animates
      if (!el.edReady && !dirtyUnits.has(k)) { el.innerHTML = s.innerHTML; el.edReady = true; }
      el.setAttribute('contenteditable', 'true');
      el.spellcheck = true;
    } else {
      el.removeAttribute('contenteditable');
    }
  }
  function prepTree(root) { [root].concat($$('[data-e]', root)).forEach(function (el) { if (el.hasAttribute('data-e')) prep(el, editing); }); }

  // Copy typed text into ops, tidying what contenteditable leaves behind.
  function syncUnits() {
    clearTimeout(syncTimer);
    dirtyUnits.forEach(function (k) {
      var live = liveEl(k);
      if (!live || !srcEl(k)) return;
      var t = live.cloneNode(true);
      $$('[style]:not([data-s])', t).forEach(function (n) { n.removeAttribute('style'); });
      $$('[contenteditable]', t).forEach(function (n) { n.removeAttribute('contenteditable'); });
      $$('font, span:not([class]):not([id]):not([data-e]):not([lang]):not([data-s])', t).forEach(function (n) { n.replaceWith.apply(n, n.childNodes); });
      $$('.new-tab', t).forEach(function (n) { n.remove(); });
      commit({ t: 'text', id: 'text:' + k, k: k, html: t.innerHTML }, true);
    });
    dirtyUnits.clear();
  }
  function markDirty(unit) {
    dirtyUnits.add(keyOf(unit));
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncUnits, 700);
    if (!pending()) refreshBar('Unsaved edits');
  }

  function onInput(e) {
    var u = e.target.closest && e.target.closest('[contenteditable][data-e]');
    if (u) markDirty(u);
  }
  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); return save(); }
    var inText = e.target.closest && e.target.closest('[contenteditable], input, textarea');
    if ((e.metaKey || e.ctrlKey) && !inText && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); return redo(); }
    if ((e.metaKey || e.ctrlKey) && !inText && e.key.toLowerCase() === 'z') { e.preventDefault(); return undo(); }
    if (!editing || !e.target.closest || !e.target.closest('[contenteditable]')) return;
    if (e.key === 'Enter' && !e.shiftKey) {             // new blocks come from the item menu
      e.preventDefault();
      refreshBar('Tip: Shift+Enter for a line break. To add a paragraph, hover a block and use + (add after).');
    }
  }
  function onPaste(e) {
    if (!editing || !e.target.closest || !e.target.closest('[contenteditable]')) return;
    e.preventDefault();                                 // plain text only: no fonts or colours from Word / web pages
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  }
  // While editing, clicks never follow links, submit forms, open the lightbox or play audio.
  function onClick(e) {
    if (!editing || e.target.closest('[data-ed-ui]')) return;
    var img = e.target.closest('img[data-e]');
    var inUnit = e.target.closest('[contenteditable]');
    if (img && !inUnit) { e.preventDefault(); e.stopPropagation(); return openImage(img); }
    if (inUnit || e.target.closest('a, [type=submit]')) { e.preventDefault(); e.stopPropagation(); }
  }
  // Drop-down lists (select boxes) open their options editor instead of the list.
  function onPointerDown(e) {
    if (!editing || e.target.closest('[data-ed-ui]')) return;
    var sel = e.target.closest('select[id]');
    if (sel && src.getElementById(sel.id)) { e.preventDefault(); e.stopPropagation(); openSelect(sel.id); }
  }

  /* -------------------------------------------------------------- links */
  function selectionIn() {
    var sel = getSelection();
    var node = sel.rangeCount && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    return { sel: sel, node: node, unit: node && node.closest && node.closest('[contenteditable][data-e]') };
  }
  function ownerOf(a) { return a.closest('[data-e]') || $$('[data-e]', a)[0]; }

  // From the bar: the link at the cursor, or make the selected words a link.
  function editLink() {
    var c = selectionIn();
    if (!c.unit) return alert('Click into some text first (select words to turn them into a link). Or hover a block and use 🔗.');
    var a = c.node.closest('a');
    if (a) return openLink(a);
    if (c.sel.isCollapsed) return alert('Select the words to turn into a link first.');
    var u = prompt('Link address (e.g. https://…, /about, mailto:hello@example.com):', 'https://');
    if (!u || u === 'https://' || !safeUrl(u)) return;
    document.execCommand('createLink', false, u.trim());
    markDirty(c.unit);
    syncUnits();
  }
  // Link address, text, new tab, and a way to follow it.
  function openLink(a) {
    if (a.hasAttribute('data-config-href')) {
      var p = a.getAttribute('data-config-href');
      if (confirm('This link comes from Site data → ' + p.replace(/\./g, ' → ') + '. Open it there?')) openDataPanel(Object.keys(DATA_FILES)[0], p);
      return;
    }
    var owner = ownerOf(a);
    if (!owner || !srcEl(keyOf(owner))) return alert('This link can’t be edited here.');
    var i = anchors(owner).indexOf(a);
    var textUnit = a.closest('[contenteditable][data-e]');
    var plain = !a.firstElementChild;                   // only plain-text links get a text field
    var url = h('input', { value: a.getAttribute('href') || '' });
    var text = h('input', { value: a.textContent.trim() });
    var blank = h('input', { type: 'checkbox', checked: a.getAttribute('target') === '_blank' });
    modal('Link', [
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'Address' }), url,
        h('small', { textContent: 'https://…, /about, /contact#book, mailto:…, tel:…' })]),
      textUnit && plain && h('label', { className: 'ed-field' }, [h('span', { textContent: 'Text' }), text]),
      h('label', { className: 'ed-field ed-field--check' }, [h('span', { textContent: 'Open in a new tab' }), blank]),
      h('p', {}, [
        tool('Open this link ↗', 'Go to the link (your edits are kept)', function () { go(a.href); }),
        ' ',
        textUnit && textUnit !== a && tool('Remove link', 'Keep the words, drop the link', function () {
          a.replaceWith.apply(a, a.childNodes);
          markDirty(textUnit); syncUnits();
          this.closest('dialog').close();
        })
      ])
    ], function () {
      var v = url.value.trim();
      if (!v || !safeUrl(v)) throw new Error('Enter a link address.');
      if (v !== a.getAttribute('href') || blank.checked !== (a.getAttribute('target') === '_blank')) {
        commit({ t: 'link', id: 'link:' + keyOf(owner) + ':' + i, k: keyOf(owner), i: i, href: v, blank: blank.checked });
      }
      if (textUnit && plain && text.value.trim() !== a.textContent.trim()) {
        a.textContent = text.value.trim();
        markDirty(textUnit); syncUnits();
      }
    });
  }

  /* -------------------------------------------------------------- style */
  function styleFields(el) {
    var st = el ? el.style : {};
    function row(label, input) { return h('label', { className: 'ed-field' }, [h('span', { textContent: label }), input]); }
    function pick(opts, v) { return h('select', { className: 'ed-select' }, opts.map(function (o) { return h('option', { value: o[1], textContent: o[0], selected: o[1] === v }); })); }
    function colour(v) {
      var on = h('input', { type: 'checkbox', checked: !!v, title: 'Use this colour' });
      var c = h('input', { type: 'color', value: toHex(v) || '#000000', on: { input: function () { on.checked = true; } } });
      return { on: on, c: c, el: h('span', { className: 'ed-colour' }, [on, c, h('small', { textContent: 'tick to use' })]) };
    }
    var f = { color: colour(st.color), background: colour(st.backgroundColor), size: pick(SIZES, st.fontSize || ''), font: pick(FONTS, st.fontFamily || '') };
    f.nodes = [row('Text colour', f.color.el), row('Highlight / background', f.background.el), row('Size', f.size), row('Font', f.font)];
    f.css = function () {
      return { color: f.color.on.checked ? f.color.c.value : '', 'background-color': f.background.on.checked ? f.background.c.value : '',
        'font-size': f.size.value, 'font-family': f.font.value };
    };
    return f;
  }
  function toHex(c) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
    return m ? '#' + [1, 2, 3].map(function (i) { return ('0' + (+m[i]).toString(16)).slice(-2); }).join('') : /^#[0-9a-f]{6}$/i.test(c || '') ? c : '';
  }
  function cssText(css, base) {
    var t = h('span');
    t.style.cssText = base || '';
    Object.keys(css).forEach(function (p) { if (css[p]) t.style.setProperty(p, css[p]); else t.style.removeProperty(p); });
    return t.style.cssText;
  }
  // Selected words → a styled <span data-s>. No selection → the whole block (or the hovered item).
  function openStyle(target) {
    var c = selectionIn();
    var range = !target && c.unit && !c.sel.isCollapsed ? c.sel.getRangeAt(0).cloneRange() : null;
    var el = target || c.unit;
    if (!el) return alert('Select some words, or click into a block, first. Or hover a block and use 🎨.');
    var f = styleFields(range ? null : el);
    modal(range ? 'Style the selected words' : 'Style this block', f.nodes.concat([
      h('p', {}, [tool('Clear all styling', 'Remove colours, sizes and fonts set here', function () {
        var k = keyOf(el);
        $$('[data-s]', el).forEach(function (n) { n.replaceWith.apply(n, n.childNodes); });
        if (kindOf(k) === 't') { markDirty(el); syncUnits(); }
        commit({ t: 'attr', id: 'style:' + k, k: k, a: { style: null } });
        this.closest('dialog').close();
      })])
    ]), function () {
      var css = f.css();
      if (range) {
        $('dialog.ed-modal[open]').close();              // an open modal makes the page inert, and commands need the text block
        var s = getSelection();
        c.unit.focus();
        s.removeAllRanges(); s.addRange(range);
        document.execCommand('styleWithCSS', false, false);
        document.execCommand('fontName', false, 'ed-mark');   // marks every selected piece, across tags
        $$('font[face="ed-mark"], span[style*="ed-mark"]', c.unit).forEach(function (n) {
          var sp = h('span', { 'data-s': '' });
          sp.style.cssText = cssText(css);
          sp.append.apply(sp, n.childNodes);
          n.replaceWith(sp);
        });
        markDirty(c.unit); syncUnits();
      } else {
        var k = keyOf(el);
        var v = cssText(css, srcEl(k).getAttribute('style'));
        commit({ t: 'attr', id: 'style:' + k, k: k, a: { style: v || null } });
      }
    });
  }

  /* -------------------------------------------------------- select boxes */
  function openSelect(id) {
    var s = src.getElementById(id);
    var rows = $$('option', s).map(function (o) { return [o.getAttribute('value') == null ? o.textContent : o.getAttribute('value'), o.textContent]; });
    var box = h('div');
    function draw() {
      box.textContent = '';
      rows.forEach(function (r, i) {
        box.append(h('div', { className: 'ed-opt' }, [
          h('input', { value: r[1], placeholder: 'Shown to visitors', on: { input: function () { r[1] = this.value; } } }),
          h('input', { value: r[0], placeholder: 'Value (sent with the form)', on: { input: function () { r[0] = this.value; } } }),
          tool('↑', 'Move up', function () { if (i) { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); draw(); } }),
          tool('✕', 'Remove', function () { rows.splice(i, 1); draw(); })
        ]));
      });
      box.append(tool('+ Add option', 'Add a choice at the end', function () { rows.push(['', '']); draw(); box.lastChild.previousSibling.firstChild.focus(); }));
    }
    draw();
    var label = src.querySelector('label[for="' + id + '"]');
    modal('Choices: ' + (label ? label.textContent.trim() : id), [
      h('p', { className: 'ed-note', textContent: 'Left: the text visitors see. Right: the value sent with the form (short, no spaces is best). An option with an empty value works as the “Choose…” prompt.' }),
      box
    ], function () {
      var opts = rows.filter(function (r) { return r[1].trim() || r[0].trim(); }).map(function (r) { return [r[0].trim(), r[1].trim() || r[0].trim()]; });
      if (!opts.length) throw new Error('Keep at least one choice.');
      commit({ t: 'select', id: 'select:' + id, sel: id, options: opts });
    });
  }

  /* -------------------------------------------------------------- items */
  var itemBar, current, linkBtns, held = null;
  function buildItemBar() {
    linkBtns = [
      tool('🔗', 'Edit this link (address, text, new tab)', function () { openLink(anchors(current)[0]); }),
      tool('↗', 'Open this link (your edits are kept)', function () { go(anchors(current)[0].href); })
    ];
    itemBar = h('div', { className: 'ed-item', 'data-ed-ui': '', hidden: true }, [
      tool('⤴', 'Select the block around this one (e.g. the whole card or section)', function () {
        var p = current.parentElement.closest('[data-e]');
        if (p && srcEl(keyOf(p))) { held = p; showItemBar(p); } else refreshBar('Nothing editable around this.');
      }),
      tool('+', 'Add after this: a new paragraph, heading, button, or something you copied or removed', function () { openAdd(current); }),
      tool('⧉', 'Duplicate this', function () { dup(current); }),
      tool('Copy', 'Copy this, to paste anywhere with + (also on other pages)', function () { clip(current, 'Copied'); refreshBar('Copied. Hover where it should go and use + to paste.'); }),
      tool('↑', 'Move up', function () { move(current, -1); }),
      tool('↓', 'Move down', function () { move(current, 1); }),
      linkBtns[0], linkBtns[1],
      tool('🎨', 'Colour, size and font of this block', function () { openStyle(current); }),
      tool('✕', 'Remove this (Undo, or + → paste, brings it back)', function () { del(current); })
    ]);
    document.body.append(itemBar);
    document.addEventListener('pointerover', function (e) {
      if (!editing || e.target.closest('[data-ed-ui]')) return;
      if (held && held.contains(e.target)) return;      // stay on the block picked with ⤴ or clicked into
      held = null;
      var it = e.target.closest('[data-e-list] > [data-e]') || e.target.closest('[data-e]');
      if (it && it !== current && srcEl(keyOf(it))) showItemBar(it);
    }, true);
    document.addEventListener('focusin', function (e) {  // typing in a block: its menu acts on that block
      var u = editing && e.target.closest && e.target.closest('[contenteditable][data-e]');
      if (u) { held = u; showItemBar(u); }
    });
    addEventListener('scroll', function () { if (current && !itemBar.hidden) showItemBar(current); }, { passive: true });
  }
  function showItemBar(it) {
    var r = it.getBoundingClientRect();
    if (!r.width || !r.height) return;
    current = it;
    var a = anchors(it)[0];
    linkBtns.forEach(function (b) { b.hidden = !(a && a.hasAttribute('href')); });
    itemBar.hidden = false;
    itemBar.style.top = Math.max(0, r.top + scrollY - itemBar.offsetHeight + 2) + 'px';
    itemBar.style.left = Math.max(4, Math.min(r.right + scrollX, innerWidth + scrollX - 8) - itemBar.offsetWidth) + 'px';
    $$('.ed-current').forEach(function (n) { n.classList.remove('ed-current'); });
    it.classList.add('ed-current');
  }
  function siblings(it) { return Array.prototype.filter.call(it.parentElement.children, function (n) { return n.hasAttribute('data-e'); }); }
  function rekey(root, g) {
    [root].concat($$('[data-e]', root)).forEach(function (n) {
      var k = n.getAttribute('data-e');
      if (k) n.setAttribute('data-e', g + kindOf(k) + (++maxKey[g]));
    });
    return root;
  }
  function gOf(it) { return keyOf(it).charAt(0) === 'g' ? 'g' : ''; }
  function insertAfter(it, html) {
    syncUnits();
    var node = rekey(fragment(src, html), gOf(it));
    commit({ t: 'after', k: keyOf(it), html: node.outerHTML });
    var live = liveEl(keyOf(node));
    if (live) { showItemBar(live); live.scrollIntoView({ block: 'nearest' }); }
  }
  function dup(it) { syncUnits(); insertAfter(it, srcEl(keyOf(it)).outerHTML); }
  function move(it, dir) {
    if (!siblings(it)[siblings(it).indexOf(it) + dir]) return;
    syncUnits();
    commit({ t: 'move', k: keyOf(it), dir: dir });
    showItemBar(it);
  }
  function del(it) {
    var last = siblings(it).length < 2;
    if (!confirm(last ? 'Remove this? It is the only one here; Undo brings it back.' : 'Remove this? (Undo, or + → paste, brings it back.)')) return;
    syncUnits();
    clip(it, 'Removed');
    commit({ t: 'del', k: keyOf(it) });
    itemBar.hidden = true;
    current = null;
  }

  // Clipboard: what was copied or removed, newest first, shared by all pages.
  function clips() { try { return JSON.parse(localStorage.getItem(CLIP_KEY)) || []; } catch (e) { return []; } }
  function clip(it, how) {
    syncUnits();
    var s = srcEl(keyOf(it));
    var label = how + ': ' + (s.textContent.replace(/\s+/g, ' ').trim().slice(0, 50) || '<' + s.tagName.toLowerCase() + '>') + ' (' + PAGE.replace('.html', '') + ')';
    var list = [{ label: label, html: s.outerHTML }].concat(clips()).slice(0, 12);
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(list)); } catch (e) { /* full: nothing to paste later */ }
  }
  function openAdd(it) {
    var inList = /^(UL|OL)$/.test(it.parentElement.tagName);
    function choice(label, html, note) {
      return h('button', { type: 'button', className: 'ed-choice', on: { click: function () { d.close(); insertAfter(it, html); } } },
        [h('strong', { textContent: label }), note && h('small', { textContent: note })]);
    }
    var pasted = clips().map(function (c) { return choice(c.label, c.html); });
    var d = modal('Add after this', [
      h('h3', { textContent: 'Paste' }),
      pasted.length ? h('div', { className: 'ed-choices' }, pasted) : h('p', { className: 'ed-note', textContent: 'Nothing copied yet. Hover anything and press Copy; removed things also land here.' }),
      h('h3', { textContent: 'New' }),
      h('div', { className: 'ed-choices' }, [choice('Copy of this', srcEl(keyOf(it)).outerHTML, 'same style, then change the text')].concat(BLOCKS.map(function (b) {
        var html = b[1].replace('{k}', 't0');
        return choice(b[0], inList ? '<li data-e="t0">' + html.replace(/ data-e="t0"/, '') + '</li>' : html);
      })))
    ]);
  }

  /* ------------------------------------------------------------- images */
  function fileToBase64(blob) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok(String(r.result).split(',')[1]); };
      r.onerror = no;
      r.readAsDataURL(blob);
    });
  }
  // Big photos are scaled to 2000px on the long side before upload; small ones go up as they are.
  function slug(name) {
    return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  }
  function keep(path, type, b64) {
    try { localStorage.setItem(upKey(path), JSON.stringify({ type: type, b64: b64 })); }
    catch (e) { throw new Error('This image is too big to hold until Save. Save your other edits first, then try a smaller image.'); }
  }
  async function prepareImage(file) {
    if (file.type === 'image/svg+xml') {            // vector: no bitmap to resize, keep the file as it is
      var svgPath = UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.svg';
      keep(svgPath, file.type, await fileToBase64(file));
      return { path: svgPath, w: 0, h: 0 };
    }
    var bmp = await createImageBitmap(file);
    var scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    var w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
    var ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type] || 'jpg';
    var blob = file, type = file.type;
    if (file.type !== 'image/gif' && (scale < 1 || file.size > 700e3)) {
      var c = h('canvas', { width: w, height: hgt });
      c.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
      type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg'; // webp keeps transparency
      ext = type === 'image/webp' ? 'webp' : 'jpg';
      blob = await new Promise(function (ok) { c.toBlob(ok, type, 0.85); });
    }
    var path = UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext;
    keep(path, type, await fileToBase64(blob));
    return { path: path, w: w, h: hgt };
  }
  function openImage(img) {
    var k = keyOf(img), s = srcEl(k);
    if (!s) return;
    var picked = null;
    var preview = h('img', { src: img.currentSrc || img.src, className: 'ed-preview', alt: '' });
    var file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif,image/svg+xml', on: { change: function () {
      picked = this.files[0];
      if (picked) preview.src = URL.createObjectURL(picked);
    } } });
    var alt = h('textarea', { rows: 3, value: s.getAttribute('alt') || '' });
    var decorative = s.getAttribute('alt') === '' && !s.closest('[data-e-list]');
    modal('Image', [
      preview,
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'Replace with a new image' }), file]),
      h('label', { className: 'ed-field' }, [h('span', { textContent: decorative ? 'Description (empty: decorative, not read out)' : 'Description for screen readers and search engines' }), alt]),
      h('p', { className: 'ed-note', textContent: 'Copies of the same picture in this section (e.g. layered hero images, lightbox links) are replaced together.' })
    ], async function () {
      if (picked) {
        var up = await prepareImage(picked);
        commit({ t: 'img', k: k, old: s.getAttribute('src'), path: up.path, w: up.w, h: up.h });
      }
      if ((s.getAttribute('alt') || '') !== alt.value.trim()) commit({ t: 'attr', id: 'alt:' + k, k: k, a: { alt: alt.value.trim() } });
    });
  }

  /* --------------------------------------------------------- panels / modal */
  function modal(title, body, onOk) {
    var d = h('dialog', { className: 'ed-modal', 'data-ed-ui': '' }, [
      h('h2', { textContent: title }),
      h('div', { className: 'ed-modal__body' }, body),
      h('p', { className: 'ed-modal__actions' }, [
        h('button', { type: 'button', className: 'ed-btn', textContent: onOk ? 'Cancel' : 'Close', on: { click: function () { d.close(); } } }),
        onOk && h('button', { type: 'button', className: 'ed-btn ed-btn--gold', textContent: 'Apply', on: { click: async function () {
          this.disabled = true;
          try { await onOk(); d.close(); } catch (e) { alert(e.message); this.disabled = false; }
        } } })
      ])
    ]);
    d.addEventListener('close', function () { d.remove(); });
    document.body.append(d);
    d.showModal();
    return d;
  }
  function drawer(title, body) {
    $$('.ed-drawer').forEach(function (n) { n.remove(); });
    var d = h('aside', { className: 'ed-drawer', 'data-ed-ui': '' }, [
      h('div', { className: 'ed-drawer__head' }, [h('h2', { textContent: title }),
        h('button', { type: 'button', className: 'ed-btn', textContent: 'Close', on: { click: function () { d.remove(); } } })]),
      h('div', { className: 'ed-drawer__body' }, body)
    ]);
    document.body.append(d);
    return d;
  }
  function openHelp() {
    modal('How editing works', [
      h('ul', {}, [
        'Click any text on the page and type. Shift+Enter makes a line break.',
        'Select words, then B / I / Link / Style in the bar. Style sets colour, size and font. Pasted text arrives plain.',
        'Hover a card, list entry or section for its menu; click into text for that block’s menu, and ⤴ for the block around it. + adds after it (a new paragraph, heading or button, a copy, or anything you copied or removed), ⧉ duplicates, Copy copies it to paste elsewhere (other pages too), ↑ ↓ move, 🔗 edits its link, ↗ follows the link, 🎨 styles it, ✕ removes it.',
        'Undo / Redo step back and forward through your unsaved edits. Removed something? Undo, or + → paste it back.',
        'Click a drop-down list (e.g. on Contact) to change its choices.',
        'Click a picture to replace it or change its description. “Page” lists every image, including ones you can’t click.',
        'The header, menu and footer are shared: editing them here changes every page.',
        'Lists, dates and links that the site draws from a data file are edited under “Site data”. Buttons on the page take you straight there.',
        'Edits are kept in this browser until you Save, even in Preview, on other pages, or after a reload. The counter shows how many are waiting. Save publishes all of them; every save is kept in the history.',
        'Use Preview to click around the site normally, then Edit to continue.'
      ].map(function (t) { return h('li', { textContent: t }); }))
    ]);
  }

  function openPagePanel() {
    if (!src) return;
    function meta(sel) { return src.querySelector(sel); }
    function field(label, value, hint, sels) {
      var input = h(value.length > 70 ? 'textarea' : 'input', { value: value, rows: 3, on: { change: function () {
        var v = this.value;
        sels.forEach(function (sel) { if (meta(sel)) commit({ t: 'head', id: 'head:' + sel, sel: sel, v: v }); });
      } } });
      return h('label', { className: 'ed-field' }, [h('span', { textContent: label }), input, hint && h('small', { textContent: hint })]);
    }
    var title = meta('title'), desc = meta('meta[name=description]'), ogt = meta('meta[property="og:title"]'), ogd = meta('meta[property="og:description"]');
    var imgs = $$('img[data-e]').filter(function (i) { return srcEl(keyOf(i)); });
    drawer('This page · ' + PAGE, [
      title && field('Page title (browser tab and Google)', title.textContent, null, ['title']),
      desc && field('Description (Google results)', desc.getAttribute('content'), 'About 150 characters.', ['meta[name=description]']),
      ogt && field('Title when shared (WhatsApp, Facebook…)', ogt.getAttribute('content'), null, ['meta[property="og:title"]', 'meta[name="twitter:title"]']),
      ogd && field('Description when shared', ogd.getAttribute('content'), null, ['meta[property="og:description"]', 'meta[name="twitter:description"]']),
      h('h3', { textContent: 'Images on this page (' + imgs.length + ')' }),
      h('div', { className: 'ed-thumbs' }, imgs.map(function (i) {
        return h('button', { type: 'button', title: srcEl(keyOf(i)).getAttribute('alt') || '(decorative)', on: { click: function () { openImage(i); } } },
          [h('img', { src: i.currentSrc || i.src, alt: '' })]);
      }))
    ]);
  }

  /* ------------------------------------------------------------ site data */
  async function loadData(path) {
    if (data[path]) return data[path];
    var f = await api('file?path=' + encodeURIComponent(path));
    var m = /^([\s\S]*?window\.[A-Za-z_$][\w$]* = )([\s\S]*);\s*$/.exec(f.content);
    if (!m) throw new Error(path + ' must look like:  window.NAME = { …JSON… };');
    var kept = draft.data[path];
    var obj = kept ? kept.obj : JSON.parse(m[2]);
    return (data[path] = { obj: obj, sha: kept ? kept.sha : f.sha, prefix: m[1], open: new Set(), templates: templates(JSON.parse(m[2])) });
  }
  // First item of every array, blanked: the template for "Add" once a list has been emptied.
  function templates(obj, path, out) {
    out = out || {};
    if (Array.isArray(obj)) { if (obj.length) out[path] = blank(obj[0]); obj.forEach(function (v) { templates(v, path + '[]', out); }); }
    else if (obj && typeof obj === 'object') Object.keys(obj).forEach(function (k) { templates(obj[k], (path ? path + '.' : '') + k, out); });
    return out;
  }
  function blank(v) {
    if (Array.isArray(v)) return v.map(blank);
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = blank(v[k]); }); return o; }
    return typeof v === 'string' ? '' : typeof v === 'boolean' ? false : v;
  }
  function humanize(k) { return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function summary(v, i) {
    if (Array.isArray(v)) return v.filter(function (x) { return typeof x !== 'object'; }).join(' → ') || '#' + (i + 1);
    if (v && typeof v === 'object') {
      var name = ['title', 'name', 'label', 'heading', 'caption', 'id'].map(function (k) { return v[k]; }).filter(Boolean)[0] ||
        Object.keys(v).map(function (k) { return v[k]; }).filter(function (x) { return typeof x === 'string' && x.trim(); })[0];
      var when = v.date || v.year;
      return (when ? when + ' · ' : '') + (name || '#' + (i + 1));
    }
    return String(v === null ? '' : v) || '(empty)';
  }

  // pathArg / focus: open this file with this dotted path (e.g. "concerts.upcoming") expanded.
  async function openDataPanel(pathArg, focus) {
    var pick = h('select', { className: 'ed-select' }, Object.keys(DATA_FILES).map(function (p) {
      return h('option', { value: p, textContent: DATA_FILES[p] });
    }));
    var box = h('div', { className: 'ed-data' });
    drawer('Site data', [pick, h('p', { className: 'ed-note', textContent: 'Changes here show on the site after Save (the page reloads once published). “+ Add” at the end of a list adds an entry.' }), box]);
    async function show() {
      box.textContent = 'Loading…';
      try {
        var d = await loadData(pick.value);
        if (typeof focus === 'string') {
          focus.split('.').reduce(function (acc, part) { var p = acc ? acc + '.' + part : part; d.open.add(p); return p; }, '');
          focus = null;
        }
        box.textContent = '';
        render(box, d, pick.value);
        var target = $('details[data-path="' + CSS.escape(focusPath) + '"]', box);
        if (target) target.scrollIntoView({ block: 'start' });
      } catch (e) { box.textContent = e.message; }
    }
    var focusPath = typeof focus === 'string' ? focus : '';
    pick.addEventListener('change', show);
    if (typeof pathArg === 'string') pick.value = pathArg;
    show();
  }

  function render(box, d, file) {
    var t = 0;
    function changed() {
      var kept = draft.data[file] = draft.data[file] || { sha: d.sha, prefix: d.prefix, n: 0 };
      kept.obj = d.obj;
      if (!t) kept.n++;                                 // a burst of typing counts as one edit
      clearTimeout(t);
      t = setTimeout(function () { t = 0; }, 1500);
      writeDraft(); refreshBar();
    }
    function rerender() { var y = box.parentElement.scrollTop; box.textContent = ''; render(box, d, file); box.parentElement.scrollTop = y; }
    function node(parent, holder, key, label, path) {
      var v = holder[key];
      if (v && typeof v === 'object') {
        var det = h('details', { open: d.open.has(path), 'data-path': path, on: { toggle: function () { if (det.open) d.open.add(path); else d.open.delete(path); } } });
        det.append(h('summary', { textContent: label + (Array.isArray(v) ? ' (' + v.length + ')' : '') }));
        parent.append(det);
        if (Array.isArray(v)) {
          v.forEach(function (item, i) {
            var row = h('div', { className: 'ed-row' });
            var tools = h('span', { className: 'ed-row__tools' }, [
              tool('⧉', 'Duplicate', function () { v.splice(i + 1, 0, JSON.parse(JSON.stringify(item))); changed(); rerender(); }),
              tool('↑', 'Move up', function () { if (i) { v.splice(i - 1, 0, v.splice(i, 1)[0]); changed(); rerender(); } }),
              tool('↓', 'Move down', function () { if (i < v.length - 1) { v.splice(i + 1, 0, v.splice(i, 1)[0]); changed(); rerender(); } }),
              tool('✕', 'Delete', function () { if (confirm('Delete “' + summary(item, i) + '”?')) { v.splice(i, 1); changed(); rerender(); } })
            ]);
            row.append(tools);
            det.append(row);
            node(row, v, i, item && typeof item === 'object' ? summary(item, i) : '#' + (i + 1), path + '[' + i + ']');
          });
          det.append(tool('+ Add', 'Add a new blank entry at the end', function () {
            var t = v.length ? blank(v[v.length - 1]) : d.templates[path.replace(/\[\d+\]/g, '[]')];
            v.push(t === undefined ? '' : JSON.parse(JSON.stringify(t)));
            d.open.add(path);
            d.open.add(path + '[' + (v.length - 1) + ']');
            changed(); rerender();
          }));
        } else {
          Object.keys(v).forEach(function (k) { node(det, v, k, humanize(k), path + '.' + k); });
        }
        return;
      }
      var input;
      if (typeof v === 'boolean') {
        input = h('input', { type: 'checkbox', checked: v, on: { change: function () { holder[key] = this.checked; changed(); } } });
      } else if (typeof v === 'number') {
        input = h('input', { type: 'number', step: 'any', value: v, on: { input: function () { holder[key] = this.value === '' ? null : Number(this.value); changed(); } } });
      } else {
        var s = v == null ? '' : String(v);
        var date = key === 'date' || /^\d{4}-\d\d-\d\d$/.test(s);
        var attrs = { value: s, on: { input: function () {
          var t = this.value;
          holder[key] = v === null ? (t === '' ? null : /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t) : t;
          changed();
        } } };
        if (date) attrs.type = 'date'; else if (s.length > 60) attrs.rows = Math.min(8, Math.ceil(s.length / 55) + 1);
        input = h(!date && s.length > 60 ? 'textarea' : 'input', attrs);
        if (/REPLACE/.test(s)) input.classList.add('ed-placeholder');
      }
      parent.append(h('label', { className: 'ed-field' + (typeof v === 'boolean' ? ' ed-field--check' : '') }, [h('span', { textContent: label }), input]));
    }
    Object.keys(d.obj).forEach(function (k) { node(box, d.obj, k, humanize(k), k); });
  }

  /* ---------------------------------------------------------------- save */
  function fixNav(d, page) {
    $$('header nav a, #mobile-menu nav a', d).forEach(function (a) {
      if (pageOfHref(a.getAttribute('href')) === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  async function save() {
    syncUnits();
    if (busy || !pending()) return;
    busy = true;
    refreshBar('Saving…');
    try {
      var files = [], names = [];
      var pages = draft.global.length ? PAGES : editedPages();
      for (var i = 0; i < pages.length; i++) {
        var p = pages[i], d, sha, before;
        if (p === PAGE) { d = src; sha = srcSha; before = null; }
        else {
          refreshBar('Saving… ' + p);
          var f = await api('file?path=' + p);
          d = parseHtml(f.content); sha = f.sha; before = f.content;
          var lost = opsFor(p).filter(function (op) { return !apply(op, d, null) && !isGlobal(op); }).length; // shared-block keys a page lacks are fine
          if (lost) throw new Error(p + ' changed since you edited it (' + lost + ' edit' + (lost > 1 ? 's' : '') + ' no longer fit). Open it, check, and save again.');
        }
        GLOBAL_BLOCKS.length && fixNav(d, p);
        var out = serialize(d);
        if (out !== before) { files.push({ path: p, sha: sha, content: out }); names.push(p); }
      }
      Object.keys(draft.data).forEach(function (p) {
        var k = draft.data[p];
        if (!k.n) return;
        files.push({ path: p, sha: k.sha, content: k.prefix + JSON.stringify(k.obj, null, 2) + ';\n' });
        names.push(DATA_FILES[p] || p);
      });
      var html = files.map(function (f) { return f.content; }).join('\n');
      Object.keys(localStorage).filter(function (k) { return k.indexOf('ed-up:') === 0; }).forEach(function (k) {
        var p = k.slice(6), u = upload(p);
        if (u && html.indexOf(p) >= 0) files.push({ path: p, base64: u.b64 });  // only images still used somewhere
      });
      if (!files.length) { clearDraft(); busy = false; return refreshBar(); }
      await api('save', { files: files, message: 'Edit ' + names.join(', ') });
      clearDraft();
      var watch = files.filter(function (f) { return f.content; })[0];
      waitForPublish(watch.path, watch.content, 'Saved. Publishing… this page refreshes by itself when it’s live (about a minute).');
    } catch (e) {
      busy = false;
      refreshBar('Not saved: ' + e.message);
      alert('Not saved. Your edits are still here.\n\n' + e.message);
    }
  }
  function clearDraft() {
    draft = { seq: 0, pages: {}, global: [], data: {}, redo: [] };
    try {
      localStorage.removeItem(DRAFT_KEY);
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('ed-up:') === 0) localStorage.removeItem(k); });
    } catch (e) { /* storage off */ }
  }

  // After a save (or when the server is ahead of the live site), wait until the live file matches, then reload.
  function waitForPublish(path, expected, msg) {
    lock(msg);
    bar.append(tool('Reload', 'Reload now', function () { location.reload(); }));
    var started = Date.now();
    (function poll() {
      fetchServed(path).then(function (live) {
        if (live === expected) return location.reload();
        if (Date.now() - started > 4 * 60e3) status.textContent = 'Still publishing after 4 minutes. Check the deploy, then Reload.';
        setTimeout(poll, 5000);
      }, function () { setTimeout(poll, 5000); });
    })();
  }

  function undo() {
    syncUnits();
    var all = opsFor(PAGE), last = all[all.length - 1];
    if (!last) return;
    var list = listFor(last);
    list.splice(list.indexOf(last), 1);
    draft.redo.push({ op: last, page: PAGE });
    writeDraft();
    location.reload();                                  // replaying what's left is simpler than reversing an op
  }
  function redo() {
    syncUnits();
    var r = draft.redo.pop();
    if (!r) return;
    r.op.seq = ++draft.seq;
    (isGlobal(r.op) ? draft.global : (draft.pages[r.page] = draft.pages[r.page] || [])).push(r.op);
    writeDraft();
    location.reload();
  }
  function discard() {
    syncUnits();
    if (!pending()) return location.reload();
    if (!confirm('Throw away all ' + pending() + ' unsaved edits, on every page?')) return;
    clearDraft();
    location.reload();
  }
  async function signOut() {
    syncUnits();
    await api('logout', {}).catch(function () {});
    location.reload();                                  // unsaved edits stay in this browser for next time
  }

  /* ---------------------------------------------------------------- boot */
  async function boot() {
    var cfg;
    try {
      cfg = await api('config');
    } catch (e) {
      return;                                       // not an editable site, or the API is not reachable
    }
    PAGES = cfg.pages || [];
    DATA_FILES = cfg.dataFiles || {};
    GLOBAL_BLOCKS = cfg.globalBlocks || [];
    UPLOAD_DIR = cfg.uploadDir || 'uploads';
    if (cfg.forceVisible) {                         // elements the site reveals on scroll must stay visible while editing
      document.head.append(h('style', { textContent:
        '.ed-on ' + cfg.forceVisible + '{opacity:1!important;filter:none!important;clip-path:none!important;transform:none!important}' }));
    }
    buildBar();
    buildItemBar();
    document.addEventListener('input', onInput, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('paste', onPaste, true);
    addEventListener('click', onClick, true);
    addEventListener('mousedown', onPointerDown, true);
    addEventListener('submit', function (e) { if (editing) e.preventDefault(); }, true);
    addEventListener('pagehide', syncUnits);

    refreshBar('Loading…');
    var f;
    try {
      f = await api('file?path=' + encodeURIComponent(PAGE));
    } catch (e) {
      if (e.status === 401) {
        document.cookie = 'ed=; Path=/; Max-Age=0; Secure; SameSite=Strict';
        lock('Signed out.' + (pending() ? ' Your ' + pending() + ' unsaved edits are kept for when you sign in.' : ''));
        bar.append(h('a', { className: 'ed-btn ed-btn--gold', href: '/admin?next=' + encodeURIComponent(location.pathname), textContent: 'Sign in' }));
        return;
      }
      return lock(e.status === 400 || e.status === 404 ? 'This page can’t be edited.' : 'Editor unavailable: ' + e.message);
    }
    var live = await fetchServed(PAGE);
    if (live !== f.content) return waitForPublish(PAGE, f.content, 'A newer version of this page is still publishing. It will refresh by itself when live.');
    src = parseHtml(f.content);
    srcSha = f.sha;
    noteKeys(src.body);
    var ops = opsFor(PAGE), lost = ops.filter(function (op) { return !apply(op, src, document) && !isGlobal(op); });
    if (lost.length) {                                  // the page changed underneath the draft
      lost.forEach(function (op) { var l = listFor(op); l.splice(l.indexOf(op), 1); });
      writeDraft();
      alert(lost.length + ' unsaved edit(s) no longer match this page (it was changed elsewhere) and were dropped.');
    }
    setEditing(true);
  }

  /* -------------------------------------------------------------- styles */
  var css = [
    ':root{--ed-ink:#1d1a16;--ed-paper:#fbf6ec;--ed-gold:#c98a2e;--ed-line:rgba(0,0,0,.18)}',
    'body{padding-bottom:64px}',
    '.ed-bar{position:fixed;inset:auto 0 0 0;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 12px;background:var(--ed-ink);color:#f4ead6;font:14px/1.3 system-ui,sans-serif;box-shadow:0 -4px 18px rgba(0,0,0,.25)}',
    '.ed-group{display:flex;gap:6px;align-items:center}.ed-end{margin-left:auto}',
    '.ed-status{flex:1 1 180px;opacity:.85;min-width:0}',
    '.ed-btn{font:inherit;font-size:13px;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);color:inherit;cursor:pointer;text-decoration:none;white-space:nowrap}',
    '.ed-btn:hover:not(:disabled){background:rgba(255,255,255,.18)}.ed-btn:disabled{opacity:.45;cursor:default}',
    '.ed-btn--gold{background:var(--ed-gold);border-color:var(--ed-gold);color:#1d1a16;font-weight:600}',
    '.ed-format .ed-btn:first-child{font-weight:700}.ed-format .ed-btn:nth-child(2){font-style:italic}',
    '.ed-select{font:inherit;font-size:13px;padding:5px;border-radius:6px;max-width:100%;color:var(--ed-ink);background:#fff}',
    '.ed-on [contenteditable]{outline:1px dashed rgba(201,138,46,.55);outline-offset:2px;cursor:text}',
    '.ed-on [contenteditable]:hover{outline:1px solid var(--ed-gold)}',
    '.ed-on [contenteditable]:focus{outline:2px solid var(--ed-gold);background:rgba(255,236,190,.25)}',
    '.ed-on [contenteditable]:empty::before{content:"(empty)";opacity:.5}',
    '.ed-on img[data-e]{cursor:pointer}.ed-on img[data-e]:hover{outline:3px solid var(--ed-gold);outline-offset:-3px}',
    '.ed-on select[id]{cursor:pointer;outline:1px dashed rgba(201,138,46,.8)}',
    '.ed-on .ed-current{box-shadow:0 0 0 2px rgba(201,138,46,.5)}',
    '.ed-region{display:block;margin:8px 0;position:relative;z-index:5}',
    '.ed-item{position:absolute;z-index:2147483001;display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:8px;background:var(--ed-ink);box-shadow:0 2px 10px rgba(0,0,0,.3);font:13px system-ui,sans-serif;color:#f4ead6;max-width:calc(100vw - 8px)}',
    '.ed-item .ed-btn{padding:3px 8px}',
    '.ed-modal{border:0;border-radius:12px;padding:20px;width:min(560px,calc(100vw - 32px));background:var(--ed-paper);color:var(--ed-ink);font:15px/1.45 system-ui,sans-serif}',
    '.ed-modal::backdrop{background:rgba(20,15,10,.55)}.ed-modal h2{font:600 18px system-ui,sans-serif;margin:0 0 12px}',
    '.ed-modal h3{font:600 14px system-ui,sans-serif;margin:14px 0 6px}',
    '.ed-modal li{margin:0 0 8px}',
    '.ed-modal__actions{display:flex;justify-content:flex-end;gap:8px;margin:16px 0 0}',
    '.ed-modal .ed-btn,.ed-drawer .ed-btn{color:var(--ed-ink);border-color:var(--ed-line);background:#fff}',
    '.ed-modal .ed-btn--gold,.ed-drawer .ed-btn--gold{background:var(--ed-gold);border-color:var(--ed-gold)}',
    '.ed-choices{display:grid;gap:6px}',
    '.ed-choice{display:grid;gap:2px;text-align:left;font:14px/1.3 system-ui,sans-serif;padding:8px 10px;border:1px solid var(--ed-line);border-radius:8px;background:#fff;color:var(--ed-ink);cursor:pointer}',
    '.ed-choice:hover{border-color:var(--ed-gold)}.ed-choice small{opacity:.7}',
    '.ed-opt{display:grid;grid-template-columns:1fr 1fr auto auto;gap:4px;margin:0 0 6px}',
    '.ed-opt input,.ed-modal .ed-select{font:14px system-ui,sans-serif;padding:6px 8px;border:1px solid var(--ed-line);border-radius:6px;min-width:0}',
    '.ed-colour{display:flex;gap:8px;align-items:center}.ed-colour input[type=color]{width:48px;height:30px;padding:0;border:1px solid var(--ed-line)}',
    '.ed-preview{display:block;max-width:100%;max-height:260px;margin:0 auto 12px;object-fit:contain;background:#eee}',
    '.ed-field{display:grid;gap:4px;margin:0 0 12px}.ed-field>span{font-weight:600;font-size:13px}.ed-field small{opacity:.7}',
    '.ed-field input:not([type=checkbox]):not([type=color]),.ed-field textarea{font:14px/1.4 system-ui,sans-serif;padding:7px 8px;border:1px solid var(--ed-line);border-radius:6px;width:100%;box-sizing:border-box;background:#fff;color:var(--ed-ink)}',
    '.ed-field--check{grid-template-columns:1fr auto;align-items:center}',
    '.ed-placeholder{background:#fff4d6!important}',
    '.ed-note{font-size:13px;opacity:.75;margin:8px 0 12px}',
    '.ed-drawer{position:fixed;top:0;right:0;bottom:56px;z-index:2147483002;width:min(460px,100vw);display:flex;flex-direction:column;background:var(--ed-paper);color:var(--ed-ink);font:14px/1.4 system-ui,sans-serif;box-shadow:-6px 0 24px rgba(0,0,0,.25)}',
    '.ed-drawer__head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--ed-line)}',
    '.ed-drawer__head h2{font:600 16px system-ui,sans-serif;margin:0}',
    '.ed-drawer__body{overflow:auto;padding:12px 16px 40px}.ed-drawer h3{font:600 14px system-ui,sans-serif;margin:16px 0 8px}',
    '.ed-drawer .ed-select{width:100%;margin-bottom:4px}',
    '.ed-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px}',
    '.ed-thumbs button{padding:0;border:1px solid var(--ed-line);border-radius:6px;overflow:hidden;cursor:pointer;aspect-ratio:1;background:#eee}',
    '.ed-thumbs img{width:100%;height:100%;object-fit:cover;display:block}',
    '.ed-data details{border-left:2px solid var(--ed-line);padding-left:10px;margin:6px 0}',
    '.ed-data summary{cursor:pointer;font-weight:600;padding:4px 0}',
    '.ed-row{position:relative;padding-top:4px}.ed-row__tools{float:right;display:flex;gap:2px}.ed-row__tools .ed-btn{padding:1px 6px;font-size:12px}',
    '@media (max-width:700px){body{padding-bottom:170px}.ed-status{order:9;flex-basis:100%}.ed-end{margin-left:0}.ed-drawer{bottom:0}}'
  ].join('\n');
  document.head.append(h('style', { textContent: css }));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
