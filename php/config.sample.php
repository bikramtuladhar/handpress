<?php
/**
 * Copy to ONE LEVEL ABOVE your web root as handpress-config.php.
 * If the site is at /home/you/public_html, this belongs at /home/you/handpress-config.php.
 * It holds the keys: it must never sit inside the web root.
 */
return [
    // Google addresses allowed to edit the site.
    'admin_emails' => ['you@example.com'],

    // OAuth client ID (Google Cloud console → Credentials → Web application).
    // Add your site's origin under "Authorized JavaScript origins".
    'google_client_id' => '',

    // What may be edited. Anything not listed here cannot be read or written.
    'pages' => ['index.html', 'about.html'],
    'data_files' => ['data.js' => 'Opening times'],   // window.NAME = { …valid JSON… };
    'global_blocks' => ['header', 'footer'],
    'upload_dir' => 'uploads',
    'force_visible' => '',        // a selector to keep visible while editing, if you animate on scroll

    // Commit each save and push (needs git, shell access and a deploy key).
    'git' => true,
    // Keep a timestamped copy of every file before overwriting it.
    'backups' => true,
];
