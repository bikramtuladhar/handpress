/**
 * Edit-in-place for static sites: the Cloudflare Worker half.
 *
 * Serves the site's files, and adds:
 *   GET  /api/config        what the editor may touch (public: no secrets)
 *   POST /api/login         a Google ID token in, a session cookie out
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/file?path=    a file as GitHub currently has it, with its blob sha
 *   POST /api/save          writes every changed file as ONE commit
 *
 * The files in the repository are the content. A save is a commit; the history is the undo.
 */
import { signSession, readSession, isAdmin, site, isEditable, checkFile, decodeBase64Utf8 } from './lib.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (status, message) => Object.assign(new Error(message), { status });

const WEEK = 7 * 86400;
const cookies = (session, maxAge) => [
  `sess=${session}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
  // Readable by the page, so the site knows to load the editor. Real auth is the HttpOnly cookie.
  `ed=1; Path=/; Max-Age=${maxAge}; Secure; SameSite=Strict`
];
const withCookies = (res, list) => { list.forEach(c => res.headers.append('set-cookie', c)); return res; };
const config = env => (typeof env.EDITOR === 'string' ? JSON.parse(env.EDITOR) : env.EDITOR) || {};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  }
};

async function api(req, env, url) {
  const route = `${req.method} ${url.pathname}`;
  const cfg = config(env);
  // CSRF: the cookie is SameSite=Strict, and writes must be JSON, which a cross-site form cannot send.
  if (req.method === 'POST' && !String(req.headers.get('content-type')).startsWith('application/json')) throw fail(415, 'JSON only');

  if (route === 'GET /api/config') return json({ ...site(cfg), clientId: env.GOOGLE_CLIENT_ID || '' });

  if (route === 'POST /api/login') {
    const { credential } = await req.json();
    // Google's tokeninfo endpoint verifies the ID token for us, which is plenty at admin-login
    // volume. Swap in local JWKS verification (jose) if you expect many logins.
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential || ''));
    const t = r.ok ? await r.json() : {};
    const valid = t.aud === env.GOOGLE_CLIENT_ID && String(t.email_verified) === 'true' &&
      ['accounts.google.com', 'https://accounts.google.com'].includes(t.iss);
    if (!valid) throw fail(401, 'Google sign-in could not be verified');
    if (!isAdmin(t.email, env.ADMIN_EMAILS)) throw fail(403, `${t.email} is not an editor of this site`);
    return withCookies(json({ email: t.email }), cookies(await signSession(t.email, env.SESSION_SECRET), WEEK));
  }

  if (route === 'POST /api/logout') return withCookies(json({ ok: true }), cookies('', 0));

  const email = await readSession(/(?:^|;\s*)sess=([^;]+)/.exec(req.headers.get('cookie') || '')?.[1], env.SESSION_SECRET);
  if (!email || !isAdmin(email, env.ADMIN_EMAILS)) throw fail(401, 'Please sign in again');

  if (route === 'GET /api/me') return json({ email });

  if (route === 'GET /api/file') {
    const path = url.searchParams.get('path') || '';
    if (!isEditable(path, cfg)) throw fail(400, 'Not an editable file');
    const f = await gh(env, `contents/${path}?ref=${env.GITHUB_BRANCH}`);
    return json({ path, sha: f.sha, content: decodeBase64Utf8(f.content) });
  }

  if (route === 'POST /api/save') {
    const { files, message } = await req.json();
    if (!Array.isArray(files) || !files.length || files.length > 60) throw fail(400, 'Nothing to save');
    const bad = files.map(f => checkFile(f, cfg)).find(Boolean);
    if (bad) throw fail(400, bad);
    return json(await commit(env, files, message, email));
  }

  throw fail(404, 'Unknown API route');
}

async function gh(env, path, init = {}) {
  const r = await fetch(`${env.GITHUB_API || 'https://api.github.com'}/repos/${env.GITHUB_REPO}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'static-site-editor',
      ...(init.body ? { 'content-type': 'application/json' } : {})
    }
  });
  if (!r.ok) throw fail(r.status === 404 ? 404 : 502, `GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// One commit for the whole save. Each text file carries the blob sha it was loaded at; if GitHub
// has a different version now, someone saved in between and the whole save is refused.
async function commit(env, files, message, email) {
  const branch = env.GITHUB_BRANCH;
  const head = (await gh(env, `git/ref/heads/${branch}`)).object.sha;
  const baseTree = (await gh(env, `git/commits/${head}`)).tree.sha;
  const current = new Map((await gh(env, `git/trees/${baseTree}?recursive=1`)).tree.map(t => [t.path, t.sha]));
  const stale = files.filter(f => f.sha && current.get(f.path) !== f.sha).map(f => f.path);
  if (stale.length) throw fail(409, `Changed since you opened it: ${stale.join(', ')}. Reload the page and redo your edit.`);

  const tree = [];
  for (const f of files) {
    const entry = { path: f.path, mode: '100644', type: 'blob' };
    if (f.base64) entry.sha = (await gh(env, 'git/blobs', { method: 'POST', body: JSON.stringify({ content: f.base64, encoding: 'base64' }) })).sha;
    else entry.content = f.content;
    tree.push(entry);
  }
  const newTree = (await gh(env, 'git/trees', { method: 'POST', body: JSON.stringify({ base_tree: baseTree, tree }) })).sha;
  const summary = String(message || `Edit ${files.map(f => f.path).join(', ')}`).slice(0, 200);
  const c = await gh(env, 'git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: `${summary}\n\nSaved from the site editor by ${email}`, tree: newTree, parents: [head] })
  });
  // Not forced: if the branch moved since we read it, GitHub rejects this and nothing is lost.
  await gh(env, `git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) })
    .catch(e => { throw /^GitHub 422/.test(e.message) ? fail(409, 'Someone saved at the same moment. Try Save again.') : e; });
  return { commit: c.sha };
}
