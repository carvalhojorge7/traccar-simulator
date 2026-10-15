<?php

namespace App\Services;

use App\Models\Vehicle;
use App\Models\TelemetryLog;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;

class SimulationEngine
{
    public function __construct(
        protected OsrmService $osrmService,
        protected TraccarService $traccarService
    ) {}

    /**
     * Retorna a velocidade máxima recomendada por perfil.
     */
    public function getProfileMaxSpeed(string $profile): float
    {
        return match (strtoupper($profile)) {
            'TRUCK' => 60.0,
            'DELIVERY' => 45.0,
            'MOTORCYCLE' => 75.0,
            default => 65.0, // CAR
        };
    }

    /**
     * Executa um ciclo (tick) de simulação física para todos os veículos da frota.
     * Retorna array com os dados para broadcast/SSE.
     */
    public function tick(float $dt = 1.0, array $traccarConfig = []): array
    {
        $dispatchedLogs = [];
        $vehiclesPayload = [];

        // Se os parâmetros de conexão não foram passados ou estão padrão, busca a configuração persistida pelo usuário
        $cachedConfig = Cache::get('traccar_config', []);
        $osmandHost = $traccarConfig['osmandHost'] ?? ($cachedConfig['osmandHost'] ?? config('services.traccar.osmand_host', 'localhost'));
        $osmandPort = (int) ($traccarConfig['osmandPort'] ?? ($cachedConfig['osmandPort'] ?? config('services.traccar.osmand_port', 5055)));
        $sendInterval = (int) ($traccarConfig['sendIntervalSeconds'] ?? ($cachedConfig['sendIntervalSeconds'] ?? 3));

        // 1. Polling de comandos pendentes no Traccar (tc_commands_queue via Postgres)
        $commandLogs = $this->pollAndProcessCommands($traccarConfig, $osmandHost, $osmandPort);
        if (!empty($commandLogs)) {
            $dispatchedLogs = array_merge($dispatchedLogs, $commandLogs);
        }

        $vehicles = Vehicle::all();

        foreach ($vehicles as $v) {
            $this->updateVehiclePhysics($v, $dt);

            $v->timeSinceLastSend = ($v->timeSinceLastSend ?? 0) + 1;

            // Se atingiu o intervalo de envio ou tem alarme pendente, despacha telemetria
            if ($v->timeSinceLastSend >= $sendInterval || !empty($v->pendingAlarm)) {
                $v->timeSinceLastSend = 0;
                $logEntry = $this->dispatchTelemetryToTraccar($v, $osmandHost, $osmandPort);
                if ($logEntry) {
                    $dispatchedLogs[] = [
                        'uniqueId' => $v->uniqueId,
                        'name' => $v->name,
                        'log' => $logEntry,
                    ];
                }
            }

            $v->save();
            $vehiclesPayload[] = $v->toSimulationPayload();
        }

        return [
            'timestamp' => (int) (microtime(true) * 1000),
            'vehicles' => $vehiclesPayload,
            'dispatchedLogs' => $dispatchedLogs,
        ];
    }

