# static-site-editor

Let a client edit a hand-written static site — the real pages, in place, in the browser —
without a CMS, a build step or a database.

Saving writes the HTML files and commits them. The repository stays the content, the
git history is the undo, and the design is whatever you wrote, because nothing is
re-rendered from a template.

```
visitor   →  your static site, exactly as you built it

editor    →  /admin  →  sign in with Google
          →  clicks the page and types
          →  Save  →  one commit  →  live
```

## Why this instead of a CMS

Most CMSs ask you to break a design into templates and move the words into a database.
That is the right trade for a blog with a hundred posts. It is the wrong trade for a
brochure site of ten careful pages, where the layout *is* the product and the client
wants to fix a date or swap a photograph twice a year.

This keeps the HTML as the source of truth and teaches the browser to edit it:

- **No templating.** Your markup is untouched apart from a small `data-e` key per editable element.
- **No database.** Files in git. Roll back with `git revert`.
- **No build.** The editor is one JavaScript file, loaded only for signed-in editors.
- **Clean diffs.** Saves are byte-identical to what the browser would write, so a changed
  sentence is a one-line diff, reviewable in a pull request.

It is not for you if you need drafts, workflow, many authors, or hundreds of pages.

## What the editor can do

- **Text** — click and type, with bold, italic and links. Pasted text arrives plain.
- **Lists** — hover any repeating thing (cards, list items, paragraphs, buttons): duplicate,
  move, delete. New entries are copies of one that exists, so they stay on-design.
- **Images** — click to replace (resized in the browser before upload) and edit alt text.
- **Shared blocks** — edit the header or footer once, written to every page.
- **Page settings** — title, meta description, and the text shown when the page is shared.
- **Site data** — a form over your JSON data file, for the lists a site renders from data
  (events, products, opening times) rather than markup.

Everything else — anything not on the allowlist — cannot be touched, by anyone, ever.

## How it works

Three pieces:

| | |
|---|---|
| `src/annotate.mjs` | Run once over your pages. Adds `data-e` keys so the editor can find the same element in the live page and in the file. |
| `src/editor.js` | The browser half. Fetches the page's **source** and keeps it as a second DOM; edits are applied to both, so what gets saved is clean HTML, not whatever your scripts did to the page at runtime. |
| `src/worker.js` | The server half (Cloudflare Worker). Google sign-in, an allowlist, and one commit per save through the GitHub API. |

The two-DOM trick is the heart of it. A live page has been rearranged by your own
JavaScript: lists rendered, counters animated, classes toggled. Saving what's on screen
would bake all of that into the file. So the editor edits the *source* by key and writes
that, and the live page is only a preview of the change.

## Quick look

```sh
npm install
npm run example      # wrangler dev, the sample bakery site at localhost:8787
```

The example runs without credentials — you can browse it, but signing in and saving need
a Google client ID and a GitHub token (below).

## Adding it to your own site

**1. Key your pages** (re-run this whenever you hand-edit HTML):

```sh
npx static-site-editor-install ./public      # copies editor.js and admin.html into your site
node src/annotate.mjs "public/*.html" --global "header.site-header, footer"
```

**2. Load the editor for editors only.** One line in your site's own JavaScript:

```js
if (/(?:^|;\s*)ed=1/.test(document.cookie)) {
  var s = document.createElement('script'); s.src = '/editor.js'; s.defer = true;
  document.head.appendChild(s);
}
```

The `ed` cookie is only a hint that says "show the editor". Every actual read and write is
checked server-side against an HttpOnly session cookie. Visitors never download the editor.

**3. Configure the Worker** (`wrangler.jsonc`):

```jsonc
"vars": {
  "GITHUB_REPO": "you/your-site",
  "GITHUB_BRANCH": "main",
  "GOOGLE_CLIENT_ID": "…apps.googleusercontent.com",
  "EDITOR": {
    "pages": ["index.html", "about.html"],          // the only pages that can be edited
    "dataFiles": { "data.js": "Opening times" },     // window.NAME = { …valid JSON… };
    "globalBlocks": ["header", "footer"],            // edited once, written to every page
    "uploadDir": "uploads",                          // where new images go
    "forceVisible": "[data-reveal]"                  // kept visible while editing, if you animate on scroll
  }
}
```

**4. Secrets:**

```sh
wrangler secret put GITHUB_TOKEN     # fine-grained, this repo only, Contents: read and write
wrangler secret put SESSION_SECRET   # openssl rand -hex 32
wrangler secret put ADMIN_EMAILS     # comma-separated Google addresses allowed to edit
```

**5. Google sign-in:** create an OAuth client (Web application) in the Google Cloud console
and add your site's origin under *Authorized JavaScript origins*.

Then deploy, visit `/admin`, and edit.

## Per-site quirks

If your own scripts fight the editor, set hooks before `editor.js` loads:

```js
window.EDITOR_HOOKS = {
  // Called before an element becomes editable. Return a replacement to use instead.
  // Example: detach a counter from the animation that would overwrite what is typed.
  beforeEdit(el) { const fresh = el.cloneNode(false); el.replaceWith(fresh); return fresh; },

  // Called when edited text is copied back into the source, for attributes that must follow it.
  syncUnit(sourceEl, liveEl) { sourceEl.setAttribute('data-count-to', parseInt(sourceEl.textContent, 10)); }
};
```

## Security

The trust boundary is the admin list: whoever is on it can change any editable file, and
editing HTML means they could insert a script. Keep the list short.

Everything else is closed by default:

- Reads and writes are refused for any path not in `pages`, `dataFiles` or `uploadDir`,
  **including for a signed-in admin**.
- Sign-in requires a Google ID token that Google validates, plus a match on the admin list.
  There is no password to guess.
- The session cookie is HttpOnly, Secure and SameSite=Strict, which is also why no separate
  CSRF token is needed. Writes must be JSON, which a cross-site form cannot send.
- Saves carry the blob sha the file was loaded at: if someone else saved in between, the
  whole save is refused rather than overwriting their work.
- Uploads are restricted by extension and directory. On a host that executes files (Apache,
  PHP) also deny execution in the uploads directory — the example for Apache is in `docs/`.

## Other hosts

The Worker is the reference implementation. The same API (`/api/config`, `/api/login`,
`/api/me`, `/api/file`, `/api/save`) is small enough to re-implement anywhere; a PHP version
for ordinary shared hosting, which writes the files directly and commits with `git`, is
about 250 lines. See `docs/other-hosts.md`.

## Status

Early, but not theoretical: it runs a real client site.

- `npm test` — sessions, the allowlist, the file checks, the keying script.
- `npm run test:browser` — drives the example in a real browser (edit, edit a shared block,
  duplicate a card, edit the data file, save) against a stand-in GitHub, and checks what was
  committed. It needs `playwright-core`, a local Chrome, and the two background processes
  listed at the top of `test/browser.mjs`.

Known gaps: no drafts or preview, one branch, and the editor assumes one person editing at a
time (a second save is refused, not merged).

MIT licensed.
