<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\AuthController;

// Redirecionamento de proteção para URLs estáticas diretas
Route::get('/index.html', function () {
    return redirect()->to('/');
});
Route::get('/login.html', function () {
    return redirect()->to('/login');
});

// Rotas de Autenticação Web
Route::get('/login', [AuthController::class, 'showLoginForm'])->name('login');
Route::post('/login', [AuthController::class, 'login']);
Route::match(['get', 'post'], '/logout', [AuthController::class, 'logout'])->name('logout');

// Painel principal protegido
Route::get('/', function () {
    if (!auth()->check()) {
        return redirect()->to('/login');
    }
    return file_get_contents(public_path('index.html'));
})->middleware('simulator.auth');
