<?php

namespace Tests\Feature;

use Tests\TestCase;
use Illuminate\Foundation\Testing\RefreshDatabase;
use App\Models\User;
use Illuminate\Support\Facades\Hash;

class ExampleTest extends TestCase
{
    use RefreshDatabase;

    public function test_unauthenticated_request_to_root_redirects_to_login(): void
    {
        $response = $this->get('/');

        $response->assertStatus(302)
            ->assertRedirect('/login');
    }

    public function test_authenticated_user_can_access_panel(): void
    {
        $user = User::create([
            'name' => 'admin',
            'email' => 'admin@simulator.local',
            'password' => Hash::make('admin'),
        ]);

        $response = $this->actingAs($user)->get('/');

        $response->assertStatus(200);
    }
}