    /**
     * Atualiza a física de um veículo específico.
     */
    protected function updateVehiclePhysics(Vehicle $v, float $dt): void
    {
        $routePoints = $v->routePoints;
        if (empty($routePoints) || count($routePoints) < 2) {
            return;
        }

        // 0. Verificação de Bloqueio de Motor (Relé de Corte)
        if ($v->engineBlocked) {
            $v->speedKmh = max(0.0, $v->speedKmh - 35.0 * $dt);
            $v->motion = false;
            $v->state = 'PARKED_OFF';
            $v->ignition = false;
            $v->rpm = 0;
            $v->power = $v->externalPowerCut ? 0.0 : 12.4;
            return;
        }

        // 0.1. Verificação de Guincho / Reboque sem Ignição
        if ($v->towingSim) {
            $v->ignition = false;
            $v->state = 'MOVING';
            $v->motion = true;
            $v->speedKmh = 40.0 + sin(time() / 2.5) * 5.0;
            $v->rpm = 0;
            $v->power = $v->externalPowerCut ? 0.0 : 12.4;
            $distanceMeters = ($v->speedKmh / 3.6) * $dt;
            $v->totalDistance += $distanceMeters;
            $this->advanceAlongRoute($v, $distanceMeters);
            return;
        }

        // 0.2. Override manual de ignição
        if ($v->manualIgnition !== null) {
            $v->ignition = (bool) $v->manualIgnition;
            if (!$v->ignition) {
                $v->speedKmh = max(0.0, $v->speedKmh - 25.0 * $dt);
                $v->motion = $v->speedKmh > 0.5;
                $v->state = 'PARKED_OFF';
                $v->rpm = 0;
                $v->power = $v->externalPowerCut ? 0.0 : 12.4;
                if ($v->speedKmh > 0) {
                    $distanceMeters = ($v->speedKmh / 3.6) * $dt;
                    $v->totalDistance += $distanceMeters;
                    $this->advanceAlongRoute($v, $distanceMeters);
                }
                return;
            }
        }

        // 0.3. Corte de Alimentação Externa
        if ($v->externalPowerCut) {
            $v->power = 0.0;
            $v->batteryTracker = (int) max(5, $v->batteryTracker - (0.04 * $dt));
        }

        // 1. Processamento da máquina de estados automática
        if ($v->stateTimeRemaining > 0) {
            $v->stateTimeRemaining -= (int) round($dt);
            if ($v->stateTimeRemaining <= 0) {
                $v->state = 'MOVING';
                $v->ignition = $v->manualIgnition !== null ? (bool) $v->manualIgnition : true;
                $v->motion = true;
                if (!$v->externalPowerCut) {
                    $v->power = 13.9 + (mt_rand(0, 30) / 100.0);
                }
                $v->engineTemp = 85;
            }
        }

        // Estado Parado / Semáforo com motor ligado
        if ($v->state === 'TRAFFIC_STOP') {
            $v->speedKmh = max(0.0, $v->speedKmh - 25.0 * $dt);
            $v->motion = false;
            if (!$v->externalPowerCut) {
                $v->power = 13.6 + (mt_rand(0, 20) / 100.0);
            }
            $v->rpm = 850;
            return;
        }

        // Estado Desligado
        if ($v->state === 'PARKED_OFF') {
            $v->speedKmh = 0.0;
            $v->ignition = $v->manualIgnition !== null ? (bool) $v->manualIgnition : false;
            $v->motion = false;
            if (!$v->externalPowerCut) {
                $v->power = 12.4 + (mt_rand(0, 20) / 100.0);
            }
            $v->rpm = 0;
            $v->engineTemp = (int) max(35, $v->engineTemp - 0.5 * $dt);
            return;
        }

        // 2. Em Movimento (MOVING)
        // Chance aleatória de parada temporária de trânsito
        if ($v->manualIgnition === null && (mt_rand() / mt_getrandmax()) < (0.003 * $dt)) {
            $v->state = 'TRAFFIC_STOP';
            $v->stateTimeRemaining = (int) (15 + mt_rand(0, 30)); // 15 a 45s
            return;
        }

        $maxSpeed = $this->getProfileMaxSpeed($v->profile);
        $target = $maxSpeed + (sin(time() / 4.0) * 8.0);

        if ($v->speedKmh < $target) {
            $v->speedKmh = min($target, $v->speedKmh + 8.0 * $dt);
        } else {
            $v->speedKmh = max($target, $v->speedKmh - 10.0 * $dt);
        }

        if ($v->manualIgnition === null) {
            $v->ignition = true;
        }
        $v->motion = $v->speedKmh > 1.0;
        if (!$v->externalPowerCut) {
            $v->power = 14.0 + ((mt_rand(-10, 10)) / 100.0);
        }
        $v->rpm = (int) (1200 + ($v->speedKmh * 30.0));
        $v->engineTemp = (int) min(92, 82 + ($v->speedKmh * 0.15));

        $distanceMeters = ($v->speedKmh / 3.6) * $dt;
        $v->totalDistance += $distanceMeters;
        $v->fuel = max(5.0, $v->fuel - ($distanceMeters / 100000.0));

        $this->advanceAlongRoute($v, $distanceMeters);
    }

