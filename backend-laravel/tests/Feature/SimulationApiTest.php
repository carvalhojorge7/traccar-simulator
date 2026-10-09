<?php

namespace Tests\Feature;

use Tests\TestCase;
use Illuminate\Foundation\Testing\RefreshDatabase;
use App\Models\Vehicle;

class SimulationApiTest extends TestCase
{
    use RefreshDatabase;

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
}
