<?php

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\SimulationController;

// 1. Traccar Conectividade, Configuração & Diagnóstico
Route::get('/traccar/config', [SimulationController::class, 'getTraccarConfig']);
Route::post('/traccar/config', [SimulationController::class, 'saveTraccarConfig']);
Route::post('/traccar/test', [SimulationController::class, 'testTraccarConnection']);
Route::post('/traccar/test-osmand', [SimulationController::class, 'testOsmAnd']);
Route::post('/traccar/test-port', [SimulationController::class, 'testCustomPort']);
Route::post('/traccar/test-create-device', [SimulationController::class, 'testCreateDevice']);
Route::delete('/traccar/devices/{id}', [SimulationController::class, 'deleteTraccarDevice']);
Route::post('/traccar/analyze', [SimulationController::class, 'analyzeTraccar']);

// 1.1 Computed Attributes & Importação de Dispositivos Remotos
Route::match(['get', 'post'], '/traccar/computed-attributes', [SimulationController::class, 'getComputedAttributes']);
Route::match(['get', 'post'], '/traccar/remote-devices', [SimulationController::class, 'listRemoteDevices']);
Route::post('/traccar/import-device', [SimulationController::class, 'importRemoteDevice']);
Route::get('/simulation/attributes/config', [SimulationController::class, 'getSimulationAttributes']);
Route::post('/simulation/attributes/config', [SimulationController::class, 'saveSimulationAttributes']);

// 1.2 Gerenciamento de Protocolos e Portas
Route::get('/traccar/protocols', [SimulationController::class, 'listProtocols']);
Route::post('/traccar/protocols', [SimulationController::class, 'createProtocol']);
Route::match(['put', 'post'], '/traccar/protocols/{id}', [SimulationController::class, 'updateProtocol']);
Route::post('/traccar/protocols/{id}/reset', [SimulationController::class, 'resetProtocol']);
Route::delete('/traccar/protocols/{id}', [SimulationController::class, 'deleteProtocol']);

// 2. Simulação - Frota & Ciclo de Vida
Route::post('/simulation/setup-fleet', [SimulationController::class, 'setupFleet']);
Route::post('/simulation/start', [SimulationController::class, 'start']);
Route::post('/simulation/pause', [SimulationController::class, 'pause']);
Route::post('/simulation/resume', [SimulationController::class, 'resume']);
Route::post('/simulation/stop', [SimulationController::class, 'stop']);
Route::post('/simulation/speed', [SimulationController::class, 'speed']);

// 3. Simulação - Remoção de Veículos
Route::delete('/simulation/vehicles/{uniqueId}', [SimulationController::class, 'deleteVehicle']);
Route::post('/simulation/vehicles/delete-batch', [SimulationController::class, 'deleteBatchVehicles']);
Route::delete('/simulation/vehicles', [SimulationController::class, 'clearAllVehicles']);

// 4. Cockpit - Sensores, Cenários, Alarmes & Buffer Offline
Route::post('/simulation/vehicles/{uniqueId}/sensors', [SimulationController::class, 'updateSensors']);
Route::post('/simulation/vehicles/{uniqueId}/scenario', [SimulationController::class, 'triggerScenario']);
Route::post('/simulation/vehicles/{uniqueId}/alarm', [SimulationController::class, 'triggerAlarm']);
Route::post('/simulation/vehicles/{uniqueId}/flush-shadow', [SimulationController::class, 'flushShadow']);

// 5. Estado & Streaming em Tempo Real (SSE)
Route::get('/simulation/status', [SimulationController::class, 'status']);
Route::get('/simulation/events', [SimulationController::class, 'events']);
