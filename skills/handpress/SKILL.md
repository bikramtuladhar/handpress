---
name: handpress
description: Add Handpress to a static HTML site so a non-technical owner can edit the pages in place, in the browser, with saves committed to git. Use when the user wants a client, editor or colleague to be able to change text, images and links on a hand-written static site without touching code, or asks for a CMS for a static site, in-place/inline editing, or "make this site editable".
---

# Adding Handpress to a static site

Handpress makes a hand-written HTML site editable in the browser. The HTML files stay the
content, each save is a git commit, and nothing is re-rendered from templates, so the design
survives untouched.

Reference: https://github.com/bikramtuladhar/handpress · demo: https://handpress-demo.bikramtuladhar2011.workers.dev

## Decide first whether it fits

Good fit: a handful of hand-written pages, one or two editors, the design matters, the owner
wants to fix a date or swap a photograph occasionally.

Say so plainly and stop if instead the site has: hundreds of pages, many simultaneous authors,
a draft/approval workflow, or content already in a database or a framework's content
collection. Those want a real CMS. Handpress keeps unsaved drafts only in the editor's own
browser (no server-side drafts or approval), and refuses a second concurrent save rather than
merging it.

## Steps

### 1. Install the two browser files

```sh
npx handpress install ./public        # the directory the site is served from
```

This writes `editor.js` and `admin.html` next to the site. Commit them.

### 2. Key the pages

```sh
npx handpress keys "public/*.html" --global "header, footer"
```

`--global` names the blocks repeated on every page (header, nav, footer). Their keys line up
across pages, so editing one updates all of them.

This rewrites the HTML: it adds `data-e` keys **and** normalises the markup to the exact form
a browser serialises (`defer=""`, `&amp;`, closed tags). Commit that reformat on its own, before
any content change, or the first content diff will be unreadable.

Re-run after any hand-edit of the HTML. Existing keys are never renumbered.

### 3. Load the editor only for editors

One line in the site's own JavaScript:

```js
if (/(?:^|;\s*)ed=1/.test(document.cookie)) {
  var s = document.createElement('script'); s.src = '/editor.js'; s.defer = true;
  document.head.appendChild(s);
}
```

`ed` is only a hint. Every read and write is checked server-side against an HttpOnly session.

### 4. Back end

On Cloudflare, point a Worker at `node_modules/handpress/src/worker.js` and configure:

```jsonc
"vars": {
  "GITHUB_REPO": "owner/repo",
  "GITHUB_BRANCH": "main",
  "GOOGLE_CLIENT_ID": "…apps.googleusercontent.com",
  "EDITOR": {
    "pages": ["index.html", "about.html"],
    "dataFiles": { "data.js": "Opening times" },
    "globalBlocks": ["header", "footer"],
    "uploadDir": "uploads"
  }
}
```

Secrets: `GITHUB_TOKEN` (fine-grained, that repo only, Contents read+write), `SESSION_SECRET`
(`openssl rand -hex 32`), `ADMIN_EMAILS`.

On ordinary shared hosting (cPanel, Apache, PHP 8.1+), install the server half with
`npx handpress install ./public_html --php` — it adds `api.php`, the two `.htaccess` templates and
a sample settings file that belongs ONE level above the web root. Saves publish instantly there,
with no deploy wait. Full walkthrough: https://bikramtuladhar.github.io/handpress/cpanel.html

Sign-in needs a Google OAuth client (Web application) with the site's origin listed under
Authorized JavaScript origins.

### 5. Move data-driven content into a data file

Anything the site renders from a list — events, products, opening times — belongs in a data
file (`window.NAME = { …valid JSON… };`), not in the markup. The editor gives the owner a form
for it. Content kept in markup can only be edited where it appears.

Then, in the site's script, tell the editor where that list is drawn and how to redraw it, so the
owner gets handles right on the page and sees changes before saving:

```js
window.EDITOR_HOOKS = {
  dataRegions: [['[data-events]', 'data.js', 'events', 'Events']],   // one child element per entry
  dataChanged: function (path, obj) { if (path === 'data.js') { window.SITE = obj; renderEvents(); } },
  guide: { 'index.html': [['Events come from data.js: “+ Add”, or the handles on each.', '[data-events]']] },
  ai: { context: 'Voice notes the AI writes with (warm, plain, concrete).',
        actions: [['Event line', 'Rewrite as a one-line event listing: name, date, one detail.']] }
};
```

`guide` gives each page tips with a “Show me” button; write one or two per page for whatever the
owner is likely to change.

`ai` feeds the built-in AI assistant (free OpenRouter models, key pasted by the owner under
AI → Settings, kept in the browser): `context` is brand-voice guidance, `model` an optional default
OpenRouter model id, and `actions` extra quick actions in each block's AI menu. The AI writes with
the site's own design — colours, classes and section shapes are collected from the page itself —
and its output is sanitized and applied as an ordinary edit.

## Things that go wrong

- **Text reverts after saving.** The site's own JavaScript rewrites that element (a counter, a
  ticker). Use `window.EDITOR_HOOKS.beforeEdit` to detach it, and `syncUnit` to keep an
  attribute in step with the text.
- **Elements invisible while editing.** A reveal-on-scroll animation. Set `forceVisible` in the
  config to the selector it uses.
- **"This page can't be edited."** The page is not in `pages`, or it is not keyed.
- **The editor never leaves "Publishing…".** On a deploy-based host, the built site does not
  match the commit — check the deploy actually ran.
- **A save is refused as changed.** Someone else saved that file first. Reload and redo it.

## What to check before handing it over

1. Sign in as an admin, edit text on two pages, save, and confirm the commit.
2. Edit a shared header or footer and confirm every page changed.
3. Duplicate a list item, reorder, delete, Undo, Redo, save. Copy a whole section to another page.
   Reload before saving once, and check the draft (the counter on Save) survived.
4. Replace an image (and audio, if the site has any), and confirm the uploaded file is served and
   cannot be executed.
5. Visit as a signed-out visitor: `editor.js` must not load, and `/api/save` must return 401.
6. Confirm nothing outside the allowlist can be read or written, even while signed in.
