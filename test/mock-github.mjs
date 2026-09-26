/**
 * A stand-in for the GitHub API, for tests only: the "repository" is a directory on disk,
 * and a commit writes the files into it. Run it with SITE_ROOT pointing at the example site,
 * and point the Worker at it with GITHUB_API=http://127.0.0.1:8798 in .dev.vars.
 */
import http from 'node:http'; import fs from 'node:fs'; import crypto from 'node:crypto';
const ROOT = process.env.SITE_ROOT;
const sha = buf => crypto.createHash('sha1').update(buf).digest('hex');
const blobs = {}; const trees = {}; const commits = { c0: { tree: 't0' } }; let head = 'c0';
const files = () => { const out = {}; const walk = d => fs.readdirSync(ROOT + d, { withFileTypes: true }).forEach(e => { const p = d + e.name; e.isDirectory() ? walk(p + '/') : out[p] = sha(fs.readFileSync(ROOT + p)); }); walk(''); return out; };
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c; body = body ? JSON.parse(body) : null;
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/repos\/[^/]+\/[^/]+\//, '');
  const send = (s, d) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (req.method === 'GET' && p.startsWith('contents/')) {
    const f = decodeURIComponent(p.slice(9)); if (!fs.existsSync(ROOT + f)) return send(404, {});
    const buf = fs.readFileSync(ROOT + f); return send(200, { sha: sha(buf), content: buf.toString('base64') });
  }
  if (req.method === 'GET' && p.startsWith('git/ref/heads/')) return send(200, { object: { sha: head } });
  if (req.method === 'GET' && p.startsWith('git/commits/')) return send(200, commits[p.split('/')[2]]);
  if (req.method === 'GET' && p.startsWith('git/trees/')) return send(200, { tree: Object.entries(files()).map(([path, s]) => ({ path, sha: s })) });
  if (req.method === 'POST' && p === 'git/blobs') { const s = 'b' + Object.keys(blobs).length; blobs[s] = Buffer.from(body.content, 'base64'); return send(201, { sha: s }); }
  if (req.method === 'POST' && p === 'git/trees') { const s = 't' + (Object.keys(trees).length + 1); trees[s] = body.tree; return send(201, { sha: s }); }
  if (req.method === 'POST' && p === 'git/commits') { const s = 'c' + Object.keys(commits).length; commits[s] = { tree: body.tree, parents: body.parents, message: body.message }; return send(201, { sha: s }); }
  if (req.method === 'PATCH' && p.startsWith('git/refs/heads/')) {
    const c = commits[body.sha];
    for (const e of trees[c.tree]) { fs.mkdirSync(ROOT + e.path.replace(/[^/]+$/, ''), { recursive: true }); fs.writeFileSync(ROOT + e.path, e.content != null ? e.content : blobs[e.sha]); }
    fs.appendFileSync(process.env.MOCK_LOG || '/tmp/mock-github.log', 'COMMIT ' + c.message.split('\n')[0] + ' :: ' + trees[c.tree].map(e => e.path).join(', ') + '\n');
    head = body.sha; return send(200, { object: { sha: head } });
  }
  send(404, { message: 'mock: unknown ' + p });
}).listen(8798, () => console.log('mock on 8798'));
