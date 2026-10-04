<?php
/**
 * Handpress on ordinary shared hosting (cPanel, Plesk, DreamHost — anything with PHP 8.1+).
 *
 * Same API as the Cloudflare Worker: /api/config, /api/login, /api/logout, /api/me,
 * /api/file, /api/save. Reached through the .htaccess rewrite shipped beside this file.
 *
 * A save writes the files straight into the web root, so it is live immediately, then
 * commits and pushes — which keeps the history and the offsite copy. If git is not
 * available, timestamped backups are kept instead.
 *
 * Settings live in handpress-config.php ONE LEVEL ABOVE the web root. Never inside it.
 */
declare(strict_types=1);

$ROOT = __DIR__;
$CONFIG_FILE = dirname(__DIR__) . '/handpress-config.php';
$cfg = is_file($CONFIG_FILE) ? require $CONFIG_FILE : [];
$cfg += [
    'admin_emails' => [], 'google_client_id' => '',
    'pages' => [], 'data_files' => [], 'global_blocks' => [], 'upload_dir' => 'uploads',
    'force_visible' => '', 'git' => true, 'backups' => true,
];

function is_page(string $p, array $cfg): bool {
    return in_array($p, $cfg['pages'], true) ||    // new_pages: editors may create top-level name.html pages
        (!empty($cfg['new_pages']) && $p !== 'admin.html' && (bool) preg_match('~^[a-z0-9][a-z0-9-]{0,60}\.html$~', $p));
}
function is_data(string $p, array $cfg): bool { return array_key_exists($p, $cfg['data_files']); }
function is_editable(string $p, array $cfg): bool { return is_page($p, $cfg) || is_data($p, $cfg); }
function is_upload(string $p, array $cfg): bool {
    $dir = preg_quote(trim($cfg['upload_dir'], '/'), '~');
    return !str_contains($p, '..') && (bool) preg_match("~^$dir/[a-z0-9-]+\.(jpe?g|png|webp|gif|svg|mp3|m4a|ogg)$~", $p);
}

function send($data, int $status = 200): never {
    http_response_code($status);
    header('content-type: application/json');
    header('cache-control: no-store');
    echo json_encode($data);
    exit;
}
function fail(int $status, string $message): never { send(['error' => $message], $status); }

/** Returns '' when the file is acceptable to write. */
function check_file(array $f, array $cfg): string {
    $p = $f['path'] ?? '';
    if (!is_string($p) || $p === '') return 'missing path';
    if (is_upload($p, $cfg)) {
        if (empty($f['base64']) || !is_string($f['base64'])) return "$p: no file data";
        return strlen($f['base64']) > 14000000 ? "$p: file over 10 MB" : '';
    }
    if (!is_editable($p, $cfg)) return "$p: not editable";
    if (!isset($f['content']) || !is_string($f['content'])) return "$p: no content";
    $c = $f['content'];
    if (strlen($c) > 2000000) return "$p: over 2 MB";
    if (is_page($p, $cfg)) {
        if (!preg_match('~^<!doctype html>~i', $c)) return "$p: not a full HTML page";
        if (!preg_match('~</html>\s*$~i', $c)) return "$p: page is cut off";
    }
    if (is_data($p, $cfg)) {
        if (!preg_match('~^(?:/\*.*?\*/\s*)?window\.[A-Za-z_$][\w$]* = (.*);\s*$~s', $c, $m)) {
            return "$p: expected \"window.NAME = { … };\"";
        }
        json_decode($m[1]);
        if (json_last_error() !== JSON_ERROR_NONE) return "$p: data is not valid JSON";
    }
    return '';
}

function start_session(): void {
    // Shared hosting puts sessions in a /tmp shared with every other account on the machine.
    // Keep ours in a private directory above the web root instead.
    $dir = dirname(__DIR__) . '/handpress-sessions';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (is_dir($dir) && is_writable($dir)) session_save_path($dir);
    session_set_cookie_params(['lifetime' => 7 * 86400, 'path' => '/', 'httponly' => true,
        'secure' => !empty($_SERVER['HTTPS']), 'samesite' => 'Strict']);
    session_start();
}

/** Cookie the site's own script reads to decide whether to load the editor. */
function editor_cookie(bool $on): void {
    setcookie('ed', $on ? '1' : '', ['expires' => $on ? time() + 7 * 86400 : 1, 'path' => '/',
        'secure' => !empty($_SERVER['HTTPS']), 'samesite' => 'Strict']);
}