    /**
     * Avança a posição geográfica do veículo ao longo dos waypoints da rota.
     */
    protected function advanceAlongRoute(Vehicle $v, float $distanceToMove): void
    {
        $routePoints = $v->routePoints;
        $count = count($routePoints);
        $remainingDist = $distanceToMove;

        while ($remainingDist > 0 && $v->currentPointIndex < $count - 1) {
            $p1 = $routePoints[$v->currentPointIndex];
            $p2 = $routePoints[$v->currentPointIndex + 1];

            $segmentDist = $this->osrmService->calculateDistance(
                (float) $p1['lat'], (float) $p1['lon'],
                (float) $p2['lat'], (float) $p2['lon']
            );

            if ($segmentDist <= 0.5) {
                $v->currentPointIndex++;
                $v->progressInSegment = 0.0;
                continue;
            }

            $currentSegmentProgressDist = $v->progressInSegment * $segmentDist;
            $distNeededToEndOfSegment = $segmentDist - $currentSegmentProgressDist;

            if ($remainingDist < $distNeededToEndOfSegment) {
                $v->progressInSegment += ($remainingDist / $segmentDist);
                $v->currentLat = (float) $p1['lat'] + ((float) $p2['lat'] - (float) $p1['lat']) * $v->progressInSegment;
                $v->currentLon = (float) $p1['lon'] + ((float) $p2['lon'] - (float) $p1['lon']) * $v->progressInSegment;
                $v->bearing = $this->osrmService->calculateBearing(
                    (float) $p1['lat'], (float) $p1['lon'],
                    (float) $p2['lat'], (float) $p2['lon']
                );
                $remainingDist = 0.0;
            } else {
                $remainingDist -= $distNeededToEndOfSegment;
                $v->currentPointIndex++;
                $v->progressInSegment = 0.0;
                $v->currentLat = (float) $p2['lat'];
                $v->currentLon = (float) $p2['lon'];

                if ($v->currentPointIndex < $count - 1) {
                    $nextP = $routePoints[$v->currentPointIndex + 1];
                    $newBearing = $this->osrmService->calculateBearing(
                        (float) $p2['lat'], (float) $p2['lon'],
                        (float) $nextP['lat'], (float) $nextP['lon']
                    );
                    $bearingDiff = abs($newBearing - $v->bearing);
                    if ($bearingDiff > 45 && $bearingDiff < 315) {
                        $v->speedKmh = max(18.0, $v->speedKmh * 0.6);
                    }
                    $v->bearing = $newBearing;
                }
            }
        }

        // Se chegou ao fim da rota, inverte o trajeto para circulação contínua
        if ($v->currentPointIndex >= $count - 1) {
            $v->routePoints = array_reverse($routePoints);
            $v->currentPointIndex = 0;
            $v->progressInSegment = 0.0;
        }
    }

