<?php

namespace App\Http\Middleware;

use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Laravel\Sanctum\PersonalAccessToken;
use Symfony\Component\HttpFoundation\Response;

class SimulatorAuthMiddleware
{
    /**
     * Intercepta requisições e garante que apenas usuários autenticados acessem o painel e APIs.
     */
    public function handle(Request $request, Closure $next): Response
    {
        // 1. Já autenticado na sessão web do Laravel
        if (Auth::guard('web')->check()) {
            return $next($request);
        }

        // 2. Token de acesso pessoal (Bearer header, X-Auth-Token ou query parameter 'token' para SSE)
        $rawToken = $request->bearerToken() ?? $request->header('X-Auth-Token') ?? $request->query('token');
        if (!empty($rawToken)) {
            $accessToken = PersonalAccessToken::findToken($rawToken);
            if ($accessToken && $accessToken->tokenable) {
                Auth::guard('web')->login($accessToken->tokenable);
                return $next($request);
            }
        }

        // 3. Autenticação HTTP Basic Auth (admin:password via cURL / automações)
        $adminUser = config('auth.admin.user', env('ADMIN_USER', env('ADMIN_LOGIN', 'admin')));
        $adminPass = config('auth.admin.password', env('ADMIN_PASSWORD', env('ADMIN_PASS', 'admin')));

        $authUser = $request->getUser();
        $authPass = $request->getPassword();

        if (!empty($authUser) && !empty($authPass)) {
            if ($authUser === $adminUser && $authPass === $adminPass) {
                $email = str_contains($adminUser, '@') ? $adminUser : $adminUser . '@simulator.local';
                $user = User::firstOrCreate(
                    ['name' => $adminUser],
                    ['email' => $email, 'password' => Hash::make($adminPass)]
                );
                Auth::guard('web')->login($user);
                return $next($request);
            }

            // Fallback para usuário direto no banco de dados
            $dbUser = User::where('name', $authUser)->orWhere('email', $authUser)->first();
            if ($dbUser && Hash::check($authPass, $dbUser->password)) {
                Auth::guard('web')->login($dbUser);
                return $next($request);
            }
        }

        // 4. Bloqueio de Acesso Não Autorizado
        if ($request->expectsJson() || $request->is('api/*')) {
            return response()->json([
                'error' => 'Acesso não autorizado. Efetue login no painel para continuar.',
                'code' => 401,
            ], 401);
        }

        return redirect()->to('/login');
    }
}
