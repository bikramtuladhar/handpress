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
  // While editing, each gets an edit button, and when it has one child element per list item,
  // handles on every item (move, duplicate, edit, remove) and “+ Add”.
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
  // The Guide, per page: { 'index.html': [[tip, selector for “Show me”], …] }. Opens by itself the first
  // time each page is edited.
  var GUIDE = HOOKS.guide || {};
  var PAGE = pageFile(location.pathname);
  var DRAFT_KEY = 'ed-draft', CLIP_KEY = 'ed-clip', AI_KEY = 'ed-ai';
  // The AI assistant (OpenRouter or opencode Zen, browser-direct). Per-site extras in
  // window.EDITOR_HOOKS.ai: { context: brand-voice notes, provider: 'openrouter'|'opencode',
  // model: that provider's default model id, actions: [[label, instruction], …] }.
  var AI_HOOKS = HOOKS.ai || {};

  var src = null, srcSha = null;              // this page's source DOM + the sha it came from
  var maxKey = { '': 0, g: 0 };
  var dirtyUnits = new Set();                 // text keys typed into since the last sync
  var data = {};                              // path → { obj, sha, prefix, open, templates }
  var editing = false, busy = false, syncTimer = 0;
  var draft = readDraft();                    // { seq, pages: {page: [op]}, global: [op], data: {path: {obj, sha, prefix, n}},
                                              //   redo: [{op, page} | {data…}], hist: [{file, seq, before, sha, prefix}] (data undo) }

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
    try { var d = JSON.parse(localStorage.getItem(DRAFT_KEY)); if (d && d.pages) { d.redo = d.redo || []; d.hist = d.hist || []; return d; } } catch (e) { /* none or unreadable */ }
    return { seq: 0, pages: {}, global: [], data: {}, redo: [], hist: [] };
  }
  function writeDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
    catch (e) { refreshBar('Too big to keep as a draft (large images?). Save soon, or it is lost on reload.'); }
  }
  // New images wait for Save in IndexedDB (localStorage holds only ~5 MB): path → { path, type, b64 }.
  var ups = {};
  function idb(mode, fn) {
    return new Promise(function (ok, no) {
      var r = indexedDB.open('ed-uploads', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('u'); };
      r.onerror = function () { no(r.error); };
      r.onsuccess = function () {
        var tx = r.result.transaction('u', mode), out = fn(tx.objectStore('u'));
        tx.oncomplete = function () { r.result.close(); ok(out && out.result); };
        tx.onerror = function () { no(tx.error); };
      };
    });
  }
  function loadUploads() {
    return idb('readonly', function (st) { return st.getAll(); })
      .then(function (all) { (all || []).forEach(function (u) { ups[u.path] = u; }); }, function () { /* no IndexedDB */ });
  }
  function upload(path) { return ups[path]; }
  function liveUrl(v) { var u = v && upload(v); return u ? 'data:' + u.type + ';base64,' + u.b64 : v; }
  function fixUploads() {                             // pages drawn from data point at not-yet-uploaded files
    $$('img[src^="' + UPLOAD_DIR + '/"], a[href^="' + UPLOAD_DIR + '/"], audio[src^="' + UPLOAD_DIR + '/"], source[src^="' + UPLOAD_DIR + '/"]').forEach(function (n) {
      var a = n.tagName === 'A' ? 'href' : 'src', v = n.getAttribute(a);
      if (upload(v)) n.setAttribute(a, liveUrl(v));
    });
  }
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
      case 'yt':                                         // a YouTube player written into the page
        [s, l].forEach(function (n) {
          var f = n && videos(n)[op.i];
          if (!f) return;
          if (f.tagName === 'IFRAME') {
            f.setAttribute('src', f.getAttribute('src').replace(/(\/embed\/)[\w-]{11}/, '$1' + op.vid));
            if (op.title) f.setAttribute('title', op.title);
            return;
          }
          f.setAttribute('data-yt-id', op.vid);
          f.setAttribute('data-yt-title', op.title);
          $$('img', f).forEach(function (im) { im.setAttribute('src', 'https://i.ytimg.com/vi/' + op.vid + '/hqdefault.jpg'); });
        });
        break;
      case 'clip':                                       // a track's preview clip (null: no clip, button removed)
        [s, l].forEach(function (n, live) {
          var b = n && players(n)[op.i];
          if (!b) return;
          if (!op.path) return b.remove();
          var t = b.tagName === 'AUDIO' && !b.hasAttribute('src') && $('source', b), v = live ? liveUrl(op.path) : op.path;
          if (t) { t.setAttribute('src', v); t.removeAttribute('type'); }
          else b.setAttribute(b.tagName === 'AUDIO' ? 'src' : 'data-audio', v);
          if (live && b.load) b.load();
        });
        break;
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
        tool('Guide', 'What you can change on this page, and how', openGuide),
        tool('AI', 'Write or improve content with AI (OpenRouter)', openAiDrawer)
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
    undoBtn.disabled = busy || !(opsFor(PAGE).length || draft.hist.length);
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
    // Collapsed sections open while editing (their titles are editable text, so a click can't toggle them).
    $$('details').forEach(function (d) {
      if (d.closest('[data-ed-ui]')) return;
      if (editing && !d.open) { d.open = true; d.edOpened = true; }
      else if (!editing && d.edOpened) { d.open = false; d.edOpened = false; }
    });
    $$('[data-e]').forEach(function (el) { prep(el, editing); });
    $$('.ed-region').forEach(function (n) { n.remove(); });
    if (editing) DATA_REGIONS.forEach(function (r) {
      $$(r[0]).forEach(function (el) {
        el.before(h('button', { type: 'button', className: 'ed-btn ed-btn--gold ed-region', 'data-ed-ui': '',
          textContent: '✎ Edit ' + r[3].toLowerCase() + ' (add, change, remove)', on: { click: function () { openDataPanel(r[1], r[2]); } } }));
      });
    });
    if (!editing && itemBar) itemBar.hidden = true;
    if (editing) decorate();
    else if (Object.keys(data).length) Object.keys(data).forEach(function (p) { previewData(p, data[p].obj); });   // redraw without the handles
    else decorate();
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
    var yt = e.target.closest('[data-yt-id]');
    if (yt && !inRegion(yt)) { e.preventDefault(); e.stopPropagation(); return openVideo(yt); }
    var clip = e.target.closest('[data-audio]');
    if (clip && !inRegion(clip)) { e.preventDefault(); e.stopPropagation(); return openClip(clip); }
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

  /* -------------------------------------------------------------- videos */
  // YouTube players: <iframe src=".../embed/ID"> or a click-to-load <div data-yt-id="ID">.
  function videos(n) { return $$('[data-yt-id], iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"]', n); }
  function players(n) { return $$('[data-audio], audio', n); }
  function inRegion(el) { return DATA_REGIONS.some(function (r) { return el.closest(r[0]); }); }
  function youtubeId(v) {
    var m = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(v) || /^\s*([\w-]{11})\s*$/.exec(v);
    return m && m[1];
  }
  function openVideo(f) {
    var owner = f.closest('[data-e]');
    if (!owner || !srcEl(keyOf(owner))) return alert('This video can’t be changed here.');
    var i = videos(owner).indexOf(f);
    videoDialog(f.getAttribute('data-yt-id'), f.getAttribute('data-yt-title'), function (vid, title) {
      commit({ t: 'yt', id: 'yt:' + keyOf(owner) + ':' + i, k: keyOf(owner), i: i, vid: vid, title: title });
    });
  }

  function videoDialog(id, title, done, remove) {
    var url = h('input', { value: id ? 'https://www.youtube.com/watch?v=' + id : '', placeholder: 'https://www.youtube.com/watch?v=…' });
    var name = h('input', { value: title || '' });
    var d = modal('YouTube video', [
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'YouTube link' }), url,
        h('small', { textContent: 'Paste the address from YouTube (Share → Copy link works too).' })]),
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'Title' }), name]),
      remove && h('p', {}, [tool('Remove this video', 'Take it off the page', function () { d.close(); remove(); })])
    ], function () {
      var vid = youtubeId(url.value);
      if (!vid) throw new Error('That doesn’t look like a YouTube link.');
      return done(vid, name.value.trim());
    });
  }
  /* --------------------------------------------------------- audio clips */
  function openClip(b) {
    var owner = b.closest('[data-e]');
    if (!owner || !srcEl(keyOf(owner))) return alert('This clip can’t be changed here.');
    var i = players(owner).indexOf(b), picked = null;
    var now = b.tagName === 'AUDIO' ? (b.currentSrc || b.getAttribute('src')) : b.getAttribute('data-audio');
    var player = h('audio', { controls: true, src: now || '', className: 'ed-audio' });
    var file = h('input', { type: 'file', accept: 'audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg,.mp3,.m4a,.ogg', on: { change: function () {
      picked = this.files[0];
      if (picked) player.src = URL.createObjectURL(picked);
    } } });
    var d = modal('Audio', [
      player,
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'Replace with a new file (mp3, m4a or ogg)' }), file,
        h('small', { textContent: 'Up to 10 MB. Short clips load quickest.' })]),
      h('p', {}, [tool('Remove the audio', 'Take this player off the page', function () {
        d.close();
        commit({ t: 'clip', id: 'clip:' + keyOf(owner) + ':' + i, k: keyOf(owner), i: i, path: null });
      })])
    ], async function () {
      if (!picked) return;
      commit({ t: 'clip', id: 'clip:' + keyOf(owner) + ':' + i, k: keyOf(owner), i: i, path: await keepAudio(picked) });
    });
  }
  async function keepAudio(file) {
    if (file.size > 10e6) throw new Error('That file is over 10 MB. Trim it to a short clip first.');
    var ext = (/\.(mp3|m4a|ogg)$/i.exec(file.name) || [, { 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }[file.type] || 'm4a'])[1].toLowerCase();
    return keepUpload(UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext, file.type || 'audio/mpeg', file);
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
      tool('AI', 'Rewrite this block with AI, or write a new block after it', function () { openAiFor(current); }),
      tool('✕', 'Remove this (Undo, or + → paste, brings it back)', function () { del(current); })
    ]);
    document.body.append(itemBar);
    document.addEventListener('pointerover', function (e) {
      if (!editing || e.target.closest('[data-ed-ui]')) return;
      // Stay on the block picked with ⤴ or clicked into while the pointer is on it or on what surrounds it
      // (the menu moves when ⤴ is pressed, leaving the pointer over the enclosing section).
      if (held && held.isConnected && (held.contains(e.target) || e.target.contains(held))) return;
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
  function rectOf(el) {                                // display:contents boxes have no rect of their own
    var r = el.getBoundingClientRect();
    if (r.width || !el.children.length) return r;
    var rs = Array.prototype.map.call(el.children, function (c) { return c.getBoundingClientRect(); });
    var top = Math.min.apply(null, rs.map(function (x) { return x.top; })), right = Math.max.apply(null, rs.map(function (x) { return x.right; }));
    return { top: top, right: right, width: right - Math.min.apply(null, rs.map(function (x) { return x.left; })),
      height: Math.max.apply(null, rs.map(function (x) { return x.bottom; })) - top };
  }
  function showItemBar(it) {
    var r = rectOf(it);
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
    var gone = [];                                      // a copy must not repeat ids (anchors, form labels)
    [node].concat($$('[id]', node)).forEach(function (n) {
      if (n.id && src.getElementById(n.id)) { gone.push(n.id); n.removeAttribute('id'); }
    });
    [node].concat($$('[aria-labelledby], [aria-describedby], label[for]', node)).forEach(function (n) {
      ['aria-labelledby', 'aria-describedby', 'for'].forEach(function (a) {
        var v = n.getAttribute(a);
        if (v && v.split(/\s+/).some(function (id) { return gone.indexOf(id) >= 0; })) n.removeAttribute(a);
      });
    });
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
  function slug(name) {
    return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';
  }
  async function keepUpload(path, type, blob) {
    var rec = { path: path, type: type, b64: await fileToBase64(blob) };
    ups[path] = rec;
    await idb('readwrite', function (st) { st.put(rec, path); }).catch(function () {
      refreshBar('This browser can’t keep new files until Save: save before leaving the page.');
    });
    return path;
  }
  // Big photos are scaled to 2000px on the long side before upload; small ones go up as they are.
  async function prepareImage(file) {
    if (file.type === 'image/svg+xml') {            // vector: no bitmap to resize, keep the file as it is
      return { path: await keepUpload(UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.svg', file.type, file), w: 0, h: 0 };
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
    var path = await keepUpload(UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext, type, blob);
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
  function openGuide() {
    var tips = GUIDE[PAGE] || [];
    drawer('Guide · ' + PAGE.replace('.html', ''), [
      h('h3', { textContent: 'On this page' }),
      tips.length ? h('ul', { className: 'ed-guide' }, tips.map(function (t) {
        var target = t[1] && $(t[1]);
        return h('li', {}, [h('span', { textContent: t[0] }), target && tool('Show me', 'Scroll to it', function () { showMe(target); })]);
      })) : h('p', { className: 'ed-note', textContent: 'Nothing special here: see below.' }),
      h('h3', { textContent: 'Everywhere' }),
      h('ul', { className: 'ed-guide' }, [
        'Click any text on the page and type. Shift+Enter makes a line break.',
        'Select words, then B / I / Link / Style in the bar. Style sets colour, size and font. Pasted text arrives plain.',
        'Whole sections have a menu too (hover the space around the text): copy a section, move it, remove it, or paste it on another page.',
        'YouTube videos have a “Change video” button: paste a new link. To add one, ⧉ duplicates the block around a video, then change its link.',
        'Audio players have a “Change audio” button: upload, replace or remove the file.',
        'Hover a card, list entry or section for its menu; click into text for that block’s menu, and ⤴ for the block around it. + adds after it (a new paragraph, heading or button, a copy, or anything you copied or removed), ⧉ duplicates, Copy copies it to paste elsewhere (other pages too), ↑ ↓ move, 🔗 edits its link, ↗ follows the link, 🎨 styles it, ✕ removes it.',
        'Undo / Redo step back and forward through your unsaved edits. Removed something? Undo, or + → paste it back.',
        'Click a drop-down list (e.g. on Contact) to change its choices.',
        'Click a picture to replace it or change its description. “Page” lists every image, including ones you can’t click.',
        'The header, menu and footer are shared: editing them here changes every page.',
        'Lists the site draws from its data file are edited under “Site data”. Buttons on the page take you straight there, and their items have handles to move, edit or remove them.',
        'Edits are kept in this browser until you Save, even in Preview, on other pages, or after a reload. The counter shows how many are waiting. Save publishes all of them; every save is kept in the history.',
        'Use Preview to click around the site normally, then Edit to continue.'
      ].map(function (t) { return h('li', { textContent: t }); })),
      h('p', { className: 'ed-note', textContent: 'This guide opens by itself the first time you edit each page. The Guide button brings it back.' })
    ]);
  }
  function showMe(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('ed-flash'); void el.offsetWidth; el.classList.add('ed-flash');
    setTimeout(function () { el.classList.remove('ed-flash'); }, 2600);
  }
  function guideOnce() {
    try {
      if (localStorage.getItem('ed-guide:' + PAGE)) return;
      localStorage.setItem('ed-guide:' + PAGE, '1');
    } catch (e) { return; }
    openGuide();
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
    return (data[path] = { obj: obj, last: JSON.stringify(obj), sha: kept ? kept.sha : f.sha, prefix: m[1], open: new Set(), templates: templates(JSON.parse(m[2])) });
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

  // pathArg / focus: open this file with this dotted path (e.g. "markets" or "shop.items[2]") expanded.
  async function openDataPanel(pathArg, focus) {
    var pick = h('select', { className: 'ed-select' }, Object.keys(DATA_FILES).map(function (p) {
      return h('option', { value: p, textContent: DATA_FILES[p] });
    }));
    var box = h('div', { className: 'ed-data' });
    drawer('Site data', [pick, h('p', { className: 'ed-note', textContent: 'Changes go public when you Save. “+ Add” at the end of a list adds an entry.' }), box]);
    async function show() {
      box.textContent = 'Loading…';
      try {
        var d = await loadData(pick.value);
        if (typeof focus === 'string') {
          for (var i = 1; i <= focus.length; i++) if (i === focus.length || /[.[]/.test(focus[i])) d.open.add(focus.slice(0, i)); // a, a.b, a.b[2]
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

  var burst = {};
  // typing: keystrokes in a row count as one edit (and one undo step); anything else is its own.
  function markData(file, d, typing) {
    var kept = draft.data[file] = draft.data[file] || { sha: d.sha, prefix: d.prefix, n: 0 };
    kept.obj = d.obj;
    if (!typing || !burst[file]) {
      kept.n++;
      draft.hist.push({ file: file, seq: ++draft.seq, before: d.last, sha: kept.sha, prefix: kept.prefix });
      if (draft.hist.length > 40) draft.hist.shift();
      draft.redo = [];
    }
    d.last = JSON.stringify(d.obj);
    clearTimeout(burst[file]);
    burst[file] = typing ? setTimeout(function () { burst[file] = 0; }, 1500) : 0;
    writeDraft(); refreshBar();
  }
  function render(box, d, file) {
    var pt = 0;
    function changed(typing) {
      markData(file, d, typing);
      clearTimeout(pt);
      pt = setTimeout(function () { previewData(file, d.obj); }, 250);
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
        input = h('input', { type: 'checkbox', checked: v, on: { change: function () { holder[key] = this.checked; changed(true); } } });
      } else if (typeof v === 'number') {
        input = h('input', { type: 'number', step: 'any', value: v, on: { input: function () { holder[key] = this.value === '' ? null : Number(this.value); changed(true); } } });
      } else {
        var s = v == null ? '' : String(v);
        var date = key === 'date' || /^\d{4}-\d\d-\d\d$/.test(s);
        var attrs = { value: s, on: { input: function () {
          var t = this.value;
          holder[key] = v === null ? (t === '' ? null : /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t) : t;
          changed(true);
        } } };
        if (date) attrs.type = 'date'; else if (s.length > 60) attrs.rows = Math.min(8, Math.ceil(s.length / 55) + 1);
        input = h(!date && s.length > 60 ? 'textarea' : 'input', attrs);
        if (/REPLACE/.test(s)) input.classList.add('ed-placeholder');
      }
      parent.append(h('label', { className: 'ed-field' + (typeof v === 'boolean' ? ' ed-field--check' : '') }, [h('span', { textContent: label }), input]));
    }
    Object.keys(d.obj).forEach(function (k) { node(box, d.obj, k, humanize(k), k); });
  }

  // Show unsaved data on the page, if the site gives a way to redraw from it (see README).
  function previewData(path, obj) {
    if (!HOOKS.dataChanged) return;
    HOOKS.dataChanged(path, obj);
    fixUploads();
    decorate();
  }

  /* ---------------------------------------------------------- on-page handles */
  // While editing: “Change video / audio” buttons on players, and handles on lists drawn from a data
  // file (dataRegions). A region gets per-item handles when it has one child element per list item.
  async function editData(file, fn, redraw) {
    var d = await loadData(file);
    fn(d.obj);
    markData(file, d, redraw === false);
    if (redraw !== false) previewData(file, d.obj);
  }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  function nudge(list, i, dir) { var j = i + dir; if (j >= 0 && j < list.length) list.splice(j, 0, list.splice(i, 1)[0]); }
  function ov(tag, attrs, kids) { attrs.className = 'ed-ov ' + (attrs.className || ''); attrs['data-ed-ui'] = ''; return h(tag, attrs, kids); }
  var IMAGE_FIELDS = ['src', 'image', 'img', 'photo', 'picture'];

  function decorate() {
    $$('.ed-ov').forEach(function (n) { n.remove(); });
    $$('.ed-ov-item').forEach(function (n) { n.classList.remove('ed-ov-item'); });
    if (!editing) return;
    videos(document.body).forEach(function (f) {
      if (f.tagName === 'IFRAME' && !inRegion(f)) f.before(ov('p', { className: 'ed-ov-bar' }, [tool('▶ Change video', 'Paste a different YouTube link', function () { openVideo(f); })]));
    });
    $$('audio').forEach(function (a) {
      if (!inRegion(a)) a.before(ov('p', { className: 'ed-ov-bar' }, [tool('♪ Change audio', 'Upload, replace or remove this audio', function () { openClip(a); })]));
    });
    DATA_REGIONS.forEach(function (r) {
      loadData(r[1]).then(function (d) { if (editing) $$(r[0]).forEach(function (el) { regionHandles(el, r, d); }); }, function () {});
    });
  }
  function regionHandles(el, r, d) {
    var file = r[1], path = r[2], list = getPath(d.obj, path);
    if (!Array.isArray(list)) return;
    var items = Array.prototype.filter.call(el.children, function (c) { return !c.hasAttribute('data-ed-ui'); });
    var tpl = d.templates[path.replace(/\[\d+\]/g, '[]')] || {};
    var field = tpl && typeof tpl === 'object' ? IMAGE_FIELDS.filter(function (k) { return k in tpl; })[0] : null;
    var bar = [tool('+ Add', 'Add a new entry at the end', function () {
      editData(file, function (o) { var l = getPath(o, path); l.push(JSON.parse(JSON.stringify(l.length ? blank(l[l.length - 1]) : tpl))); })
        .then(function () { openDataPanel(file, path + '[' + (getPath(d.obj, path).length - 1) + ']'); });
    })];
    if (field) {
      var pick = h('input', { type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/gif,image/svg+xml', hidden: true, on: { change: async function () {
        var files = Array.prototype.slice.call(this.files), added = [];
        try {
          for (var i = 0; i < files.length; i++) {
            refreshBar('Preparing image ' + (i + 1) + ' of ' + files.length + '…');
            var up = await prepareImage(files[i]), item = JSON.parse(JSON.stringify(tpl));
            item[field] = up.path;
            if ('w' in item && up.w) { item.w = up.w; item.h = up.h; }
            added.push(item);
          }
        } catch (e) { alert(e.message); }
        if (added.length) await editData(file, function (o) { Array.prototype.push.apply(getPath(o, path), added); });
        refreshBar(added.length ? 'Added ' + added.length + ' at the end. Use ✎ on each to fill in the rest.' : null);
      } } });
      bar.push(tool('+ Add images', 'Upload one or more images, each becomes a new entry', function () { pick.click(); }), pick);
    }
    el.before(ov('p', { className: 'ed-ov-bar' }, bar));
    if (items.length !== list.length) return;          // can't tell which element is which entry
    items.forEach(function (it, i) {
      it.classList.add('ed-ov-item');
      it.append(ov('span', { className: 'ed-ov-tools' }, [
        tool('↑', 'Move earlier', function () { editData(file, function (o) { nudge(getPath(o, path), i, -1); }); }),
        tool('↓', 'Move later', function () { editData(file, function (o) { nudge(getPath(o, path), i, 1); }); }),
        tool('⧉', 'Duplicate', function () { editData(file, function (o) { var l = getPath(o, path); l.splice(i + 1, 0, JSON.parse(JSON.stringify(l[i]))); }); }),
        tool('✎', 'Edit this entry', function () { openDataPanel(file, path + '[' + i + ']'); }),
        tool('✕', 'Remove', function () { if (confirm('Remove this entry?')) editData(file, function (o) { getPath(o, path).splice(i, 1); }); })
      ]));
    });
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
      Object.keys(ups).forEach(function (p) {
        if (html.indexOf(p) >= 0) files.push({ path: p, base64: ups[p].b64 });  // only images still used somewhere
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
    draft = { seq: 0, pages: {}, global: [], data: {}, redo: [], hist: [] };
    ups = {};
    idb('readwrite', function (st) { st.clear(); }).catch(function () {});
    try {
      localStorage.removeItem(DRAFT_KEY);
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf('ed-up:') === 0) localStorage.removeItem(k); }); // older drafts
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
        if (Date.now() - started > 4 * 60e3) status.textContent = 'Still publishing after 4 minutes. Check that your deploy succeeded, then Reload.';
        setTimeout(poll, 5000);
      }, function () { setTimeout(poll, 5000); });
    })();
  }

  function undo() {
    syncUnits();
    var all = opsFor(PAGE), last = all[all.length - 1], h = draft.hist[draft.hist.length - 1];
    if (h && (!last || h.seq > last.seq)) {             // the latest edit was to Site data: put the file back
      draft.hist.pop();
      var kept = draft.data[h.file];
      draft.redo.push({ data: h, after: JSON.stringify(kept.obj) });
      kept.obj = JSON.parse(h.before);
      if (!--kept.n) delete draft.data[h.file];
      writeDraft();
      return location.reload();
    }
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
    if (r.data) {
      var k = draft.data[r.data.file] = draft.data[r.data.file] || { sha: r.data.sha, prefix: r.data.prefix, n: 0 };
      k.obj = JSON.parse(r.after);
      k.n++;
      r.data.seq = ++draft.seq;
      draft.hist.push(r.data);
      writeDraft();
      return location.reload();
    }
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
    await loadUploads();
    src = parseHtml(f.content);
    srcSha = f.sha;
    noteKeys(src.body);
    var ops = opsFor(PAGE), lost = ops.filter(function (op) { return !apply(op, src, document) && !isGlobal(op); });
    if (lost.length) {                                  // the page changed underneath the draft
      lost.forEach(function (op) { var l = listFor(op); l.splice(l.indexOf(op), 1); });
      writeDraft();
      alert(lost.length + ' unsaved edit(s) no longer match this page (it was changed elsewhere) and were dropped.');
    }
    Object.keys(draft.data).forEach(function (p) { previewData(p, draft.data[p].obj); });
    setEditing(true);
    guideOnce();
  }

  /* ------------------------------------------------------------------- ai */
  // Free AI through OpenRouter or opencode Zen, called straight from the browser. Keys live in
  // localStorage (ed-ai) and go only to the chosen provider. Every result passes through
  // aiSanitize and is committed as an ordinary op, so AI edits undo, draft and save like typed
  // changes.
  var aiCtx = null, aiModelCache = {};         // design-context bundle and per-provider model lists, built once

  // AI providers the editor can talk to. Both are OpenAI-compatible: POST {base}/chat/completions.
  // Each keeps its own key and model, so switching back and forth loses nothing.
  var AI_PROVIDERS = {
    openrouter: {
      label: 'OpenRouter',
      base: 'https://openrouter.ai/api/v1',
      keyHint: 'sk-or-v1-…',
      keyHelp: 'Free key from openrouter.ai/keys. Kept in this browser; sent only to openrouter.ai.',
      defaultModel: 'openrouter/free',
      defaultLabel: 'Auto — routes to a free model',
      headers: function (key) { return { 'Authorization': 'Bearer ' + key, 'HTTP-Referer': location.origin, 'X-Title': 'Handpress' }; },
      models: async function () {
        var d = await (await fetch('https://openrouter.ai/api/v1/models')).json();
        return (d.data || []).filter(function (m) { return m.pricing && (+m.pricing.prompt === 0 || /:free$/.test(m.id)); })
          .filter(function (m) { return !/rerank|embedding|whisper|tts|moderation/i.test(m.id); })
          .sort(function (a, b) { return (/:free$/.test(b.id) ? 1 : 0) - (/:free$/.test(a.id) ? 1 : 0) || String(a.name).localeCompare(String(b.name)); })
          .slice(0, 30)
          .map(function (m) { return [m.id, m.name + (/:free$/.test(m.id) ? ' (free)' : '')]; });
      }
    },
    opencode: {
      label: 'opencode Zen',
      base: 'https://opencode.ai/zen/v1',
      keyHint: 'Zen key from opencode.ai/auth',
      keyHelp: 'Zen key from opencode.ai/auth. Kept in this browser; sent only to opencode.ai.',
      defaultModel: 'nemotron-3-ultra-free',
      defaultLabel: 'nemotron-3-ultra-free (free)',
      headers: function (key) { return { 'Authorization': 'Bearer ' + key }; },
      models: async function () {
        var d = await (await fetch('https://opencode.ai/zen/v1/models')).json();
        return (d.data || []).map(function (m) { return m.id; })
          .filter(zenChatModel)
          .sort(function (a, b) { return (/free$/.test(b) ? 1 : 0) - (/free$/.test(a) ? 1 : 0) || String(a).localeCompare(String(b)); })
          .map(function (id) { return [id, id + (/free$/.test(id) ? ' (free)' : '')]; });
      }
    }
  };
  // Zen serves only some families on /chat/completions; the rest use /messages, /responses or a
  // Google-shaped route this simple client cannot speak, so they are left out of the list.
  function zenChatModel(id) {
    if (/^(claude|gemini|gpt|grok|muse-spark|jev)/.test(id)) return false;
    return !/^qwen3\.[56]/.test(id) && id !== 'qwen3.8-flash';
  }

  function aiSettings() {
    var def = AI_PROVIDERS[AI_HOOKS.provider] ? AI_HOOKS.provider : 'openrouter';
    var d = { provider: def, keys: {}, models: {} };
    if (AI_HOOKS.model) d.models[def] = AI_HOOKS.model;        // the hook's default, until the owner picks one
    try {
      var s = JSON.parse(localStorage.getItem(AI_KEY));
      if (!s || typeof s !== 'object') return d;
      if (!s.provider && (s.key || s.model)) {                 // the earlier single-OpenRouter shape
        d.keys.openrouter = s.key || '';
        d.models.openrouter = s.model || '';
      } else if (AI_PROVIDERS[s.provider]) {
        d.provider = s.provider;
        d.keys = s.keys || {};
        d.models = Object.assign({}, d.models, s.models || {});
      }
    } catch (e) { /* none or unreadable */ }
    return d;
  }
  function writeAiSettings(s) {
    try { localStorage.setItem(AI_KEY, JSON.stringify(s)); } catch (e) { /* private mode: settings last for this session only */ }
  }

  async function aiAsk(system, user, opts) {
    opts = opts || {};
    var s = aiSettings(), p = AI_PROVIDERS[s.provider] || AI_PROVIDERS.openrouter;
    var key = (s.keys || {})[s.provider] || '', model = (s.models || {})[s.provider] || p.defaultModel;
    if (!key) throw new Error('No ' + p.label + ' API key yet. Add one under AI → Settings (' + p.keyHint + ').');
    var body = {
      model: model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: opts.maxTokens || 900,
      temperature: opts.temperature == null ? 0.7 : opts.temperature
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    var r;
    try {
      r = await fetch(p.base + '/chat/completions', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, p.headers(key)),
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('Could not reach ' + p.label + ' (network or blocked). Check the connection and try again.');
    }
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      var m = (d.error && d.error.message) || d.message || 'Error ' + r.status;
      if (r.status === 401) throw new Error(p.label + ' rejected the API key. Copy it again (' + p.keyHint + ').');
      if (r.status === 402) throw new Error('This ' + p.label + ' model needs credits. Pick a free model under AI → Settings.');
      if (r.status === 429) throw new Error('Rate limited on “' + model + '” (' + p.label + '). Wait a moment, or pick another model.');
      throw new Error(p.label + ': ' + m);
    }
    var content = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!content) throw new Error('The model returned nothing. Try again, or pick another model.');
    if (opts.json) {
      var jm = /\{[\s\S]*\}/.exec(String(content));
      if (!jm) throw new Error('Expected JSON from the model. Try again, or pick another model.');
      try { return JSON.parse(jm[0]); } catch (e) { throw new Error('The model’s JSON was not valid. Try again.'); }
    }
    return String(content);
  }

  // The provider's models, with its default pinned first; free ones come first in the rest.
  async function aiModels(pid) {
    if (aiModelCache[pid]) return aiModelCache[pid];
    var p = AI_PROVIDERS[pid];
    var list = await p.models();
    return (aiModelCache[pid] = [[p.defaultModel, p.defaultLabel]]
      .concat(list.filter(function (m) { return m[0] !== p.defaultModel; })));
  }

  // The site's design as the AI sees it: tokens, class vocabulary, section shapes, voice.
  // Built once per page load; capped so free-model context stays cheap.
  function buildDesignContext() {
    if (aiCtx) return aiCtx;
    var cssAll = '';
    Array.prototype.forEach.call(document.styleSheets, function (ss) {
      if (ss.href && ss.href.indexOf(location.origin) !== 0) return;   // same-origin only
      var owner = ss.ownerNode;
      if (owner && owner.closest && owner.closest('[data-ed-ui]')) return;   // skip the editor's own chrome CSS
      try { Array.prototype.forEach.call(ss.cssRules || [], function (r) { cssAll += r.cssText + '\n'; }); }
      catch (e) { /* unreadable sheet */ }
    });
    var tokens = [], root = /:root\s*\{([^}]*)\}/.exec(cssAll);
    if (root) tokens = (root[1].match(/--[a-zA-Z0-9-]+\s*:\s*[^;}]+/g) || []).slice(0, 24);
    var bodyFont = (cssAll.match(/\bbody\s*\{[^}]*\}/) || [''])[0].replace(/\s+/g, ' ').slice(0, 220);
    var used = {};
    $$('[class]').forEach(function (n) {
      String(n.getAttribute('class') || '').split(/\s+/).forEach(function (c) { if (c) used[c] = 1; });
    });
    var classRules = [];
    cssAll.split('\n').forEach(function (line) {
      if (classRules.length >= 40 || !line) return;
      var m = line.match(/\.[a-zA-Z][\w-]*/g);
      if (m && m.some(function (c) { return used[c.slice(1)]; })) classRules.push(line.trim().slice(0, 300));
    });
    var patterns = [];
    if (src) $$('[data-e-list]', src).forEach(function (list) {
      if (patterns.length >= 4) return;
      var first = list.firstElementChild;
      if (first) patterns.push(first.outerHTML.replace(/\sdata-e(?:-list)?="[^"]*"/g, '').slice(0, 500));
    });
    var voice = '';
    try {
      var clone = document.body.cloneNode(true);
      $$('[data-ed-ui], script, style, dialog', clone).forEach(function (n) { n.remove(); });
      voice = (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    } catch (e) { /* nothing to learn from */ }
    aiCtx = [
      'SITE DESIGN CONTEXT — write content that fits this site exactly.',
      'Design tokens (CSS custom properties):\n' + (tokens.join('\n') || '(none found)'),
      'Body typography:\n' + (bodyFont || '(default)'),
      'CSS classes used on this page — reuse these, never invent new ones:\n' + (classRules.join('\n') || '(none found)'),
      'Section patterns already on the page (copy their class usage and hierarchy):\n' + (patterns.join('\n---\n') || '(none found)'),
      BLOCKS.length ? 'Block templates the site offers for new content:\n' + BLOCKS.map(function (b) { return b[0] + ': ' + b[1]; }).join('\n') : '',
      FONTS.length ? 'Fonts offered in the Style menu: ' + FONTS.map(function (f) { return f[0]; }).join(', ') : '',
      GUIDE[PAGE] && GUIDE[PAGE].length ? 'What belongs on this page: ' + GUIDE[PAGE].map(function (t) { return t[0]; }).join(' ') : '',
      AI_HOOKS.context ? 'Brand voice notes from the site author: ' + AI_HOOKS.context : '',
      'Current page copy (match this voice and length):\n' + (voice || '(none)'),
      'RULES\n' + [
        '- Match the voice, tone and length of the existing copy.',
        '- Reuse only the classes listed above; keep the same heading/paragraph hierarchy.',
        '- For new content: mark each editable text element data-e="t0" (list items data-e="i0"); the editor assigns final keys.',
        '- No <script>, <style>, <iframe>, inline event handlers, or javascript: links.',
        '- Return only what was asked: no preamble, no explanations, no markdown fences.'
      ].join('\n')
    ].filter(Boolean).join('\n\n').slice(0, 8000);
    return aiCtx;
  }

  // Model output before it touches the page: dangerous tags/attributes out. Section output
  // keeps its data-e keys — insertAfter's rekey() numbers them fresh; without keys the inserted
  // block would not be editable, so a fallback keys text leaves when the model forgot them.
  var AI_DROP = /^(script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|base|noscript)$/i;
  var AI_INLINE = /^(A|EM|STRONG|B|I|BR|SPAN|CODE|SMALL|SUP|SUB|MARK)$/;
  function aiKeyFallback(root) {
    if (root.querySelector('[data-e]')) return;
    var keyed = [];
    [root].concat($$('*', root)).forEach(function (n) {
      if (/^(SCRIPT|STYLE)$/i.test(n.tagName) || !n.textContent.trim()) return;
      if (keyed.some(function (p) { return p.contains(n); })) return;                         // inside something already keyed
      var kids = Array.prototype.slice.call(n.children);
      if (kids.length && !kids.every(function (c) { return AI_INLINE.test(c.tagName); })) return;   // a container: key its children
      n.setAttribute('data-e', 't0');
      keyed.push(n);
    });
    if (!root.querySelector('[data-e]')) root.setAttribute('data-e', 't0');                   // e.g. an image-only block
  }
  function aiSanitize(html, mode) {
    var wrap = src.createElement('div');
    wrap.innerHTML = String(html == null ? '' : html);
    $$('*', wrap).forEach(function (n) {
      if (AI_DROP.test(n.tagName)) { n.remove(); return; }
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        else if ((a.name === 'href' || a.name === 'src' || a.name === 'action') && !safeUrl(a.value)) n.removeAttribute(a.name);
      });
      if (mode === 'section') n.removeAttribute('data-ed-ui');
    });
    if (mode === 'text') {
      var kids = Array.prototype.slice.call(wrap.children);
      if (kids.length === 1 && /^(P|DIV|H1|H2|H3|H4|H5|H6|SECTION|ARTICLE|BLOCKQUOTE|LI|UL|OL)$/.test(kids[0].tagName)) return kids[0].innerHTML;
      return wrap.innerHTML;
    }
    aiKeyFallback(wrap);
    return wrap.innerHTML.trim();
  }
  // An in-place edit must not add, drop or rename the data-e keys inside a block: drafts and ops
  // point at them, and the annotator numbers them. Guard against a model that restructures.
  function aiSameKeys(el, html) {
    var probe = src.createElement('div');
    probe.innerHTML = html;
    var keys = function (root) { return $$('[data-e]', root).map(keyOf).sort().join(','); };
    return keys(el) === keys(probe);
  }

  // Where the AI drawer inserts new blocks: after the last editable (non-global) block.
  function aiAnchor() {
    if (!src) return null;
    var all = $$('[data-e]', src.body).filter(function (n) { return !/^g/.test(keyOf(n) || ''); });
    return all[all.length - 1] || null;
  }

  function openAiDrawer() {
    var s = aiSettings();
    var pid = AI_PROVIDERS[s.provider] ? s.provider : 'openrouter';
    var p = AI_PROVIDERS[pid];
    var keyIn = h('input', { type: 'password', value: s.keys[pid] || '', placeholder: p.keyHint, autocomplete: 'off', spellcheck: false });
    var provSel = h('select', { className: 'ed-select', 'data-ai': 'provider' }, Object.keys(AI_PROVIDERS).map(function (id) {
      return h('option', { value: id, textContent: AI_PROVIDERS[id].label, selected: id === pid });
    }));
    var modelSel = h('select', { className: 'ed-select', 'data-ai': 'model' });
    var modelCustom = h('input', { placeholder: '…or type any model id' });
    var note = h('p', { className: 'ed-note' });
    var promptIn = h('textarea', { rows: 4, placeholder: 'What should the AI write? e.g. “a short intro paragraph about our sourdough workshop, warm and factual”' });
    var resultBox = h('div', { className: 'ed-ai-preview' });
    var resultHtml = null;
    function currentModel() { return modelCustom.value.trim() || modelSel.value || p.defaultModel; }
    function save() { s.provider = pid; s.keys[pid] = keyIn.value.trim(); s.models[pid] = currentModel(); writeAiSettings(s); }
    provSel.addEventListener('change', function () {
      s.keys[pid] = keyIn.value.trim();                        // keep what was typed before switching
      s.models[pid] = currentModel();
      s.provider = provSel.value;
      writeAiSettings(s);
      openAiDrawer();                                          // redraw for the chosen provider
    });
    keyIn.addEventListener('change', save);
    modelSel.addEventListener('change', function () { modelCustom.value = ''; save(); });
    modelCustom.addEventListener('change', function () {
      var v = modelCustom.value.trim();
      if (!v) return;
      if (!$$('option', modelSel).some(function (o) { return o.value === v; })) modelSel.append(h('option', { value: v, textContent: v }));
      modelSel.value = v;
      save();
    });
    var want = s.models[pid] || p.defaultModel;
    modelSel.append(h('option', { value: want, textContent: want }));
    aiModels(pid).then(function (list) {
      modelSel.textContent = '';
      var has = false;
      list.forEach(function (m) {
        var on = m[0] === want;
        if (on) has = true;
        modelSel.append(h('option', { value: m[0], textContent: m[1], selected: on }));
      });
      if (!has) modelSel.append(h('option', { value: want, textContent: want, selected: true }));
    }).catch(function () {
      note.textContent = 'Could not load the model list (offline, or the provider is blocked). The typed model id below still works.';
    });
    function generate() {
      save();
      var inst = promptIn.value.trim();
      if (!inst) { note.textContent = 'Describe what you want first.'; return; }
      resultHtml = null;
      resultBox.textContent = 'Writing…';
      var anchor = aiAnchor();
      note.textContent = '';
      aiAsk(buildDesignContext(),
        'Write ONE new HTML element (a single top-level element) for this page.\nInstruction: ' + inst +
        '\nReturn JSON only, in the form {"html": "<element …>…</element>"}.\nMark editable text elements data-e="t0" (list items data-e="i0").' +
        (anchor ? '\n\nIt will be inserted after this existing block, so match its shape:\n' + anchor.outerHTML.slice(0, 600) : ''),
        { json: true, maxTokens: 900 })
        .then(function (out) {
          var html = aiSanitize(out && out.html, 'section');
          if (!html) throw new Error('The model returned empty content. Try again.');
          resultHtml = html;
          resultBox.textContent = '';
          resultBox.append(h('strong', { textContent: 'Preview: ' }),
            h('div', { className: 'ed-ai-render', innerHTML: html }),
            h('p', { className: 'ed-note', textContent: 'Apply inserts it after the last editable block on this page. For another spot, hover a block and use its AI button.' }));
        })
        .catch(function (e) { resultBox.textContent = ''; resultBox.append(h('p', { className: 'ed-note', textContent: e.message })); });
    }
    drawer('AI · write with ' + p.label, [
      h('h3', { textContent: 'Settings' }),
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'AI provider' }), provSel,
        h('small', { textContent: 'Both are OpenAI-compatible; each keeps its own key and model.' })]),
      h('label', { className: 'ed-field' }, [h('span', { textContent: p.label + ' API key' }), keyIn, h('small', { textContent: p.keyHelp })]),
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'Model' }), modelSel, modelCustom,
        h('small', { textContent: pid === 'openrouter'
          ? 'openrouter/free picks a free model automatically. Free models have strict rate limits.'
          : 'Models marked (free) cost nothing. Free models rotate, so refresh if one disappears.' })]),
      note,
      h('h3', { textContent: 'Write content' }),
      h('label', { className: 'ed-field' }, [h('span', { textContent: 'What should it write?' }), promptIn]),
      h('p', { className: 'ed-ai-run' }, [tool('Generate', 'Ask the AI to write a new block for this page', generate)]),
      resultBox,
      h('p', { className: 'ed-ai-run' }, [tool('Apply to page', 'Insert the generated block after the last editable block on this page', function () {
        try {
          if (!resultHtml) throw new Error('Generate something first.');
          var anchor = aiAnchor();
          if (!anchor) throw new Error('No editable block on this page to insert after.');
          insertAfter(anchor, resultHtml);
          refreshBar('AI block added — undoable like any other edit.');
        } catch (e) { alert(e.message); }
      })])
    ]);
  }

  // Per-block AI: rewrite the content of an existing block in place, or write a new block below it.
  function openAiFor(it) {
    syncUnits();
    var k = keyOf(it), s = srcEl(k);
    if (!s) return;
    var isText = kindOf(k) === 't';
    var result = null, running = false;
    var note = h('p', { className: 'ed-note', textContent: isText
      ? 'The AI rewrites the words inside this block; its structure and style stay.'
      : 'The AI rewrites the content inside this block, keeping its structure, classes and keys.' });
    var custom = h('input', { placeholder: '…or type your own instruction' });
    var choices = h('div', { className: 'ed-choices' });
    var preview = h('div', { className: 'ed-ai-preview' });
    var list = [
      ['Rewrite', 'Rewrite the content of this block, keeping the same meaning and structure.'],
      ['Improve', 'Improve the content of this block: clearer and more engaging, same structure.'],
      ['Shorter', 'Make the content of this block noticeably shorter, keeping the key point.'],
      ['Longer', 'Expand the content of this block with a little more detail, same tone.']
    ].concat(AI_HOOKS.actions || []);
    function show(mode, html) {
      result = { mode: mode, html: html };
      preview.textContent = '';
      preview.append(h('strong', { textContent: 'Preview: ' }), h('div', { className: 'ed-ai-render', innerHTML: html }));
    }
    function fail(e) {
      result = null;
      preview.textContent = '';
      preview.append(h('p', { className: 'ed-note', textContent: e.message }));
    }
    var busy = function (on) { running = on; if (on) { result = null; preview.textContent = 'Writing…'; } };
    function runEdit(instruction) {                            // change this block, in place
      if (running) return;
      busy(true);
      aiAsk(buildDesignContext(),
        'Rewrite the content INSIDE the HTML element below. Change only the visible words: keep the element and its child elements, the same classes, and every data-e attribute exactly as it appears.\nInstruction: ' + instruction +
        '\nReturn only the new inner HTML (nothing wrapped around the whole element, no markdown fences).\n\nElement:\n' + s.outerHTML,
        { maxTokens: 900 })
        .then(function (out) {
          var html = aiSanitize(out, 'text');
          if (!html || !html.trim()) throw new Error('The model returned empty content. Try again.');
          if (!aiSameKeys(s, html)) throw new Error('That would have changed the block’s structure, so it was left alone. Try again, or use “Write a new block below”.');
          show('edit', html);
        })
        .catch(fail)
        .then(function () { busy(false); });
    }
    function runAfter() {                                      // add a new block after this one
      if (running) return;
      busy(true);
      aiAsk(buildDesignContext(),
        'Write ONE new HTML element (a single top-level element) to insert after the block below on this page.\nInstruction: Write a new block that fits here.' +
        '\nReturn JSON only, in the form {"html": "<element …>…</element>"}.\nMark editable text elements data-e="t0" (list items data-e="i0").\n\nThe block it goes after:\n' + s.outerHTML.slice(0, 800),
        { json: true, maxTokens: 900 })
        .then(function (out) {
          var html = aiSanitize(out && out.html, 'section');
          if (!html) throw new Error('The model returned empty content. Try again.');
          show('after', html);
        })
        .catch(fail)
        .then(function () { busy(false); });
    }
    list.forEach(function (a) {
      choices.append(h('button', { type: 'button', className: 'ed-choice', on: { click: function () { runEdit(a[1]); } } },
        [h('strong', { textContent: a[0] }), h('small', { textContent: a[1] })]));
    });
    modal('AI · ' + (isText ? 'this text' : 'this block'), [
      note,
      h('h3', { textContent: 'Rewrite this block' }),
      choices,
      h('div', { className: 'ed-field' }, [h('span', { textContent: 'Custom instruction' }), custom]),
      h('p', { className: 'ed-ai-run' }, [tool('Rewrite', 'Run the custom instruction on this block', function () {
        if (custom.value.trim()) runEdit(custom.value.trim());
      })]),
      h('h3', { textContent: 'Or write new content' }),
      h('p', { className: 'ed-ai-run' }, [tool('Write a new block below', 'Ask the AI to write a new block to insert after this one', runAfter)]),
      preview
    ], function () {
      if (!result) throw new Error('Nothing generated yet — run an action first.');
      if (result.mode === 'after') insertAfter(it, result.html);
      else commit({ t: 'text', id: 'text:' + k, k: k, html: result.html });
      refreshBar('AI edit applied — undoable like any other edit.');
    });
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
    '.ed-on .ed-current,.ed-on .ed-current[style*=contents]>*,.ed-on .dl-grid>.ed-current>*{box-shadow:0 0 0 2px rgba(201,138,46,.5)}',
    '.ed-region{display:block;margin:8px 0;position:relative;z-index:5}',
    '.ed-ov-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0;font:13px/1.4 system-ui,sans-serif;color:var(--ed-ink)}',
    '.ed-ov-bar .ed-btn,.ed-ov-tools .ed-btn,.ed-ov-row .ed-btn{color:#f4ead6;background:var(--ed-ink);border-color:var(--ed-ink)}',
    '.ed-ov-bar span{background:#fff4d6;padding:4px 8px;border-radius:6px}',
    '.ed-on .ed-ov-item{position:relative}',
    '.ed-ov-tools{position:absolute;top:6px;right:6px;display:flex;gap:2px;z-index:6;opacity:.85}.ed-ov-tools:hover{opacity:1}', // no hover on touch screens
    '.ed-ov-tools .ed-btn,.ed-ov-row .ed-btn{padding:2px 7px}',
    '.ed-ov-row{white-space:nowrap}',
    '.ed-audio{display:block;width:100%;margin:0 0 12px}',
    '.ed-guide{padding-left:18px;margin:0 0 8px}.ed-guide li{margin:0 0 10px}.ed-guide li .ed-btn{margin-left:6px;padding:2px 8px;font-size:12px}',
    '@keyframes ed-flash{0%,100%{box-shadow:0 0 0 0 rgba(201,138,46,0)}20%,60%{box-shadow:0 0 0 6px rgba(201,138,46,.9)}}',
    '.ed-flash{animation:ed-flash 1.3s ease-in-out 2;border-radius:6px}',
    '.ed-on [data-audio],.ed-on [data-yt-id]{outline:2px dashed rgba(201,138,46,.8);outline-offset:2px;cursor:pointer}',
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
    '.ed-ai-run{display:flex;gap:6px;align-items:center;margin:0 0 8px}',
    '.ed-ai-preview{margin-top:10px}',
    '.ed-ai-render{border:1px solid var(--ed-line);border-radius:8px;padding:10px;background:#fff;margin:6px 0;max-height:240px;overflow:auto}',
    '@media (max-width:700px){body{padding-bottom:170px}.ed-status{order:9;flex-basis:100%}.ed-end{margin-left:0}.ed-drawer{bottom:0}}'
  ].join('\n');
  document.head.append(h('style', { 'data-ed-ui': '', textContent: css }));

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