    /**
     * Envia telemetria para o Traccar ou acumula em buffer offline.
     */
    public function dispatchTelemetryToTraccar(Vehicle $v, string $host, int $port): ?array
    {
        $jitterLat = (mt_rand() / mt_getrandmax() - 0.5) * 0.00003;
        $jitterLon = (mt_rand() / mt_getrandmax() - 0.5) * 0.00003;

        $payload = [
            'uniqueId' => $v->uniqueId,
            'lat' => $v->currentLat + $jitterLat,
            'lon' => $v->currentLon + $jitterLon,
            'timestamp' => time(),
            'speedKnots' => ($v->speedKmh * 0.539957),
            'bearing' => $v->bearing,
            'altitude' => $v->altitude,
            'accuracy' => (4.0 + (mt_rand() / mt_getrandmax()) * 2.5),
            'batteryTracker' => (int) round($v->batteryTracker),
            'ignition' => (bool) $v->ignition,
            'motion' => (bool) $v->motion,
            'power' => $v->externalPowerCut ? 0.0 : $v->power,
            'totalDistance' => $v->totalDistance,
            'attributes' => array_merge([
                'fuel' => (int) round($v->fuel),
                'temperature' => (int) round($v->engineTemp),
                'rpm' => $v->rpm,
            ], $v->customAttributes ?? []),
        ];

        if (!empty($v->pendingAlarm)) {
            $payload['attributes']['alarm'] = $v->pendingAlarm;
            $v->pendingAlarm = null;
        }
        $payload['attributes']['blocked'] = (bool) $v->engineBlocked;
        if ($v->externalPowerCut) {
            $payload['attributes']['powerCut'] = true;
        }
        if ($v->towingSim) {
            $payload['attributes']['alarm'] = 'tow';
        }

        // Se estiver em Zona de Sombra: armazena em buffer de memória e não despacha
        if ($v->shadowZone) {
            $buffer = $v->offlineBuffer ?? [];
            $payload['attributes']['shadowZone'] = true;
            $buffer[] = $payload;
            if (count($buffer) > 500) {
                array_shift($buffer);
            }
            $v->offlineBuffer = $buffer;

            $logEntry = [
                'uniqueId' => $v->uniqueId,
                'name' => $v->name,
                'plate' => $v->plate,
                'time' => date('H:i:s'),
                'timestamp' => (int) (microtime(true) * 1000),
                'success' => true,
                'status' => 200,
                'speedKmh' => (float) round($v->speedKmh),
                'ignition' => (bool) $v->ignition,
                'power' => number_format($v->externalPowerCut ? 0.0 : $v->power, 1, '.', ''),
                'lat' => (float) round($v->currentLat + $jitterLat, 5),
                'lon' => (float) round($v->currentLon + $jitterLon, 5),
                'request_url' => '[OFFLINE_BUFFER]',
                'payload' => $payload,
                'response' => "[ZONA DE SOMBRA] Retido em fila offline (#" . count($buffer) . ")",
            ];

            TelemetryLog::create($logEntry);
            return $logEntry;
        }

        $result = $this->traccarService->sendOsmAndTelemetry($host, $port, $payload);

        // Se o Traccar retornou texto de comando na resposta HTTP do OsmAnd (ex: custom command engineStop/engineResume)
        if (!empty($result['response']) && is_string($result['response'])) {
            $rawResp = trim($result['response']);
            if ($rawResp !== '' && $rawResp !== 'OK' && !str_starts_with($rawResp, '<')) {
                $this->processRawCommandText($v, $rawResp, $host, $port);
            }
        }

        $logEntry = [
            'uniqueId' => $v->uniqueId,
            'name' => $v->name,
            'plate' => $v->plate,
            'time' => date('H:i:s'),
            'timestamp' => (int) (microtime(true) * 1000),
            'success' => $result['success'],
            'status' => $result['status'] ?? 500,
            'speedKmh' => (float) round($v->speedKmh),
            'ignition' => (bool) $v->ignition,
            'power' => number_format($v->externalPowerCut ? 0.0 : $v->power, 1, '.', ''),
            'lat' => (float) round($v->currentLat + $jitterLat, 5),
            'lon' => (float) round($v->currentLon + $jitterLon, 5),
            'request_url' => $result['url'] ?? null,
            'payload' => $payload,
            'response' => $result['response'] ?? ($result['error'] ?? null),
        ];

        TelemetryLog::create($logEntry);

        // Limita o histórico na tabela para 100 últimos registros
        if (TelemetryLog::count() > 100) {
            TelemetryLog::orderBy('id', 'asc')->limit(10)->delete();
        }

        return $logEntry;
    }

