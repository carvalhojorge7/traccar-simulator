<?php

namespace Tests\Feature;

use Tests\TestCase;
use Illuminate\Foundation\Testing\RefreshDatabase;
use App\Models\User;
use Illuminate\Support\Facades\Config;
use Illuminate\Support\Facades\Hash;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Config::set('auth.admin.user', 'testadmin');
        Config::set('auth.admin.password', 'secret123');
    }

    public function test_login_page_is_accessible_to_guests(): void
    {
        $response = $this->get('/login');

        $response->assertStatus(200);
    }

    public function test_login_page_redirects_to_home_if_already_authenticated(): void
    {
        $user = User::create([
            'name' => 'testadmin',
            'email' => 'testadmin@simulator.local',
            'password' => Hash::make('secret123'),
        ]);

        $response = $this->actingAs($user)->get('/login');

        $response->assertStatus(302)
            ->assertRedirect('/');
    }

    public function test_unauthenticated_api_request_returns_401(): void
    {
        $response = $this->getJson('/api/simulation/status');

        $response->assertStatus(401)
            ->assertJson([
                'code' => 401,
            ]);
    }

    public function test_login_fails_with_invalid_credentials(): void
    {
        $response = $this->postJson('/api/auth/login', [
            'login' => 'testadmin',
            'password' => 'wrongpassword',
        ]);

        $response->assertStatus(401)
            ->assertJson([
                'success' => false,
            ]);

        $this->assertGuest();
    }

    public function test_login_succeeds_with_configured_admin_credentials(): void
    {
        $response = $this->postJson('/api/auth/login', [
            'login' => 'testadmin',
            'password' => 'secret123',
        ]);

        $response->assertStatus(200)
            ->assertJson([
                'success' => true,
                'user' => [
                    'name' => 'testadmin',
                ],
            ])
            ->assertJsonStructure([
                'token',
                'redirect',
            ]);

        $this->assertAuthenticated();

        // Verifica criação/sincronização no banco de dados SQLite
        $this->assertDatabaseHas('users', [
            'name' => 'testadmin',
        ]);
    }

    public function test_authenticated_session_can_access_protected_api(): void
    {
        $loginRes = $this->postJson('/api/auth/login', [
            'login' => 'testadmin',
            'password' => 'secret123',
        ]);

        $loginRes->assertStatus(200);

        $statusRes = $this->getJson('/api/simulation/status');
        $statusRes->assertStatus(200)
            ->assertJsonStructure(['isRunning', 'vehiclesCount']);
    }

    public function test_bearer_token_authenticates_protected_api(): void
    {
        $user = User::create([
            'name' => 'tokenuser',
            'email' => 'tokenuser@simulator.local',
            'password' => Hash::make('secret123'),
        ]);

        $token = $user->createToken('test-token')->plainTextToken;

        $response = $this->withHeaders([
            'Authorization' => 'Bearer ' . $token,
        ])->getJson('/api/simulation/status');

        $response->assertStatus(200);
    }

    public function test_http_basic_auth_authenticates_with_env_admin_credentials(): void
    {
        $response = $this->withHeaders([
            'Authorization' => 'Basic ' . base64_encode('testadmin:secret123'),
        ])->getJson('/api/simulation/status');

        $response->assertStatus(200);
    }

    public function test_query_token_authenticates_for_sse_stream(): void
    {
        $user = User::create([
            'name' => 'sseuser',
            'email' => 'sseuser@simulator.local',
            'password' => Hash::make('secret123'),
        ]);

        $token = $user->createToken('sse-token')->plainTextToken;

        $response = $this->get('/api/simulation/status?token=' . $token);

        $response->assertStatus(200);
    }

    public function test_logout_terminates_session(): void
    {
        $this->postJson('/api/auth/login', [
            'login' => 'testadmin',
            'password' => 'secret123',
        ])->assertStatus(200);

        $this->assertAuthenticated();

        $logoutRes = $this->postJson('/api/auth/logout');
        $logoutRes->assertStatus(200)
            ->assertJson([
                'success' => true,
                'redirect' => '/login',
            ]);

        $this->assertGuest();
    }
}
