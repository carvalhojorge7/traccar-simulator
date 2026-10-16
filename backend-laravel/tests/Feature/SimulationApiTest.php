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

    public function test_delete_imported_vehicle_preserves_in_traccar_and_removes_from_simulator(): void
    {
        $mockTraccar = $this->mock(\App\Services\TraccarService::class);
        $mockTraccar->shouldNotReceive('deleteDevice');

        $imported = Vehicle::create([
            'uniqueId' => '999111222',
            'name' => 'Real Tracker Imported',
            'model' => 'Teltonika',
            'category' => 'car',
            'isImported' => true,
        ]);

        $res = $this->deleteJson("/api/simulation/vehicles/{$imported->uniqueId}");

        $res->assertStatus(200)
            ->assertJson([
                'success' => true,
                'uniqueId' => '999111222',
                'isImported' => true,
                'removedFromSimulation' => true,
                'removedFromTraccar' => false,
            ]);

        $this->assertNull(Vehicle::where('uniqueId', '999111222')->first());
    }

    public function test_delete_fake_vehicle_removes_from_simulator_and_traccar(): void
    {
        \Illuminate\Support\Facades\Cache::put('traccar_config', [
            'restUrl' => 'http://localhost:8082',
            'username' => 'admin',
            'password' => 'admin',
        ]);

        $mockTraccar = $this->mock(\App\Services\TraccarService::class);
        $mockTraccar->shouldReceive('deleteDevice')
            ->once()
            ->with('http://localhost:8082', 'admin', 'admin', '888222333')
            ->andReturn(['success' => true, 'message' => 'Dispositivo removido do Traccar.']);

        $fake = Vehicle::create([
            'uniqueId' => '888222333',
            'name' => 'Fake Simulator Vehicle',
            'model' => 'OsmAnd',
            'category' => 'car',
            'isImported' => false,
        ]);

        $res = $this->deleteJson("/api/simulation/vehicles/{$fake->uniqueId}");

        $res->assertStatus(200)
            ->assertJson([
                'success' => true,
                'uniqueId' => '888222333',
                'isImported' => false,
                'removedFromSimulation' => true,
                'removedFromTraccar' => true,
            ]);

        $this->assertNull(Vehicle::where('uniqueId', '888222333')->first());
    }

    public function test_delete_batch_segregates_imported_and_fake_vehicles(): void
    {
        \Illuminate\Support\Facades\Cache::put('traccar_config', [
            'restUrl' => 'http://localhost:8082',
            'username' => 'admin',
            'password' => 'admin',
        ]);

        $mockTraccar = $this->mock(\App\Services\TraccarService::class);
        // Deve chamar deleteDevice APENAS para o fake
        $mockTraccar->shouldReceive('deleteDevice')
            ->once()
            ->with('http://localhost:8082', 'admin', 'admin', 'FAKE_01')
            ->andReturn(['success' => true]);

        Vehicle::create([
            'uniqueId' => 'FAKE_01',
            'name' => 'Fake 1',
            'isImported' => false,
        ]);
        Vehicle::create([
            'uniqueId' => 'REAL_01',
            'name' => 'Real 1',
            'isImported' => true,
        ]);

        $res = $this->postJson('/api/simulation/vehicles/delete-batch', [
            'uniqueIds' => ['FAKE_01', 'REAL_01'],
        ]);

        $res->assertStatus(200)
            ->assertJson([
                'success' => true,
                'removedCount' => 2,
                'removedFakesFromTraccar' => ['FAKE_01'],
                'preservedInTraccar' => ['REAL_01'],
            ]);

        $this->assertEquals(0, Vehicle::count());
    }
}