    /**
     * Descarrega o buffer acumulado de uma zona de sombra em rajada (burst).
     */
    public function flushShadowBuffer(string $uniqueId, string $host, int $port): array
    {
        $v = Vehicle::where('uniqueId', $uniqueId)->first();
        if (!$v || empty($v->offlineBuffer)) {
            return ['count' => 0];
        }

        $queue = $v->offlineBuffer;
        $v->offlineBuffer = [];
        $v->save();

        $sent = 0;
        foreach ($queue as $item) {
            try {
                $this->traccarService->sendOsmAndTelemetry($host, $port, $item);
                $sent++;
            } catch (\Throwable $e) {
                Log::warning("Erro no descarregamento da zona de sombra: " . $e->getMessage());
            }
        }

        $logEntry = [
            'uniqueId' => $v->uniqueId,
            'name' => $v->name,
            'plate' => $v->plate,
            'time' => date('H:i:s'),
            'timestamp' => (int) (microtime(true) * 1000),
            'success' => true,
            'status' => 200,
            'speedKmh' => (float) round($v->speedKmh),
            'ignition' => (bool) $v->ignition,
            'power' => number_format($v->externalPowerCut ? 0.0 : $v->power, 1, '.', ''),
            'lat' => (float) round($v->currentLat, 5),
            'lon' => (float) round($v->currentLon, 5),
            'request_url' => '[FLUSH_BURST]',
            'payload' => ['flushedCount' => $sent],
            'response' => "[RECONECTADO] Rajada de {$sent} pacotes offline descarregada com sucesso",
        ];

        TelemetryLog::create($logEntry);

        return ['count' => $sent];
    }

    /**
     * Aplica comandos manuais de sensores e relés no veículo.
     */
    public function setVehicleSensor(string $uniqueId, array $updates, string $host, int $port): ?Vehicle
    {
        $v = Vehicle::where('uniqueId', $uniqueId)->first();
        if (!$v) return null;

        if (array_key_exists('ignition', $updates)) {
            $v->manualIgnition = $updates['ignition'];
            if ($updates['ignition'] === true) {
                $v->ignition = true;
                if ($v->state === 'PARKED_OFF') $v->state = 'TRAFFIC_STOP';
            } elseif ($updates['ignition'] === false) {
                $v->ignition = false;
                $v->speedKmh = 0.0;
                $v->motion = false;
                $v->state = 'PARKED_OFF';
            }
        }

        if (array_key_exists('externalPowerCut', $updates)) {
            $v->externalPowerCut = (bool) $updates['externalPowerCut'];
            if ($v->externalPowerCut) {
                $v->power = 0.0;
                $v->pendingAlarm = 'powerCut';
            } else {
                $v->power = 13.8;
            }
        }

        if (array_key_exists('engineBlocked', $updates)) {
            $prevBlocked = (bool) $v->engineBlocked;
            $v->engineBlocked = (bool) $updates['engineBlocked'];
            if ($v->engineBlocked) {
                $v->speedKmh = 0.0;
                $v->motion = false;
                $v->state = 'PARKED_OFF';
                $v->ignition = false;
            } elseif ($prevBlocked && !$v->engineBlocked) {
                // Ao desbloquear, se a ignição não foi forçada manualmente para falso, reativa o veículo
                if ($v->manualIgnition !== false) {
                    $v->ignition = true;
                    $v->state = 'MOVING';
                    $v->motion = true;
                    $v->power = 13.8;
                }
            }
        }

        if (array_key_exists('towingSim', $updates)) {
            $v->towingSim = (bool) $updates['towingSim'];
            if ($v->towingSim) {
                $v->ignition = false;
                $v->speedKmh = 40.0;
                $v->motion = true;
                $v->pendingAlarm = 'tow';
            }
        }

        if (array_key_exists('shadowZone', $updates)) {
            $prev = (bool) $v->shadowZone;
            $v->shadowZone = (bool) $updates['shadowZone'];
            if ($prev && !$v->shadowZone && !empty($v->offlineBuffer)) {
                $this->flushShadowBuffer($uniqueId, $host, $port);
            }
        }

        $v->save();
        $this->dispatchTelemetryToTraccar($v, $host, $port);

        return $v;
    }

