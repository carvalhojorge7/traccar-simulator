<?php

$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?? '');

if ($uri === '/index.html') {
    header('Location: /', true, 302);
    exit;
}

if ($uri === '/login.html') {
    header('Location: /login', true, 302);
    exit;
}

// Intercepta rotas reservadas para passar pela governança e autenticação do Laravel
$interceptRoutes = ['/', '/login'];

if (!in_array($uri, $interceptRoutes) && file_exists(__DIR__ . '/public' . $uri)) {
    return false;
}

$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['PHP_SELF'] = '/index.php';

require_once __DIR__ . '/public/index.php';
