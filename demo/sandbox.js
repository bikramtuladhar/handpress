/**
 * Handpress demo sandbox.
 *
 * The editor talks to /api/* and expects a server that commits to git. Here there is no
 * server: this file answers those calls from the visitor's own browser and keeps "saved"
 * files in localStorage. Everything else — the editor, the keys, the save flow — is exactly
 * what a real site runs.
 *
 * Nothing leaves the browser, every visitor gets their own copy, and Reset restores the site.
 */
(function () {
  var KEY = 'handpress-demo-v1';
  var store, uploads;
  try {
    var saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    store = saved.files || {};
    uploads = saved.uploads || {};
  } catch (e) { store = {}; uploads = {}; }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify({ files: store, uploads: uploads })); }
    catch (e) { alert('This demo keeps your edits in the browser, and it has run out of room. Press Reset to start again.'); }
  }

  var CONFIG = {
    pages: ['index.html', 'about.html'],
    dataFiles: { 'data.js': 'Opening times and markets' },
    globalBlocks: ['header', 'footer'],
    uploadDir: 'uploads',
    forceVisible: ''
  };

  function pageOf(pathname) {
    var p = pathname.replace(/^\//, '').split('?')[0];
    if (p === '' ) return 'index.html';
    return /\.[a-z0-9]+$/i.test(p) ? p : p + '.html';
  }
  function hash(s) {                         // any value that changes with the content will do
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return 'demo' + h;
  }
  function json(data) { return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }); }

  var realFetch = window.fetch.bind(window);
  async function original(path) {            // the file as it was shipped
    return realFetch('/' + path + '?pristine=1').then(function (r) { return r.text(); });
  }

  window.fetch = async function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var u = new URL(url, location.href);
    if (u.origin !== location.origin) return realFetch(input, init);
    var p = u.pathname;

    if (p === '/api/config') return json(Object.assign({ clientId: 'demo' }, CONFIG));
    if (p === '/api/me') return json({ email: 'demo@handpress' });
    if (p === '/api/logout') { localStorage.removeItem(KEY); return json({ ok: true }); }

    if (p === '/api/file') {
      var f = u.searchParams.get('path');
      var content = store[f] !== undefined ? store[f] : await original(f);
      return json({ path: f, sha: hash(content), content: content });
    }

    if (p === '/api/save') {
      var body = JSON.parse(init.body);
      body.files.forEach(function (f) {
        if (f.base64) uploads[f.path] = 'data:image/jpeg;base64,' + f.base64;
        else store[f.path] = f.content;
      });
      persist();
      return json({ ok: true, commit: 'demo' });
    }

    // The editor compares the live page with what it saved; serve our copy so they match.
    var key = pageOf(p);
    if (store[key] !== undefined && !u.searchParams.has('pristine')) {
      return new Response(store[key], { headers: { 'content-type': 'text/html' } });
    }
    return realFetch(input, init);
  };

  // Images uploaded in the demo live in localStorage, not on a server.
  function showUploads(root) {
    Object.keys(uploads).forEach(function (path) {
      root.querySelectorAll('img[src="' + path + '"], img[src="/' + path + '"]').forEach(function (img) {
        img.setAttribute('src', uploads[path]);
      });
    });
  }

  function banner() {
    var bar = document.createElement('div');
    bar.id = 'demo-banner';
    bar.innerHTML = '<span><strong>Handpress demo</strong> — this is a real page, and you are really editing it. ' +
      'Your changes are kept in this browser only.</span>' +
      '<span class="demo-actions">' +
      '<button type="button" id="demo-reset">Reset the site</button>' +
      '<a href="https://github.com/bikramtuladhar/handpress">How it works</a></span>';
    document.body.appendChild(bar);
    document.getElementById('demo-reset').addEventListener('click', function () {
      localStorage.removeItem(KEY);
      location.reload();
    });
  }

  // Put the visitor's saved version back on screen, then start the site and the editor.
  document.addEventListener('DOMContentLoaded', function () {
    var key = pageOf(location.pathname);
    if (store[key] !== undefined) {
      var doc = new DOMParser().parseFromString(store[key], 'text/html');
      document.body.innerHTML = doc.body.innerHTML;
      document.title = doc.title;
    }
    if (store['data.js'] !== undefined) {
      try { (0, eval)(store['data.js']); } catch (e) { /* the visitor's own data; ignore a typo */ }
    }
    showUploads(document);
    if (window.renderSite) window.renderSite();
    banner();
    var s = document.createElement('script');
    s.src = 'editor.js';
    document.head.appendChild(s);
  });
})();
