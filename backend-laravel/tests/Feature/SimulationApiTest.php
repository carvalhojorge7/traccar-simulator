<?php

namespace Tests\Feature;

use Tests\TestCase;
use Illuminate\Foundation\Testing\RefreshDatabase;
use App\Models\Vehicle;

class SimulationApiTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $user = \App\Models\User::firstOrCreate(
            ['name' => 'admin'],
            ['email' => 'admin@simulator.local', 'password' => \Illuminate\Support\Facades\Hash::make('admin')]
        );
        $this->actingAs($user);
    }

    public function test_simulation_status_returns_successful_structure(): void
    {
        $response = $this->getJson('/api/simulation/status');

        $response->assertStatus(200)
            ->assertJsonStructure([
                'isRunning',
                'isPaused',
                'timeMultiplier',
                'vehiclesCount',
                'vehicles',
            ]);
    }

    public function test_setup_fleet_creates_vehicles_in_database(): void
    {
        $payload = [
            'vehiclesCount' => 2,
            'selectedModel' => 'OsmAnd',
            'centerLat' => -23.5505,
            'centerLon' => -46.6333,
            'radiusKm' => 5,
            'createInTraccar' => false, // sem mockar API externa Traccar no teste unitário
        ];

        $response = $this->postJson('/api/simulation/setup-fleet', $payload);

        $response->assertStatus(200)
            ->assertJson(['success' => true]);

        $this->assertEquals(2, Vehicle::count());
    }

    public function test_sensor_updates_and_scenarios(): void
    {
        $vehicle = Vehicle::create([
            'uniqueId' => '867111222333444',
            'name' => 'Teste Carro',
            'model' => 'OsmAnd',
            'category' => 'car',
            'plate' => 'BRA1A23',
            'profile' => 'CAR',
            'routePoints' => [
                ['lat' => -23.55, 'lon' => -46.63],
                ['lat' => -23.56, 'lon' => -46.64],
            ],
            'currentLat' => -23.55,
            'currentLon' => -46.63,
            'speedKmh' => 50,
            'ignition' => true,
        ]);

        // Testa atualização de sensores
        $sensorRes = $this->postJson("/api/simulation/vehicles/{$vehicle->uniqueId}/sensors", [
            'externalPowerCut' => true,
            'engineBlocked' => true,
        ]);

        $sensorRes->assertStatus(200)
            ->assertJson([
                'success' => true,
                'sensors' => [
                    'externalPowerCut' => true,
                    'engineBlocked' => true,
                ]
            ]);

        $vehicle->refresh();
        $this->assertTrue($vehicle->externalPowerCut);
        $this->assertTrue($vehicle->engineBlocked);
        $this->assertEquals(0, $vehicle->speedKmh);

        // Testa exclusão
        $delRes = $this->deleteJson("/api/simulation/vehicles/{$vehicle->uniqueId}");
        $delRes->assertStatus(200)
            ->assertJson(['success' => true]);

        $this->assertEquals(0, Vehicle::count());
    }

    public function test_incoming_command_endpoint_reflects_engine_stop_and_resume(): void
    {
        $vehicle = Vehicle::create([
            'uniqueId' => '867999888777666',
            'name' => 'Fiat Toro - HYJ9090',
            'model' => 'OsmAnd',
            'category' => 'car',
            'plate' => 'HYJ9090',
            'profile' => 'CAR',
            'routePoints' => [
                ['lat' => -3.70, 'lon' => -38.47],
                ['lat' => -3.71, 'lon' => -38.48],
            ],
            'currentLat' => -3.70,
            'currentLon' => -38.47,
            'speedKmh' => 60,
            'ignition' => true,
            'engineBlocked' => false,
        ]);

        // 1. Simula envio de comando de bloqueio (engineStop)
        $stopRes = $this->postJson('/api/traccar/commands/incoming', [
            'uniqueId' => $vehicle->uniqueId,
            'type' => 'engineStop',
        ]);

        $stopRes->assertStatus(200)
            ->assertJson([
                'success' => true,
                'action' => 'blocked',
            ]);

        $vehicle->refresh();
        $this->assertTrue($vehicle->engineBlocked);
        $this->assertFalse($vehicle->ignition);
        $this->assertEquals(0, $vehicle->speedKmh);

        // 2. Simula envio de comando de desbloqueio (engineResume)
        $resumeRes = $this->postJson('/api/traccar/commands/incoming', [
            'uniqueId' => $vehicle->uniqueId,
            'type' => 'engineResume',
        ]);

        $resumeRes->assertStatus(200)
            ->assertJson([
                'success' => true,
                'action' => 'unblocked',
            ]);

        $vehicle->refresh();
        $this->assertFalse($vehicle->engineBlocked);
        $this->assertTrue($vehicle->ignition);
        $this->assertTrue($vehicle->motion);
    }

    public function test_simulation_engine_processes_raw_command_text_from_osmand_response(): void
    {
        $vehicle = Vehicle::create([
            'uniqueId' => '867555444333222',
            'name' => 'VW Polo - SAL1P30',
            'model' => 'OsmAnd',
            'category' => 'car',
            'plate' => 'SAL1P30',
            'profile' => 'CAR',
            'routePoints' => [
                ['lat' => -3.70, 'lon' => -38.47],
                ['lat' => -3.71, 'lon' => -38.48],
            ],
            'currentLat' => -3.70,
            'currentLon' => -38.47,
            'speedKmh' => 70,
            'ignition' => true,
            'engineBlocked' => false,
        ]);

        $engine = app(\App\Services\SimulationEngine::class);

        // Bloqueio retornado no corpo HTTP OsmAnd
        $engine->processRawCommandText($vehicle, 'engineStop', 'localhost', 5055);
        $vehicle->refresh();
        $this->assertTrue($vehicle->engineBlocked);
        $this->assertFalse($vehicle->ignition);

        // Desbloqueio retornado no corpo HTTP OsmAnd
        $engine->processRawCommandText($vehicle, 'engineResume', 'localhost', 5055);
        $vehicle->refresh();
        $this->assertFalse($vehicle->engineBlocked);
        $this->assertTrue($vehicle->ignition);
    }
}
