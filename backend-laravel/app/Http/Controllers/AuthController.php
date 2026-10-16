<?php

namespace App\Http\Controllers;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Str;

class AuthController extends Controller
{
    /**
     * Retorna as credenciais administrativas configuradas no ambiente.
     */
    protected function getAdminCredentials(): array
    {
        return [
            'user' => config('auth.admin.user', env('ADMIN_USER', env('ADMIN_LOGIN', 'admin'))),
            'password' => config('auth.admin.password', env('ADMIN_PASSWORD', env('ADMIN_PASS', 'admin'))),
        ];
    }

    /**
     * Exibe o formulário de login (ou redireciona para o painel se já autenticado).
     */
    public function showLoginForm()
    {
        if (Auth::guard('web')->check()) {
            return redirect()->to('/');
        }

        $loginPath = public_path('login.html');
        if (file_exists($loginPath)) {
            return response()->file($loginPath);
        }

        return response('Tela de login não encontrada.', 404);
    }

    /**
     * Processa a autenticação do usuário admin.
     */
    public function login(Request $request)
    {
        $request->validate([
            'login' => 'required|string',
            'password' => 'required|string',
        ]);

        $ip = $request->ip();
        $throttleKey = 'login-attempt:' . $ip;

        if (RateLimiter::tooManyAttempts($throttleKey, 10)) {
            $seconds = RateLimiter::availableIn($throttleKey);
            return response()->json([
                'success' => false,
                'message' => "Muitas tentativas incorretas. Tente novamente em {$seconds} segundos.",
            ], 429);
        }

        $admin = $this->getAdminCredentials();
        $inputLogin = trim($request->input('login'));
        $inputPassword = (string) $request->input('password');

        $isValid = false;
        $user = null;

        // 1. Validação prioritária contra credenciais do .env (ADMIN_USER / ADMIN_PASSWORD)
        if ($inputLogin === $admin['user'] && $inputPassword === $admin['password']) {
            $isValid = true;
            $email = str_contains($admin['user'], '@') ? $admin['user'] : $admin['user'] . '@simulator.local';

            $user = User::where('name', $admin['user'])
                ->orWhere('email', $email)
                ->first();

            if (!$user) {
                $user = User::create([
                    'name' => $admin['user'],
                    'email' => $email,
                    'password' => Hash::make($admin['password']),
                ]);
            } else {
                // Sincroniza a senha no banco caso tenha sido alterada no .env
                if (!Hash::check($admin['password'], $user->password)) {
                    $user->password = Hash::make($admin['password']);
                    $user->save();
                }
            }
        } else {
            // 2. Validação alternativa contra usuário existente no banco de dados
            $dbUser = User::where('email', $inputLogin)
                ->orWhere('name', $inputLogin)
                ->first();

            if ($dbUser && Hash::check($inputPassword, $dbUser->password)) {
                $isValid = true;
                $user = $dbUser;
            }
        }

        if (!$isValid || !$user) {
            RateLimiter::hit($throttleKey, 60);

            if ($request->expectsJson() || $request->is('api/*')) {
                return response()->json([
                    'success' => false,
                    'message' => 'Usuário ou senha incorretos.',
                ], 401);
            }

            return redirect('/login')->withErrors(['login' => 'Usuário ou senha incorretos.']);
        }

        RateLimiter::clear($throttleKey);

        // Autentica na sessão web
        Auth::guard('web')->login($user, $request->boolean('remember', true));
        $request->session()->regenerate();

        // Emite token de acesso pessoal (Sanctum)
        $token = $user->createToken('simulator-access-token')->plainTextToken;

        if ($request->expectsJson() || $request->is('api/*')) {
            return response()->json([
                'success' => true,
                'message' => 'Autenticado com sucesso!',
                'token' => $token,
                'user' => [
                    'name' => $user->name,
                    'email' => $user->email,
                ],
                'redirect' => '/',
            ]);
        }

        return redirect()->to('/');
    }

    /**
     * Encerra a sessão administrativa.
     */
    public function logout(Request $request)
    {
        $user = Auth::guard('web')->user();
        if ($user && method_exists($user, 'tokens')) {
            $user->tokens()->delete();
        }

        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        if ($request->expectsJson() || $request->is('api/*')) {
            return response()->json([
                'success' => true,
                'message' => 'Sessão encerrada com sucesso.',
                'redirect' => '/login',
            ]);
        }

        return redirect()->to('/login');
    }

    /**
     * Retorna informações do usuário autenticado no momento.
     */
    public function user(Request $request)
    {
        $user = Auth::guard('web')->user();
        if (!$user) {
            return response()->json([
                'authenticated' => false,
            ], 401);
        }

        return response()->json([
            'authenticated' => true,
            'user' => [
                'name' => $user->name,
                'email' => $user->email,
            ],
        ]);
    }
}