$route = $_GET['route'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

start_session();

if ($route === 'config') {
    send([
        'pages' => array_values($cfg['pages']),
        'dataFiles' => (object) $cfg['data_files'],
        'globalBlocks' => array_values($cfg['global_blocks']),
        'uploadDir' => trim($cfg['upload_dir'], '/'),
        'forceVisible' => $cfg['force_visible'],
        'newPages' => !empty($cfg['new_pages']),
        'clientId' => $cfg['google_client_id'],
    ]);
}

if ($route === 'login' && $method === 'POST') {
    $body = json_decode((string) file_get_contents('php://input'), true) ?: [];
    // Google's tokeninfo endpoint verifies the ID token for us, which is plenty at
    // admin-login volume. Swap in local JWKS verification if you expect many logins.
    $ch = curl_init('https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode((string) ($body['credential'] ?? '')));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15]);
    $t = json_decode((string) curl_exec($ch), true) ?: [];
    curl_close($ch);
    $valid = ($t['aud'] ?? '') === $cfg['google_client_id']
        && (string) ($t['email_verified'] ?? '') === 'true'
        && in_array($t['iss'] ?? '', ['accounts.google.com', 'https://accounts.google.com'], true);
    if (!$valid) fail(401, 'Google sign-in could not be verified');
    $email = (string) ($t['email'] ?? '');
    $admins = array_map('strtolower', $cfg['admin_emails']);
    if (!in_array(strtolower($email), $admins, true)) fail(403, "$email is not an editor of this site");
    session_regenerate_id(true);
    $_SESSION['email'] = $email;
    editor_cookie(true);
    send(['email' => $email]);
}

if ($route === 'logout' && $method === 'POST') {
    $_SESSION = [];
    session_destroy();
    editor_cookie(false);
    send(['ok' => true]);
}

$email = $_SESSION['email'] ?? '';
if (!$email || !in_array(strtolower($email), array_map('strtolower', $cfg['admin_emails']), true)) {
    fail(401, 'Please sign in again');
}

if ($route === 'me') send(['email' => $email]);

if ($route === 'file') {
    $path = (string) ($_GET['path'] ?? '');
    if (!is_editable($path, $cfg)) fail(400, 'Not an editable file');
    $full = "$ROOT/$path";
    if (!is_file($full)) fail(404, 'No such file');
    $content = (string) file_get_contents($full);
    send(['path' => $path, 'sha' => sha1($content), 'content' => $content]);
}

if ($route === 'save' && $method === 'POST') {
    $in = json_decode((string) file_get_contents('php://input'), true) ?: [];
    $files = $in['files'] ?? null;
    if (!is_array($files) || !$files || count($files) > 60) fail(400, 'Nothing to save');
    foreach ($files as $f) {
        if ($bad = check_file((array) $f, $cfg)) fail(400, $bad);
    }
    // Refuse the whole save if any file changed since the editor loaded it.
    $stale = [];
    foreach ($files as $f) {
        if (empty($f['sha'])) continue;
        $full = "$ROOT/{$f['path']}";
        if (is_file($full) && sha1((string) file_get_contents($full)) !== $f['sha']) $stale[] = $f['path'];
    }
    if ($stale) fail(409, 'Changed since you opened it: ' . implode(', ', $stale) . '. Reload the page and redo your edit.');
    // A text file sent without a sha is a new file: it must not overwrite one that exists.
    $taken = [];
    foreach ($files as $f) {
        if (empty($f['sha']) && isset($f['content']) && is_file("$ROOT/{$f['path']}")) $taken[] = $f['path'];
    }
    if ($taken) fail(409, 'Already exists: ' . implode(', ', $taken) . '. Pick another name.');

    $written = [];
    foreach ($files as $f) {
        $path = $f['path'];
        $full = "$ROOT/$path";
        @mkdir(dirname($full), 0755, true);
        if ($cfg['backups'] && is_file($full)) {
            $keep = dirname(__DIR__) . '/handpress-backups/' . date('Ymd-His') . '/' . $path;
            @mkdir(dirname($keep), 0775, true);
            @copy($full, $keep);
        }
        $data = isset($f['base64']) ? base64_decode($f['base64'], true) : $f['content'];
        if ($data === false) fail(400, "$path: bad file data");
        // Write beside the target, then rename: a visitor never sees half a page.
        $tmp = $full . '.tmp' . bin2hex(random_bytes(4));
        if (file_put_contents($tmp, $data) === false || !rename($tmp, $full)) {
            @unlink($tmp);
            fail(500, "Could not write $path. Check the folder's permissions.");
        }
        $written[] = $path;
    }

    tidy_up($ROOT, dirname(__DIR__) . '/handpress-backups');
    $git = $cfg['git'] ? git_commit($ROOT, $written, (string) ($in['message'] ?? ''), $email) : ['skipped' => true];
    send(['ok' => true, 'files' => $written, 'git' => $git]);
}

fail(404, 'Unknown API route');

/** No half-written files left behind, and no unbounded pile of backups. */
function tidy_up(string $root, string $backups): void {
    foreach (glob("$root/*.tmp*") ?: [] as $tmp) {
        if (is_file($tmp) && filemtime($tmp) < time() - 3600) @unlink($tmp);
    }
    $snapshots = glob("$backups/*", GLOB_ONLYDIR) ?: [];
    sort($snapshots);
    foreach (array_slice($snapshots, 0, max(0, count($snapshots) - 100)) as $old) {
        if (function_exists('exec')) exec('rm -rf ' . escapeshellarg($old));
    }
}

/** Commit the saved files and push. Never fails the save: the files are already live. */
function git_commit(string $root, array $paths, string $message, string $email): array {
    if (!is_dir("$root/.git") || !function_exists('shell_exec')) return ['skipped' => 'no git'];
    $run = fn(string $cmd): string => (string) shell_exec('cd ' . escapeshellarg($root) . ' && ' . $cmd . ' 2>&1');
    $run('git add -- ' . implode(' ', array_map('escapeshellarg', $paths)));
    $summary = substr($message ?: 'Edit ' . implode(', ', $paths), 0, 200);
    $out = $run('git -c user.name=' . escapeshellarg('Handpress') . ' -c user.email=' . escapeshellarg($email) .
        ' commit -m ' . escapeshellarg($summary . "\n\nSaved from the site editor by $email"));
    $push = $run('git push origin HEAD');
    // Someone else pushed in between: replay our commit on top and retry, which also brings
    // the site up to date. Never fatal — the files are already saved and live.
    if (stripos($push, 'rejected') !== false || stripos($push, 'non-fast-forward') !== false) {
        $rebase = $run('git pull --rebase origin HEAD');
        $push = $run('git push origin HEAD') . ' (after rebase: ' . trim($rebase) . ')';
    }
    return ['commit' => trim($out), 'push' => trim($push)];
}