    /**
     * Dispara roteiros físicos rápidos no veículo.
     */
    public function triggerVehicleScenario(string $uniqueId, string $scenarioType, string $host, int $port): ?Vehicle
    {
        $v = Vehicle::where('uniqueId', $uniqueId)->first();
        if (!$v) return null;

        switch ($scenarioType) {
            case 'accel_0_100':
                $v->speedKmh = 100.0;
                $v->targetSpeedKmh = 100.0;
                $v->ignition = true;
                $v->motion = true;
                $v->state = 'MOVING';
                $v->rpm = 5500;
                break;

            case 'brake_100_0':
                $v->speedKmh = 0.0;
                $v->targetSpeedKmh = 0.0;
                $v->state = 'TRAFFIC_STOP';
                $v->motion = false;
                $v->rpm = 850;
                break;

            case 'crash':
                $v->speedKmh = 0.0;
                $v->motion = false;
                $v->state = 'PARKED_OFF';
                $v->ignition = false;
                $v->pendingAlarm = 'shock';
                $v->rpm = 0;
                break;

            case 'warp':
                $v->currentLat += 0.05;
                $v->currentLon += 0.05;
                break;
        }

        $v->save();
        $this->dispatchTelemetryToTraccar($v, $host, $port);
        return $v;
    }

    /**
     * Dispara injeção de alarme imediato.
     */
    public function triggerVehicleAlarm(string $uniqueId, string $alarmType, string $host, int $port): ?Vehicle
    {
        $v = Vehicle::where('uniqueId', $uniqueId)->first();
        if (!$v) return null;

        $v->pendingAlarm = $alarmType;
        $v->save();
        $this->dispatchTelemetryToTraccar($v, $host, $port);
        return $v;
    }

    /**
     * Faz polling de comandos na fila do Traccar e reflete alterações físicas no simulador.
     */
    public function pollAndProcessCommands(array $traccarConfig, string $host, int $port): array
    {
        $cachedConfig = Cache::get('traccar_config', []);
        $mergedConfig = array_merge($cachedConfig, $traccarConfig);

        // Se polling foi expressamente desabilitado
        if (isset($mergedConfig['pollingEnabled']) && !$mergedConfig['pollingEnabled']) {
            return [];
        }

        $pendingCommands = $this->traccarService->pollPendingCommands($mergedConfig);
        if (empty($pendingCommands)) {
            return [];
        }

        $commandLogs = [];

        foreach ($pendingCommands as $cmd) {
            $uniqueId = (string) $cmd['uniqueId'];
            $v = Vehicle::where('uniqueId', $uniqueId)->first();
            if (!$v) {
                continue;
            }

            $type = strtolower($cmd['type'] ?? '');
            $attrs = $cmd['attributes'] ?? [];
            $dataStr = '';
            if (is_array($attrs) && !empty($attrs['data'])) {
                $dataStr = (string) $attrs['data'];
            } elseif (is_string($attrs)) {
                $dataStr = $attrs;
            }

            $actionDescription = null;

            // 1. Bloqueio de Motor (engineStop ou comando customizado com corte/bloqueio)
            if ($type === 'enginestop' || preg_match('/stop|corte|bloque|relay[,:\s]*1/i', $dataStr)) {
                $v->engineBlocked = true;
                $v->speedKmh = 0.0;
                $v->motion = false;
                $v->state = 'PARKED_OFF';
                $v->ignition = false;
                $actionDescription = "BLOQUEIO DE MOTOR aplicado via Traccar (#{$cmd['id']})";
            }
            // 2. Desbloqueio de Motor (engineResume ou comando customizado com desbloqueio/reativação)
            elseif ($type === 'engineresume' || preg_match('/resume|reativ|desbloque|relay[,:\s]*0/i', $dataStr)) {
                $v->engineBlocked = false;
                if ($v->manualIgnition !== false) {
                    $v->ignition = true;
                    $v->state = 'MOVING';
                    $v->motion = true;
                    $v->power = 13.8;
                }
                $actionDescription = "DESBLOQUEIO DE MOTOR aplicado via Traccar (#{$cmd['id']})";
            }
            // 3. Reinicialização de Dispositivo (rebootDevice)
            elseif ($type === 'rebootdevice' || preg_match('/reboot|reset/i', $dataStr)) {
                $v->batteryTracker = 100;
                $v->state = 'TRAFFIC_STOP';
                $actionDescription = "REINICIALIZAÇÃO DO RASTREADOR simulada via Traccar (#{$cmd['id']})";
            }
            // 4. Pânico / SOS / Alarme
            elseif ($type === 'alarm' || preg_match('/sos|panic|panico/i', $dataStr)) {
                $v->pendingAlarm = 'sos';
                $actionDescription = "ALARME SOS disparado via comando Traccar (#{$cmd['id']})";
            } else {
                $actionDescription = "Comando customizado recebido do Traccar: '{$cmd['type']}'" . ($dataStr ? " ({$dataStr})" : "");
            }

            $v->save();

            // Confirma o comando no Traccar para dar baixa na fila tc_commands_queue
            $this->traccarService->acknowledgeCommand((int) $cmd['id'], (int) $cmd['deviceId'], $mergedConfig);

            // Despacha telemetria atualizada imediatamente para o Traccar
            $this->dispatchTelemetryToTraccar($v, $host, $port);

            $logEntry = [
                'uniqueId' => $v->uniqueId,
                'name' => $v->name,
                'plate' => $v->plate,
                'time' => date('H:i:s'),
                'timestamp' => (int) (microtime(true) * 1000),
                'success' => true,
                'status' => 200,
                'speedKmh' => (float) round($v->speedKmh),
                'ignition' => (bool) $v->ignition,
                'power' => number_format($v->externalPowerCut ? 0.0 : $v->power, 1, '.', ''),
                'lat' => (float) round($v->currentLat, 5),
                'lon' => (float) round($v->currentLon, 5),
                'request_url' => "[TRACCAR_COMMAND_RECEIVED: {$cmd['type']}]",
                'payload' => $cmd,
                'response' => "[COMANDO REFLETIDO NO SIMULADOR] {$actionDescription}",
            ];

            TelemetryLog::create($logEntry);

            $commandLogs[] = [
                'uniqueId' => $v->uniqueId,
                'name' => $v->name,
                'log' => $logEntry,
            ];
        }

        return $commandLogs;
    }

