/* ==========================================================================
   Edit-in-place for static sites: the browser half.

   Load it only for signed-in editors (see README — one line in your own JS,
   guarded by the "ed" cookie). Visitors never download it.

   How it works: it fetches the page's SOURCE through /api/file and keeps it as
   a second, script-free DOM. Every edit is applied to the live page (so the
   editor sees it) and to that source DOM (so what gets saved is clean HTML, not
   whatever the site's own JavaScript did to the page at runtime). Elements are
   matched by the data-e keys that annotate.mjs adds.

   Save = one commit through /api/save.

   Per-site quirks go in window.EDITOR_HOOKS (see README), not in here.
   ========================================================================== */
(function () {
  'use strict';

  var PAGES = [];          // from /api/config
  var DATA_FILES = {};     // from /api/config: { 'path/to/data.js': 'label shown in the panel' }
  var GLOBAL_BLOCKS = [];  // selectors of blocks shared by every page (header, footer, …)
  var UPLOAD_DIR = 'uploads';
  var HOOKS = window.EDITOR_HOOKS || {};
  var PAGE = pageFile(location.pathname);

  var src = null, srcSha = null;              // this page's source DOM + the GitHub blob sha it came from
  var maxKey = { '': 0, g: 0 };
  var dirtyUnits = new Set();                 // text keys typed into since the last sync
  var pageDirty = false, globalDirty = false;
  var data = {};                              // path → { obj, sha, prefix, dirty, templates }
  var uploads = {};                           // repo path → base64 (new images)
  var changes = 0, editing = false, busy = false;

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
  function srcEl(k) { return src && src.querySelector('[data-e="' + k + '"]'); }
  function liveEl(k) { return document.querySelector('[data-e="' + k + '"]'); }
  function parseHtml(text) { return new DOMParser().parseFromString(text, 'text/html'); }
  function serialize(d) { return '<!DOCTYPE html>' + d.documentElement.outerHTML; } // same output as scripts/annotate.mjs

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

  /* ------------------------------------------------------------------ bar */
  var bar, status, saveBtn, editBtn;
  function tool(label, title, fn, keepFocus) {
    return h('button', { type: 'button', className: 'ed-btn', title: title, textContent: label, on: {
      mousedown: function (e) { if (keepFocus) e.preventDefault(); }, // keep the text selection for B / I / Link
      click: fn
    } });
  }
  function buildBar() {
    status = h('span', { className: 'ed-status', role: 'status' });
    saveBtn = tool('Save', 'Save all changes and publish', save);
    saveBtn.classList.add('ed-btn--gold');
    editBtn = tool('Preview', 'Switch between editing and using the site normally', function () { setEditing(!editing); });
    var pagePick = h('select', { className: 'ed-select', title: 'Go to page', on: { change: function () { location.href = servedUrl(this.value); } } },
      PAGES.map(function (p) { return h('option', { value: p, textContent: p.replace('.html', ''), selected: p === PAGE }); }));
    bar = h('div', { className: 'ed-bar', 'data-ed-ui': '' }, [
      h('span', { className: 'ed-group' }, [h('strong', { textContent: 'Editor' }), pagePick]),
      h('span', { className: 'ed-group ed-format' }, [
        tool('B', 'Bold (select text first)', function () { document.execCommand('bold'); }, true),
        tool('I', 'Italic (select text first)', function () { document.execCommand('italic'); }, true),
        tool('Link', 'Add, change or remove a link', editLink, true)
      ]),
      h('span', { className: 'ed-group' }, [
        tool('Page', 'Page title, description and all images on this page', openPagePanel),
        tool('Site data', 'Lists and settings the site renders from its data file', openDataPanel),
        tool('Help', 'How editing works', openHelp)
      ]),
      status,
      h('span', { className: 'ed-group ed-end' }, [
        editBtn,
        tool('Discard', 'Throw away unsaved changes', discard),
        saveBtn,
        tool('Sign out', 'Sign out of the editor', signOut)
      ])
    ]);
    document.body.append(bar);
    refreshBar();
  }
  function refreshBar(msg) {
    if (msg != null) status.textContent = msg;
    else status.textContent = changes ? 'Unsaved changes' : (editing ? 'Click any text to edit it' : 'Preview: the site works as normal');
    saveBtn.disabled = busy || !changes;
    editBtn.textContent = editing ? 'Preview' : 'Edit';
  }
  function lock(msg) {
    setEditing(false);
    $$('.ed-btn, .ed-select', bar).forEach(function (b) { if (!/Sign out|Reload/.test(b.textContent)) b.disabled = true; });
    refreshBar(msg);
  }

  /* ------------------------------------------------------------- editing */
  function setEditing(on) {
    editing = on && !!src;
    document.documentElement.classList.toggle('ed-on', editing);
    $$('[data-e]').forEach(function (el) { prep(el, editing); });
    if (!editing) itemBar.hidden = true;
    refreshBar();
  }
  // Text blocks get their source HTML back (undoing whatever site.js did to them) and become editable.
  function prep(el, on) {
    var k = keyOf(el);
    if (kindOf(k) !== 't') return;
    var s = srcEl(k);
    if (!s) return;
    if (on) {
      if (HOOKS.beforeEdit) el = HOOKS.beforeEdit(el) || el;   // e.g. detach an element the site animates
      if (!el.edReady && !dirtyUnits.has(k)) { el.innerHTML = s.innerHTML; el.edReady = true; }
      el.setAttribute('contenteditable', 'true');
      el.spellcheck = true;
    } else {
      el.removeAttribute('contenteditable');
    }
  }
  function prepTree(root) { [root].concat($$('[data-e]', root)).forEach(function (el) { if (el.hasAttribute('data-e')) prep(el, editing); }); }

  function touch(k) {
    changes++;
    if (k.charAt(0) === 'g') globalDirty = true; else pageDirty = true;
    refreshBar();
  }

  // Copy typed text back into the source DOM, tidying what contenteditable leaves behind.
  function syncUnits() {
    dirtyUnits.forEach(function (k) {
      var live = liveEl(k), s = srcEl(k);
      if (!live || !s) return;
      var t = live.cloneNode(true);
      $$('[style]', t).forEach(function (n) { n.removeAttribute('style'); });
      $$('[contenteditable]', t).forEach(function (n) { n.removeAttribute('contenteditable'); });
      $$('font, span:not([class]):not([id]):not([data-e]):not([lang])', t).forEach(function (n) { n.replaceWith.apply(n, n.childNodes); });
      $$('.new-tab', t).forEach(function (n) { n.remove(); });
      s.innerHTML = t.innerHTML;
      if (live.tagName === 'A') s.setAttribute('href', live.getAttribute('href') || '#');
      if (HOOKS.syncUnit) HOOKS.syncUnit(s, live);     // per-site fix-ups (see README)
    });
    dirtyUnits.clear();
  }

  function onInput(e) {
    var u = e.target.closest && e.target.closest('[contenteditable][data-e]');
    if (!u) return;
    var k = keyOf(u);
    if (!dirtyUnits.has(k)) { dirtyUnits.add(k); touch(k); }
  }
  function onKey(e) {
    if (!editing || !e.target.closest || !e.target.closest('[contenteditable]')) return;
    if (e.key === 'Enter' && !e.shiftKey) {             // new blocks come from the list "duplicate" button
      e.preventDefault();
      refreshBar('Tip: Shift+Enter for a line break. To add a paragraph or item, use ⧉ on the one above.');
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
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

  function editLink() {
    var sel = getSelection();
    var node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    var unit = node && node.closest('[contenteditable][data-e]');
    if (!unit) return alert('Click into some text first (select words to turn them into a link).');
    var a = node.closest('a');
    if (a && a.hasAttribute('data-config-href')) {
      return alert('This link is set in Site data → Site settings → ' + a.getAttribute('data-config-href').replace(/\./g, ' → ') + '.');
    }
    if (a) {
      var url = prompt('Link address (leave empty to remove the link):', a.getAttribute('href'));
      if (url === null) return;
      if (/^\s*javascript:/i.test(url)) return;
      if (url.trim()) a.setAttribute('href', url.trim());
      else if (a === unit) return alert('This whole block is a link (a button). Change its address instead of removing it.');
      else a.replaceWith.apply(a, a.childNodes);
    } else {
      if (sel.isCollapsed) return alert('Select the words to turn into a link first.');
      var u = prompt('Link address (e.g. https://…, /about, mailto:hello@example.com):', 'https://');
      if (!u || u === 'https://' || /^\s*javascript:/i.test(u)) return;
      document.execCommand('createLink', false, u.trim());
    }
    var k = keyOf(unit);
    if (!dirtyUnits.has(k)) { dirtyUnits.add(k); touch(k); }
  }

  /* -------------------------------------------------------------- lists */
  var itemBar, current;
  function buildItemBar() {
    itemBar = h('div', { className: 'ed-item', 'data-ed-ui': '', hidden: true }, [
      tool('⧉', 'Duplicate this item', function () { dup(current); }),
      tool('↑', 'Move up', function () { move(current, -1); }),
      tool('↓', 'Move down', function () { move(current, 1); }),
      tool('✕', 'Delete this item', function () { del(current); })
    ]);
    document.body.append(itemBar);
    document.addEventListener('pointerover', function (e) {
      if (!editing || e.target.closest('[data-ed-ui]')) return;
      var it = e.target.closest('[data-e-list] > [data-e]');
      if (it && it !== current && srcEl(keyOf(it))) showItemBar(it);
    }, true);
    addEventListener('scroll', function () { if (current && !itemBar.hidden) showItemBar(current); }, { passive: true });
  }
  function showItemBar(it) {
    var r = it.getBoundingClientRect();
    if (!r.width || !r.height) return;
    current = it;
    itemBar.hidden = false;
    itemBar.style.top = (r.top + scrollY + 2) + 'px';
    itemBar.style.left = Math.max(4, r.right + scrollX - itemBar.offsetWidth - 2) + 'px';
    $$('[data-e-list] > .ed-current').forEach(function (n) { n.classList.remove('ed-current'); });
    it.classList.add('ed-current');
  }
  function siblings(it) { return Array.prototype.filter.call(it.parentElement.children, function (n) { return n.hasAttribute('data-e'); }); }
  function rekey(root) {
    [root].concat($$('[data-e]', root)).forEach(function (n) {
      var k = n.getAttribute('data-e');
      if (!k) return;
      var g = k.charAt(0) === 'g' ? 'g' : '';
      n.setAttribute('data-e', g + kindOf(k) + (++maxKey[g]));
    });
  }
  function dup(it) {
    syncUnits();
    var s = srcEl(keyOf(it));
    var copy = s.cloneNode(true);
    rekey(copy);
    s.after(copy);
    var live = document.importNode(copy, true);    // from source: clean markup, new keys
    it.after(live);
    prepTree(live);
    touch(keyOf(it));
    showItemBar(live);
  }
  function move(it, dir) {
    var sib = siblings(it)[siblings(it).indexOf(it) + dir];
    if (!sib) return;
    var s = srcEl(keyOf(it)), ss = srcEl(keyOf(sib));
    if (dir < 0) { sib.before(it); ss.before(s); } else { sib.after(it); ss.after(s); }
    touch(keyOf(it));
    showItemBar(it);
  }
  function del(it) {
    if (siblings(it).length < 2) return alert('This is the last item, so it stays (new items are copies of an existing one). Edit its text instead.');
    if (!confirm('Delete this item?')) return;
    syncUnits();
    srcEl(keyOf(it)).remove();
    it.remove();
    itemBar.hidden = true;
    current = null;
    touch(keyOf(it));
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
    return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  }
  // Big photos are scaled to 2000px on the long side before upload; small ones go up as they are.
  async function prepareImage(file) {
    if (file.type === 'image/svg+xml') {            // vector: no bitmap to resize, keep the file as it is
      var svgPath = UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.svg';
      uploads[svgPath] = await fileToBase64(file);
      return { path: svgPath, url: URL.createObjectURL(file), w: 0, h: 0 };
    }
    var bmp = await createImageBitmap(file);
    var scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    var w = Math.round(bmp.width * scale), hgt = Math.round(bmp.height * scale);
    var ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type] || 'jpg';
    var blob = file;
    if (file.type !== 'image/gif' && (scale < 1 || file.size > 700e3)) {
      var c = h('canvas', { width: w, height: hgt });
      c.getContext('2d').drawImage(bmp, 0, 0, w, hgt);
      var type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg'; // webp keeps transparency
      ext = type === 'image/webp' ? 'webp' : 'jpg';
      blob = await new Promise(function (ok) { c.toBlob(ok, type, 0.85); });
    }
    var path = UPLOAD_DIR + '/' + slug(file.name) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext;
    uploads[path] = await fileToBase64(blob);
    return { path: path, url: URL.createObjectURL(blob), w: w, h: hgt };
  }
  function openImage(img) {
    var k = keyOf(img), s = srcEl(k);
    if (!s) return;
    var picked = null;
    var preview = h('img', { src: img.currentSrc || img.src, className: 'ed-preview', alt: '' });
    var file = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', on: { change: function () {
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
        var old = s.getAttribute('src');
        var scope = s.closest('section, header, footer, main, figure') || src.body;
        $$('img', scope).forEach(function (si) {
          if (si.getAttribute('src') !== old) return;
          var li = liveEl(si.getAttribute('data-e'));
          [si, li].forEach(function (n, i) {
            if (!n) return;
            n.setAttribute('src', i ? up.url : up.path);
            n.removeAttribute('srcset');
            if (up.w && n.hasAttribute('width')) { n.setAttribute('width', up.w); n.setAttribute('height', up.h); }
          });
        });
        $$('a', scope).forEach(function (sa) {
          if (sa.getAttribute('href') !== old) return;
          sa.setAttribute('href', up.path);
          if (sa.hasAttribute('data-label')) sa.setAttribute('data-label', up.path.split('/').pop());
          var la = img.closest('a[href]');                // the live lightbox link around this image
          if (la && la.getAttribute('href') === old) la.setAttribute('href', up.url);
        });
      }
      if ((s.getAttribute('alt') || '') !== alt.value.trim()) { s.setAttribute('alt', alt.value.trim()); img.alt = alt.value.trim(); }
      touch(k);
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
        'Select words, then B / I / Link in the bar. Pasted text arrives plain.',
        'Hover a paragraph, card, list entry or button: ⧉ duplicates it, ↑ ↓ move it, ✕ deletes it. To add something new, duplicate the one above and change it.',
        'Click a picture to replace it or change its description. “Page” lists every image, including ones you can’t click.',
        'The header, menu and footer are shared: editing them here changes every page.',
        'Lists, dates and links that the site draws from a data file are edited under “Site data”.',
        'Nothing is public until you press Save. Every save is kept in the history, so any change can be undone.',
        'Use Preview to click around the site normally, then Edit to continue.'
      ].map(function (t) { return h('li', { textContent: t }); }))
    ]);
  }

  function openPagePanel() {
    if (!src) return;
    function meta(sel) { return src.querySelector(sel); }
    function field(label, value, hint, set) {
      var input = h(value.length > 70 ? 'textarea' : 'input', { value: value, rows: 3, on: { input: function () { set(this.value); changes++; pageDirty = true; refreshBar(); } } });
      return h('label', { className: 'ed-field' }, [h('span', { textContent: label }), input, hint && h('small', { textContent: hint })]);
    }
    function setMeta(sels, v) { sels.forEach(function (s) { var m = meta(s); if (m) m.setAttribute('content', v); }); }
    var title = meta('title'), desc = meta('meta[name=description]'), ogt = meta('meta[property="og:title"]'), ogd = meta('meta[property="og:description"]');
    var imgs = $$('img[data-e]').filter(function (i) { return srcEl(keyOf(i)); });
    drawer('This page · ' + PAGE, [
      title && field('Page title (browser tab and Google)', title.textContent, null, function (v) { title.textContent = v; document.title = v; }),
      desc && field('Description (Google results)', desc.getAttribute('content'), 'About 150 characters.', function (v) { desc.setAttribute('content', v); }),
      ogt && field('Title when shared (WhatsApp, Facebook…)', ogt.getAttribute('content'), null, function (v) { setMeta(['meta[property="og:title"]', 'meta[name="twitter:title"]'], v); }),
      ogd && field('Description when shared', ogd.getAttribute('content'), null, function (v) { setMeta(['meta[property="og:description"]', 'meta[name="twitter:description"]'], v); }),
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
    var obj = JSON.parse(m[2]);
    return (data[path] = { obj: obj, sha: f.sha, prefix: m[1], dirty: false, open: new Set(), templates: templates(obj) });
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

  async function openDataPanel(pathArg) {
    var pick = h('select', { className: 'ed-select' }, Object.keys(DATA_FILES).map(function (p) {
      return h('option', { value: p, textContent: DATA_FILES[p] });
    }));
    var box = h('div', { className: 'ed-data' });
    drawer('Site data', [pick, h('p', { className: 'ed-note', textContent: 'Changes here show on the site after Save (the page reloads once published).' }), box]);
    async function show() {
      box.textContent = 'Loading…';
      try {
        var d = await loadData(pick.value);
        box.textContent = '';
        render(box, d);
      } catch (e) { box.textContent = e.message; }
    }
    pick.addEventListener('change', show);
    if (typeof pathArg === 'string') pick.value = pathArg;
    show();
  }

  function render(box, d) {
    function changed() { if (!d.dirty) d.dirty = true; changes++; refreshBar(); }
    function rerender() { var y = box.parentElement.scrollTop; box.textContent = ''; render(box, d); box.parentElement.scrollTop = y; }
    function node(parent, holder, key, label, path) {
      var v = holder[key];
      if (v && typeof v === 'object') {
        var det = h('details', { open: d.open.has(path), on: { toggle: function () { if (det.open) d.open.add(path); else d.open.delete(path); } } });
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
        input = h(s.length > 60 ? 'textarea' : 'input', { value: s, rows: Math.min(8, Math.ceil(s.length / 55) + 1), on: { input: function () {
          var t = this.value;
          holder[key] = v === null ? (t === '' ? null : /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t) : t;
          changed();
        } } });
        if (/REPLACE/.test(s)) input.classList.add('ed-placeholder');
      }
      parent.append(h('label', { className: 'ed-field' + (typeof v === 'boolean' ? ' ed-field--check' : '') }, [h('span', { textContent: label }), input]));
    }
    Object.keys(d.obj).forEach(function (k) { node(box, d.obj, k, humanize(k), k); });
  }

  /* ---------------------------------------------------------------- save */
  function copyGlobals(from, to, page) {
    GLOBAL_BLOCKS.forEach(function (sel) {
      var a = from.querySelector(sel), b = to.querySelector(sel);
      if (a && b) b.replaceWith(to.importNode(a, true));
    });
    $$('header nav a, #mobile-menu nav a', to).forEach(function (a) {
      if (pageOfHref(a.getAttribute('href')) === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  async function save() {
    if (busy || !changes) return;
    busy = true;
    refreshBar('Saving…');
    try {
      syncUnits();
      var files = [], names = [];
      if (pageDirty || globalDirty) { files.push({ path: PAGE, sha: srcSha, content: serialize(src) }); names.push(PAGE); }
      if (globalDirty) {
        refreshBar('Saving… updating header and footer on every page');
        for (var i = 0; i < PAGES.length; i++) {
          if (PAGES[i] === PAGE) continue;
          var f = await api('file?path=' + PAGES[i]);
          var d = parseHtml(f.content);
          copyGlobals(src, d, PAGES[i]);
          var out = serialize(d);
          if (out !== f.content) files.push({ path: PAGES[i], sha: f.sha, content: out });
        }
        names.push('header/footer on all pages');
      }
      Object.keys(data).forEach(function (p) {
        if (!data[p].dirty) return;
        files.push({ path: p, sha: data[p].sha, content: data[p].prefix + JSON.stringify(data[p].obj, null, 2) + ';\n' });
        names.push(DATA_FILES[p] || p);
      });
      Object.keys(uploads).forEach(function (p) {
        // only images still used somewhere (a replaced-then-replaced-again picture is dropped)
        if (src.querySelector('[src="' + p + '"]')) files.push({ path: p, base64: uploads[p] });
      });
      if (!files.length) { changes = 0; busy = false; return refreshBar(); }
      await api('save', { files: files, message: 'Edit ' + names.join(', ') });
      changes = 0;
      var watch = files.filter(function (f) { return f.content; })[0];
      waitForPublish(watch.path, watch.content, 'Saved. Publishing… this page refreshes by itself when it’s live (about a minute).');
    } catch (e) {
      busy = false;
      refreshBar('Not saved: ' + e.message);
      alert('Not saved.\n\n' + e.message);
    }
  }

  // After a save (or when GitHub is ahead of the live site), wait until the live file matches, then reload.
  function waitForPublish(path, expected, msg) {
    lock(msg);
    bar.append(tool('Reload', 'Reload now', function () { location.reload(); }));
    var started = Date.now();
    (function poll() {
      fetchServed(path).then(function (live) {
        if (live === expected) { changes = 0; return location.reload(); }
        if (Date.now() - started > 4 * 60e3) refreshBar('Still publishing after 4 minutes. Check that your deploy succeeded, then Reload.');
        setTimeout(poll, 5000);
      }, function () { setTimeout(poll, 5000); });
    })();
  }

  function discard() {
    if (changes && !confirm('Throw away all unsaved changes?')) return;
    changes = 0;
    location.reload();
  }
  async function signOut() {
    if (changes && !confirm('You have unsaved changes. Sign out anyway?')) return;
    changes = 0;
    await api('logout', {}).catch(function () {});
    location.reload();
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
    addEventListener('submit', function (e) { if (editing) e.preventDefault(); }, true);
    addEventListener('beforeunload', function (e) { if (changes) { e.preventDefault(); e.returnValue = ''; } });

    refreshBar('Loading…');
    var f;
    try {
      f = await api('file?path=' + encodeURIComponent(PAGE));
    } catch (e) {
      if (e.status === 401) {
        document.cookie = 'ed=; Path=/; Max-Age=0; Secure; SameSite=Strict';
        lock('Signed out.');
        bar.append(h('a', { className: 'ed-btn ed-btn--gold', href: '/admin?next=' + encodeURIComponent(location.pathname), textContent: 'Sign in' }));
        return;
      }
      return lock(e.status === 400 || e.status === 404 ? 'This page can’t be edited.' : 'Editor unavailable: ' + e.message);
    }
    var live = await fetchServed(PAGE);
    if (live !== f.content) return waitForPublish(PAGE, f.content, 'A newer version of this page is still publishing. It will refresh by itself when live.');
    src = parseHtml(f.content);
    srcSha = f.sha;
    $$('[data-e]', src).forEach(function (n) {
      var m = /^(g?)[tmi](\d+)$/.exec(n.getAttribute('data-e'));
      if (m) maxKey[m[1]] = Math.max(maxKey[m[1]], +m[2]);
    });
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
    '.ed-on .ed-current{box-shadow:0 0 0 2px rgba(201,138,46,.5)}',
    '.ed-item{position:absolute;z-index:2147483001;display:flex;gap:2px;padding:3px;border-radius:8px;background:var(--ed-ink);box-shadow:0 2px 10px rgba(0,0,0,.3);font:13px system-ui,sans-serif;color:#f4ead6}',
    '.ed-item .ed-btn{padding:3px 8px}',
    '.ed-modal{border:0;border-radius:12px;padding:20px;width:min(560px,calc(100vw - 32px));background:var(--ed-paper);color:var(--ed-ink);font:15px/1.45 system-ui,sans-serif}',
    '.ed-modal::backdrop{background:rgba(20,15,10,.55)}.ed-modal h2{font:600 18px system-ui,sans-serif;margin:0 0 12px}',
    '.ed-modal li{margin:0 0 8px}',
    '.ed-modal__actions{display:flex;justify-content:flex-end;gap:8px;margin:16px 0 0}',
    '.ed-modal .ed-btn,.ed-drawer .ed-btn{color:var(--ed-ink);border-color:var(--ed-line);background:#fff}',
    '.ed-modal .ed-btn--gold,.ed-drawer .ed-btn--gold{background:var(--ed-gold);border-color:var(--ed-gold)}',
    '.ed-preview{display:block;max-width:100%;max-height:260px;margin:0 auto 12px;object-fit:contain;background:#eee}',
    '.ed-field{display:grid;gap:4px;margin:0 0 12px}.ed-field span{font-weight:600;font-size:13px}.ed-field small{opacity:.7}',
    '.ed-field input:not([type=checkbox]),.ed-field textarea{font:14px/1.4 system-ui,sans-serif;padding:7px 8px;border:1px solid var(--ed-line);border-radius:6px;width:100%;box-sizing:border-box;background:#fff;color:var(--ed-ink)}',
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
