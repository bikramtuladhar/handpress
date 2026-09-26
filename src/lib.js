// Pure helpers, kept separate so they can be tested under Node (see test.mjs).

const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hmacKey = secret => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// Session token = base64url("email|expiresAtMs") + "." + HMAC signature.
export async function signSession(email, secret, ttlMs = 7 * 864e5) {
  const body = b64url(enc.encode(`${email}|${Date.now() + ttlMs}`));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

export async function readSession(token, secret) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const [email, exp] = new TextDecoder().decode(unb64url(body)).split('|');
    return Date.now() < +exp ? email : null;
  } catch { return null; }
}

export const isAdmin = (email, list) =>
  !!email && String(list || '').toLowerCase().split(/[\s,]+/).filter(Boolean).includes(email.toLowerCase());

/**
 * What the editor is allowed to touch. Everything is driven by the site's config
 * (see README) so that nothing about one particular site is baked in here.
 */
export const site = (cfg = {}) => ({
  pages: cfg.pages || [],
  dataFiles: cfg.dataFiles || {},
  uploadDir: (cfg.uploadDir || 'uploads').replace(/^\/|\/$/g, ''),
  globalBlocks: cfg.globalBlocks || [],
  forceVisible: cfg.forceVisible || ''
});

export const isPage = (p, cfg) => site(cfg).pages.includes(p);
export const isData = (p, cfg) => Object.keys(site(cfg).dataFiles).includes(p);
export const isEditable = (p, cfg) => isPage(p, cfg) || isData(p, cfg);
export const isUpload = (p, cfg) =>
  new RegExp(`^${site(cfg).uploadDir}/[a-z0-9-]+\\.(jpe?g|png|webp|gif|svg)$`).test(p) && !p.includes('..');

/** Returns an error message, or '' when the file is acceptable to commit. */
export function checkFile(f, cfg) {
  if (!f || typeof f.path !== 'string') return 'missing path';
  if (isUpload(f.path, cfg)) {
    if (typeof f.base64 !== 'string' || !f.base64) return `${f.path}: no file data`;
    return f.base64.length > 14e6 ? `${f.path}: file over 10 MB` : '';
  }
  if (!isEditable(f.path, cfg)) return `${f.path}: not editable`;
  if (typeof f.content !== 'string') return `${f.path}: no content`;
  if (f.content.length > 2e6) return `${f.path}: over 2 MB`;
  if (isPage(f.path, cfg)) {
    if (!/^<!doctype html>/i.test(f.content)) return `${f.path}: not a full HTML page`;
    if (!/<\/html>\s*$/i.test(f.content)) return `${f.path}: page is cut off`;
  }
  if (isData(f.path, cfg)) {
    const m = /^(?:\/\*[\s\S]*?\*\/\s*)?window\.[A-Z_a-z$][\w$]* = ([\s\S]*);\s*$/.exec(f.content);
    if (!m) return `${f.path}: expected "window.NAME = { … };"`;
    try { JSON.parse(m[1]); } catch { return `${f.path}: data is not valid JSON`; }
  }
  return '';
}

export function decodeBase64Utf8(b64) {
  return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
}
