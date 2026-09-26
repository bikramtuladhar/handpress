# Running it somewhere other than Cloudflare

The browser half (`src/editor.js`) is host-agnostic. It only needs six endpoints:

| Endpoint | Does |
|---|---|
| `GET /api/config` | returns `{pages, dataFiles, globalBlocks, uploadDir, forceVisible, clientId}` — public, no secrets |
| `POST /api/login` | takes `{credential}` (a Google ID token), verifies it, checks the admin list, sets the session |
| `POST /api/logout` | clears it |
| `GET /api/me` | `{email}` or 401 |
| `GET /api/file?path=` | `{path, content, sha}` — refuse anything not on the allowlist |
| `POST /api/save` | `{files: [{path, content \| base64, sha}], message}` — all or nothing |

`sha` is opaque to the editor: any value that changes when the file changes will do. On
Cloudflare it's the GitHub blob sha; on a normal server, `sha1(file contents)` is fine.

The login also sets a second, JS-readable cookie `ed=1`, which is how the site knows to load
the editor at all.

## Shared hosting (Apache and PHP)

This is the arrangement the project was built for, and it has one real advantage over the
Worker: the files are right there, so a save is **live immediately** instead of waiting for
a deploy.

The shape of it:

1. `api.php` implements the endpoints above. The session is a normal PHP session; keep its
   files outside the shared `/tmp` (`session_save_path()` to a private directory), because on
   shared hosting `/tmp` belongs to every account on the machine.
2. A save writes each file with `file_put_contents()` to a temporary name and `rename()`s it
   into place, so a visitor never sees half a page.
3. Then it runs `git add`/`commit`/`push` through `shell_exec`, keeping the same history and
   offsite copy as the Worker version. If the push is rejected because someone else pushed
   first, `git pull --rebase` once and retry. A failed push must never fail the save: the
   files are already live.
4. Keep secrets (admin list, client ID, mail settings) in a file **above** the web root,
   mode 600.

### Apache configuration

The repository usually sits in the web root, which means everything in it is downloadable
unless you say otherwise:

```apache
DirectoryIndex index.html
Options -Indexes

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteRule ^api/([a-z-]+)/?$ api.php?route=$1 [QSA,L]

  # Clean URLs: /about serves about.html, and about.html redirects to /about.
  RewriteCond %{THE_REQUEST} \s/([a-z0-9-]+)\.html[\s?] [NC]
  RewriteRule ^([a-z0-9-]+)\.html$ /$1 [R=301,L]
  RewriteCond %{REQUEST_FILENAME}.html -f
  RewriteRule ^([a-z0-9-]+)/?$ $1.html [L]
</IfModule>

# Anything in the repository that is not the website.
RedirectMatch 404 (?i)^/(\.git|node_modules|scripts)(/|$)
RedirectMatch 404 (?i)^/(package(-lock)?\.json|.*\.md)$
```

And in the uploads directory, refuse to execute whatever lands there:

```apache
<IfModule mod_php.c>
  php_flag engine off
</IfModule>
RemoveHandler .php .phtml .cgi .pl .py
RemoveType .php .phtml .cgi .pl .py
<FilesMatch "^(?!.*\.(?i:jpe?g|png|webp|gif|svg|mp3|m4a|ogg)$).*$">
  Require all denied
</FilesMatch>
```

Worth testing rather than trusting: upload a `.php` file and a `.jpg` containing PHP, and
request both. The first should be refused, the second should come back as bytes.

## Node, Deno, or a framework's API route

Same endpoints. Swap `crypto.subtle` HMAC sessions for whatever you already use, and write
files with `fs`. The only part worth copying carefully is the conflict check: read the file's
current hash at save time and refuse the whole save if it differs from the one the editor
loaded, or two editors will silently overwrite each other.