    /**
     * Processa comandos de texto retornados na resposta HTTP do OsmAnd.
     */
    public function processRawCommandText(Vehicle $v, string $text, string $host, int $port): void
    {
        $text = trim($text);
        if ($text === '' || $text === 'OK') return;

        $actionDescription = null;

        if (preg_match('/stop|corte|bloque|relay[,:\s]*1|engineStop/i', $text)) {
            if (!$v->engineBlocked) {
                $v->engineBlocked = true;
                $v->speedKmh = 0.0;
                $v->motion = false;
                $v->state = 'PARKED_OFF';
                $v->ignition = false;
                $v->save();
                $actionDescription = "BLOQUEIO DE MOTOR via resposta OsmAnd ('{$text}')";
            }
        } elseif (preg_match('/resume|reativ|desbloque|relay[,:\s]*0|engineResume/i', $text)) {
            if ($v->engineBlocked) {
                $v->engineBlocked = false;
                if ($v->manualIgnition !== false) {
                    $v->ignition = true;
                    $v->state = 'MOVING';
                    $v->motion = true;
                    $v->power = 13.8;
                }
                $v->save();
                $actionDescription = "DESBLOQUEIO DE MOTOR via resposta OsmAnd ('{$text}')";
            }
        }

        if ($actionDescription) {
            $logEntry = [
                'uniqueId' => $v->uniqueId,
                'name' => $v->name,
                'plate' => $v->plate,
                'time' => date('H:i:s'),
                'timestamp' => (int) (microtime(true) * 1000),
                'success' => true,
                'status' => 200,
                'speedKmh' => (float) round($v->speedKmh),
                'ignition' => (bool) $v->ignition,
                'power' => number_format($v->externalPowerCut ? 0.0 : $v->power, 1, '.', ''),
                'lat' => (float) round($v->currentLat, 5),
                'lon' => (float) round($v->currentLon, 5),
                'request_url' => "[OSMAND_HTTP_COMMAND_RECEIVED]",
                'payload' => ['text' => $text],
                'response' => "[COMANDO REFLETIDO NO SIMULADOR] {$actionDescription}",
            ];

            TelemetryLog::create($logEntry);
        }
    }
}
