<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Vehicle extends Model
{
    protected $guarded = ['id'];

    protected $casts = [
        'routePoints' => 'array',
        'customAttributes' => 'array',
        'offlineBuffer' => 'array',
        'ignition' => 'boolean',
        'motion' => 'boolean',
        'manualIgnition' => 'boolean',
        'externalPowerCut' => 'boolean',
        'engineBlocked' => 'boolean',
        'towingSim' => 'boolean',
        'shadowZone' => 'boolean',
        'currentLat' => 'float',
        'currentLon' => 'float',
        'bearing' => 'float',
        'speedKmh' => 'float',
        'targetSpeedKmh' => 'float',
        'power' => 'float',
        'fuel' => 'float',
        'totalDistance' => 'float',
        'currentPointIndex' => 'integer',
        'stateTimeRemaining' => 'integer',
        'batteryTracker' => 'integer',
        'engineTemp' => 'integer',
        'rpm' => 'integer',
        'timeSinceLastSend' => 'integer',
    ];

    /**
     * Retorna a quantidade de posições retidas no buffer offline.
     */
    public function getOfflineBufferCountAttribute(): int
    {
        return is_array($this->offlineBuffer) ? count($this->offlineBuffer) : 0;
    }

    /**
     * Formata os dados para o formato esperado pelo frontend.
     */
    public function toSimulationPayload(): array
    {
        return [
            'id' => $this->uniqueId,
            'uniqueId' => $this->uniqueId,
            'name' => $this->name,
            'model' => $this->model,
            'category' => $this->category,
            'plate' => $this->plate,
            'profile' => $this->profile,
            'lat' => (float) $this->currentLat,
            'lon' => (float) $this->currentLon,
            'currentLat' => (float) $this->currentLat,
            'currentLon' => (float) $this->currentLon,
            'bearing' => round((float) $this->bearing, 1),
            'altitude' => round((float) $this->altitude, 1),
            'state' => $this->state,
            'speedKmh' => round((float) $this->speedKmh, 1),
            'ignition' => (bool) $this->ignition,
            'power' => round((float) $this->power, 1),
            'batteryTracker' => (int) $this->batteryTracker,
            'fuel' => round((float) $this->fuel, 1),
            'totalDistance' => round((float) $this->totalDistance, 1),
            'engineTemp' => (int) $this->engineTemp,
            'rpm' => (int) $this->rpm,
            'manualIgnition' => $this->manualIgnition,
            'externalPowerCut' => (bool) $this->externalPowerCut,
            'engineBlocked' => (bool) $this->engineBlocked,
            'towingSim' => (bool) $this->towingSim,
            'shadowZone' => (bool) $this->shadowZone,
            'offlineBufferCount' => $this->offline_buffer_count,
            'pendingAlarm' => $this->pendingAlarm,
            'routePoints' => $this->routePoints ?? [],
        ];
    }
}
