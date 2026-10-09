<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\StreamedResponse;
use App\Services\SimulationEngine;
use App\Services\TraccarService;
use App\Services\OsrmService;
use App\Models\Vehicle;
use App\Models\TelemetryLog;
use Illuminate\Support\Facades\Cache;

class SimulationController extends Controller
{
    public function __construct(
        protected SimulationEngine $engine,
        protected TraccarService $traccarService,
        protected OsrmService $osrmService
    ) {}

    /**
     * 0. Obtenção e Salvamento da Configuração do Traccar
     */
    public function getTraccarConfig(): JsonResponse
    {
        $default = [
            'restUrl' => 'http://localhost:8082',
            'username' => 'admin',
            'password' => 'admin',
            'osmandHost' => 'localhost',
            'osmandPort' => 5055,
            'sendIntervalSeconds' => 3,
        ];
        $config = Cache::get('traccar_config', $default);
        return response()->json([
            'success' => true,
            'config' => $config,
        ]);
    }

    public function saveTraccarConfig(Request $request): JsonResponse
    {
        $config = [
            'restUrl' => $this->traccarService->normalizeUrl($request->input('url', 'http://localhost:8082')),
            'username' => $request->input('username', 'admin'),
            'password' => $request->input('password', 'admin'),
            'osmandHost' => $request->input('osmandHost', 'localhost'),
            'osmandPort' => (int) $request->input('osmandPort', 5055),
            'sendIntervalSeconds' => (int) $request->input('sendIntervalSeconds', 3),
        ];

        Cache::forever('traccar_config', $config);

        return response()->json([
            'success' => true,
            'message' => 'Configurações salvas e ativas com sucesso no backend!',
            'config' => $config,
        ]);
    }

    /**
     * 1. Testa conectividade e autenticação com o Traccar
     */
    public function testTraccarConnection(Request $request): JsonResponse
    {
        $url = $request->input('url');
        $username = $request->input('username');
        $password = $request->input('password');

        if (!$url || !$username || !$password) {
            return response()->json(['success' => false, 'message' => 'URL, Usuário e Senha são obrigatórios.'], 400);
        }

        $res = $this->traccarService->testConnection($url, $username, $password);
        return response()->json($res, $res['success'] ? 200 : 401);
    }

    /**
     * Testa porta OsmAnd ou qualquer porta TCP/HTTP informada pelo usuário.
     */
    public function testOsmAnd(Request $request): JsonResponse
    {
        $host = $request->input('host') ?: ($request->input('osmandHost') ?: 'localhost');
        $port = (int) ($request->input('port') ?: ($request->input('osmandPort') ?: 5055));

        $res = $this->traccarService->testPortConnectivity($host, $port);
        return response()->json($res, $res['success'] ? 200 : 400);
    }

    /**
     * Testa qualquer porta TCP/HTTP customizada.
     */
    public function testCustomPort(Request $request): JsonResponse
    {
        return $this->testOsmAnd($request);
    }

    /**
     * Busca atributos calculados (Computed Attributes) de /settings/attributes (/api/attributes/computed).
     */
    public function getComputedAttributes(Request $request): JsonResponse
    {
        $url = $request->input('url');
        $username = $request->input('username');
        $password = $request->input('password');

        if (!$url || !$username || !$password) {
            $conf = Cache::get('traccar_config', []);
            $url = $conf['restUrl'] ?? 'http://localhost:8082';
            $username = $conf['username'] ?? 'admin';
            $password = $conf['password'] ?? 'admin';
        }

        $res = $this->traccarService->getComputedAttributes($url, $username, $password);
        return response()->json($res, $res['success'] ? 200 : 400);
    }

    /**
     * Lista dispositivos remotos do Traccar para importação.
     */
    public function listRemoteDevices(Request $request): JsonResponse
    {
        $url = $request->input('url');
        $username = $request->input('username');
        $password = $request->input('password');

        if (!$url || !$username || !$password) {
            $conf = Cache::get('traccar_config', []);
            $url = $conf['restUrl'] ?? 'http://localhost:8082';
            $username = $conf['username'] ?? 'admin';
            $password = $conf['password'] ?? 'admin';
        }

        $res = $this->traccarService->getRemoteDevices($url, $username, $password);
        return response()->json($res, $res['success'] ? 200 : 400);
    }

    /**
     * Retorna os parâmetros de atributos simulados configurados.
     */
    public function getSimulationAttributes(): JsonResponse
    {
        $configs = Cache::get('simulated_attributes_config', [
            'fuel' => ['key' => 'fuel', 'type' => 'number', 'enabled' => true, 'value' => '78', 'description' => 'Nível de combustível (%)'],
            'temperature' => ['key' => 'temperature', 'type' => 'number', 'enabled' => true, 'value' => '85', 'description' => 'Temperatura do motor (°C)'],
            'door' => ['key' => 'door', 'type' => 'boolean', 'enabled' => false, 'value' => 'false', 'description' => 'Sensor de porta aberta'],
            'battery' => ['key' => 'battery', 'type' => 'number', 'enabled' => true, 'value' => '96', 'description' => 'Nível de bateria do rastreador (%)'],
        ]);

        return response()->json([
            'success' => true,
            'configs' => $configs,
        ]);
    }

    /**
     * Salva os parâmetros de atributos simulados e propaga para a frota ativa.
     */
    public function saveSimulationAttributes(Request $request): JsonResponse
    {
        $configs = $request->input('configs', []);
        Cache::forever('simulated_attributes_config', $configs);

        // Aplica imediatamente nos veículos ativos para a próxima telemetria
        $activeVehicles = Vehicle::all();
        foreach ($activeVehicles as $v) {
            $attrs = (array) ($v->customAttributes ?? []);
            foreach ($configs as $k => $c) {
                if (!empty($c['enabled'])) {
                    $attrs[$k] = $c['value'] ?? ($c['suggestedValue'] ?? '');
                } else {
                    unset($attrs[$k]);
                }
            }
            $v->customAttributes = $attrs;
            $v->save();
        }

        return response()->json([
            'success' => true,
            'message' => 'Parâmetros de atributos da simulação salvos com sucesso!',
            'configs' => $configs,
        ]);
    }

    /**
     * Importa um dispositivo real do Traccar para o simulador local.
     */
    public function importRemoteDevice(Request $request): JsonResponse
    {
        $confirmedRisk = (bool) $request->input('confirmedRisk', false);
        if (!$confirmedRisk) {
            return response()->json([
                'success' => false,
                'message' => 'É obrigatório confirmar a ciência dos riscos operacionais para simular este dispositivo real.'
            ], 400);
        }

        $device = $request->input('device');
        
        // Se o frontend passou apenas o deviceId ou uniqueId, busca da instância Traccar
        if (!$device || empty($device['uniqueId'])) {
            $deviceId = $request->input('deviceId');
            $uniqueIdInput = $request->input('uniqueId');

            $url = $request->input('url');
            $username = $request->input('username');
            $password = $request->input('password');

            if (!$url || !$username || !$password) {
                $conf = Cache::get('traccar_config', []);
                $url = $conf['restUrl'] ?? 'http://localhost:8082';
                $username = $conf['username'] ?? 'admin';
                $password = $conf['password'] ?? 'admin';
            }

            $remoteList = $this->traccarService->getRemoteDevices($url, $username, $password);
            if (!empty($remoteList['devices'])) {
                foreach ($remoteList['devices'] as $d) {
                    if (($deviceId && (string)$d['id'] === (string)$deviceId) ||
                        ($uniqueIdInput && (string)$d['uniqueId'] === (string)$uniqueIdInput)) {
                        $device = $d;
                        break;
                    }
                }
            }
        }

        if (!$device || empty($device['uniqueId'])) {
            return response()->json([
                'success' => false, 
                'message' => 'Dados do dispositivo ou identificador único (uniqueId) ausentes.'
            ], 400);
        }

        $uniqueId = (string) $device['uniqueId'];
        $name = $device['name'] ?? "Dispositivo {$uniqueId}";
        $category = $device['category'] ?? 'car';
        $plate = $device['contact'] ?? ($device['plate'] ?? ('IMP' . mt_rand(1000, 9999)));
        $isTruck = ($category === 'truck');
        $profile = $isTruck ? 'TRUCK' : 'CAR';

        $centerLat = (float) $request->input('centerLat', -3.7319);
        $centerLon = (float) $request->input('centerLon', -38.5267);
        $radiusKm = (float) $request->input('radiusKm', 8);
        $protocol = $request->input('protocol', 'OsmAnd');

        // Gera trajeto circulante pelas vias da cidade selecionada
        $routeRes = $this->osrmService->generateCirculatingRoute($centerLat, $centerLon, $radiusKm, 4);
        $routePoints = $routeRes['points'] ?? [];

        $initialLat = $routePoints[0]['lat'] ?? $centerLat;
        $initialLon = $routePoints[0]['lon'] ?? $centerLon;

        $initialBearing = 0.0;
        if (count($routePoints) >= 2) {
            $initialBearing = $this->osrmService->calculateBearing(
                $routePoints[0]['lat'], $routePoints[0]['lon'],
                $routePoints[1]['lat'], $routePoints[1]['lon']
            );
        }

        $vehicle = Vehicle::updateOrCreate(
            ['uniqueId' => $uniqueId],
            [
                'name' => $name,
                'model' => $device['model'] ?? $protocol,
                'category' => $category,
                'plate' => $plate,
                'profile' => $profile,
                'routePoints' => $routePoints,
                'currentPointIndex' => 0,
                'progressInSegment' => 0.0,
                'currentLat' => $initialLat,
                'currentLon' => $initialLon,
                'bearing' => $initialBearing,
                'altitude' => 650.0 + mt_rand(0, 30),
                'state' => 'MOVING',
                'stateTimeRemaining' => 0,
                'speedKmh' => 0.0,
                'targetSpeedKmh' => $this->engine->getProfileMaxSpeed($profile),
                'ignition' => true,
                'motion' => true,
                'power' => 14.2,
                'batteryTracker' => 96,
                'fuel' => 78.0,
                'totalDistance' => (float) mt_rand(25000, 85000),
                'engineTemp' => 87,
                'rpm' => 2150,
                'customAttributes' => empty($device['attributes']) ? [] : (array) $device['attributes'],
                'manualIgnition' => null,
                'externalPowerCut' => false,
                'engineBlocked' => false,
                'towingSim' => false,
                'shadowZone' => false,
                'offlineBuffer' => [],
                'pendingAlarm' => null,
                'timeSinceLastSend' => 0,
            ]
        );

        // Sincroniza e garante persistência das credenciais do Traccar na sessão/cache
        $existingConf = Cache::get('traccar_config', []);
        $newRestUrl = $request->input('url', $existingConf['restUrl'] ?? 'http://localhost:8082');
        $newUsername = $request->input('username', $existingConf['username'] ?? 'admin');
        $newPassword = $request->input('password', $existingConf['password'] ?? 'admin');
        $newOsmandHost = $request->input('osmandHost', $existingConf['osmandHost'] ?? 'localhost');
        $newOsmandPort = (int) $request->input('osmandPort', $existingConf['osmandPort'] ?? 5055);

        Cache::forever('traccar_config', array_merge($existingConf, [
            'restUrl' => $this->traccarService->normalizeUrl($newRestUrl),
            'username' => $newUsername,
            'password' => $newPassword,
            'osmandHost' => $newOsmandHost,
            'osmandPort' => $newOsmandPort,
            'sendIntervalSeconds' => (int) ($existingConf['sendIntervalSeconds'] ?? 3),
        ]));

        Cache::put('simulation_is_paused', false);
        Cache::put('simulation_is_running', true, 60);

        return response()->json([
            'success' => true,
            'message' => "Dispositivo '{$vehicle->name}' ({$vehicle->uniqueId}) importado para a simulação com sucesso!",
            'vehicle' => $vehicle->toSimulationPayload(),
        ]);
    }

    /**
     * Lista protocolos disponíveis (padrões e cadastrados pelo usuário), aplicando customizações de porta.
     */
    public function listProtocols(): JsonResponse
    {
        $defaults = [
            'osmand' => ['id' => 'osmand', 'name' => 'OsmAnd (Padrão HTTP)', 'port' => 5055, 'defaultPort' => 5055, 'transport' => 'HTTP', 'isDefault' => true, 'description' => 'Protocolo padrão HTTP do Traccar'],
            'teltonika' => ['id' => 'teltonika', 'name' => 'Teltonika', 'port' => 5027, 'defaultPort' => 5027, 'transport' => 'TCP/UDP', 'isDefault' => true, 'description' => 'FMB920, FMB120, FMC130 e linha Teltonika'],
            'coban' => ['id' => 'coban', 'name' => 'Coban / GPS103', 'port' => 5001, 'defaultPort' => 5001, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'TK102, TK103B, GPS103 Coban'],
            'tk103' => ['id' => 'tk103', 'name' => 'TK103 Genérico', 'port' => 5002, 'defaultPort' => 5002, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'Protocolo TK103 alternativo'],
            'gt06' => ['id' => 'gt06', 'name' => 'GT06 / Concox', 'port' => 5023, 'defaultPort' => 5023, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'Concox, Accurate, Jimi GT06N'],
            'h02' => ['id' => 'h02', 'name' => 'H02', 'port' => 5013, 'defaultPort' => 5013, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'Protocolo H02 de rastreadores compactos'],
            'suntech' => ['id' => 'suntech', 'name' => 'Suntech', 'port' => 5011, 'defaultPort' => 5011, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'ST310U, ST340 e linha Suntech'],
            'queclink' => ['id' => 'queclink', 'name' => 'Queclink', 'port' => 5004, 'defaultPort' => 5004, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'GV200, GV300, GL300 Queclink'],
            'meitrack' => ['id' => 'meitrack', 'name' => 'Meitrack', 'port' => 5020, 'defaultPort' => 5020, 'transport' => 'TCP', 'isDefault' => true, 'description' => 'MVT380, T1, T333 Meitrack'],
        ];

        // Aplica overrides de portas configuradas pelo usuário para os protocolos conhecidos
        $overrides = Cache::get('protocol_port_overrides', []);
        foreach ($overrides as $protoId => $over) {
            if (isset($defaults[$protoId])) {
                if (isset($over['port'])) {
                    $defaults[$protoId]['port'] = (int) $over['port'];
                }
                if (!empty($over['transport'])) {
                    $defaults[$protoId]['transport'] = $over['transport'];
                }
                if (!empty($over['description'])) {
                    $defaults[$protoId]['description'] = $over['description'];
                }
                $defaults[$protoId]['isEdited'] = ($defaults[$protoId]['port'] !== $defaults[$protoId]['defaultPort']);
            }
        }

        $custom = Cache::get('custom_protocols', []);
        return response()->json([
            'success' => true,
            'protocols' => array_values(array_merge($defaults, $custom)),
        ]);
    }

    /**
     * Cadastra um novo protocolo e sua porta no simulador.
     */
    public function createProtocol(Request $request): JsonResponse
    {
        $name = trim($request->input('name', ''));
        $port = (int) $request->input('port', 0);
        $transport = strtoupper($request->input('transport', 'TCP'));
        $description = trim($request->input('description', ''));

        if (!$name || $port <= 0 || $port > 65535) {
            return response()->json(['success' => false, 'message' => 'Nome e Porta válida (1-65535) são obrigatórios.'], 400);
        }

        $id = 'proto_' . time() . '_' . mt_rand(100, 999);
        $custom = Cache::get('custom_protocols', []);
        $custom[$id] = [
            'id' => $id,
            'name' => $name,
            'port' => $port,
            'defaultPort' => $port,
            'transport' => $transport,
            'description' => $description ?: "Porta {$port} ({$transport})",
            'isDefault' => false,
            'isEdited' => false,
        ];
        Cache::forever('custom_protocols', $custom);

        return response()->json([
            'success' => true,
            'message' => "Protocolo '{$name}' (:{$port}) cadastrado com sucesso!",
            'protocol' => $custom[$id],
        ]);
    }

    /**
     * Atualiza a porta e parâmetros de qualquer protocolo (incluindo protocolos conhecidos/padrões).
     */
    public function updateProtocol(Request $request, string $id): JsonResponse
    {
        $port = (int) $request->input('port', 0);
        $transport = $request->input('transport');
        $description = $request->input('description');

        if ($port <= 0 || $port > 65535) {
            return response()->json(['success' => false, 'message' => 'Porta inválida (deve ser entre 1 e 65535).'], 400);
        }

        $defaults = ['osmand', 'teltonika', 'coban', 'tk103', 'gt06', 'h02', 'suntech', 'queclink', 'meitrack'];
        if (in_array($id, $defaults)) {
            $overrides = Cache::get('protocol_port_overrides', []);
            $overrides[$id] = [
                'port' => $port,
                'transport' => $transport,
                'description' => $description,
            ];
            Cache::forever('protocol_port_overrides', $overrides);

            // Se alterou a porta do OsmAnd, sincroniza a configuração geral do Traccar
            if ($id === 'osmand') {
                $conf = Cache::get('traccar_config', []);
                $conf['osmandPort'] = $port;
                Cache::put('traccar_config', $conf);
            }

            return response()->json([
                'success' => true,
                'message' => "Porta do protocolo padrão '{$id}' atualizada para :{$port} com sucesso!",
                'protocol' => [
                    'id' => $id,
                    'port' => $port,
                ],
            ]);
        }

        $custom = Cache::get('custom_protocols', []);
        if (isset($custom[$id])) {
            $custom[$id]['port'] = $port;
            if ($transport) $custom[$id]['transport'] = strtoupper($transport);
            if ($description) $custom[$id]['description'] = $description;
            Cache::forever('custom_protocols', $custom);

            return response()->json([
                'success' => true,
                'message' => "Protocolo customizado '{$custom[$id]['name']}' atualizado para :{$port} com sucesso!",
                'protocol' => $custom[$id],
            ]);
        }

        return response()->json(['success' => false, 'message' => 'Protocolo não encontrado.'], 404);
    }

    /**
     * Restaura a porta padrão de fábrica de um protocolo conhecido.
     */
    public function resetProtocol(string $id): JsonResponse
    {
        $overrides = Cache::get('protocol_port_overrides', []);
        if (isset($overrides[$id])) {
            unset($overrides[$id]);
            Cache::forever('protocol_port_overrides', $overrides);
            return response()->json(['success' => true, 'message' => "Porta de fábrica do protocolo '{$id}' restaurada."]);
        }
        return response()->json(['success' => true, 'message' => 'Protocolo já se encontra com a porta original de fábrica.']);
    }

    /**
     * Remove um protocolo customizado cadastrado.
     */
    public function deleteProtocol(string $id): JsonResponse
    {
        $custom = Cache::get('custom_protocols', []);
        if (isset($custom[$id])) {
            unset($custom[$id]);
            Cache::forever('custom_protocols', $custom);
            return response()->json(['success' => true, 'message' => 'Protocolo removido com sucesso.']);
        }
        return response()->json(['success' => false, 'message' => 'Protocolo não encontrado ou padrão do sistema.'], 404);
    }

    /**
     * Cria um dispositivo de teste no Traccar para validação fim a fim
     */
    public function testCreateDevice(Request $request): JsonResponse
    {
        $url = $request->input('url');
        $username = $request->input('username');
        $password = $request->input('password');

        if (!$url || !$username || !$password) {
            return response()->json(['success' => false, 'message' => 'URL, Usuário e Senha são obrigatórios.'], 400);
        }

        $res = $this->traccarService->testCreateDevice($url, $username, $password);
        return response()->json($res, $res['success'] ? 200 : 400);
    }

    /**
     * Exclui um dispositivo específico no Traccar (ex: dispositivo de teste)
     */
    public function deleteTraccarDevice(Request $request, int $id): JsonResponse
    {
        $url = $request->input('url');
        $username = $request->input('username');
        $password = $request->input('password');

        if (!$url || !$username || !$password) {
            $conf = Cache::get('traccar_config', []);
            $url = $conf['restUrl'] ?? 'http://localhost:8082';
            $username = $conf['username'] ?? 'admin';
            $password = $conf['password'] ?? 'admin';
        }

        $res = $this->traccarService->deleteDeviceById($url, $username, $password, $id);
        return response()->json($res, $res['success'] ? 200 : 400);
    }

    /**
     * 2. Analisa a base do Traccar
     */
    public function analyzeTraccar(Request $request): JsonResponse
    {
        $url = $request->input('url');
        $username = $request->input('username');
        $password = $request->input('password');

        if (!$url || !$username || !$password) {
            return response()->json(['success' => false, 'message' => 'URL, Usuário e Senha são obrigatórios.'], 400);
        }

        $res = $this->traccarService->analyzeInstance($url, $username, $password);
        return response()->json($res, $res['success'] ? 200 : 400);
    }

    /**
     * 3. Configuração e Criação em Massa da Frota (com rotas OSRM e Traccar)
     */
    public function setupFleet(Request $request): JsonResponse
    {
        try {
            $traccarUrl = $request->input('traccarUrl', 'http://localhost:8082');
            $traccarUser = $request->input('traccarUser', '');
            $traccarPassword = $request->input('traccarPassword', '');
            $osmandHost = $request->input('osmandHost', 'localhost');
            $osmandPort = (int) $request->input('osmandPort', 5055);
            $vehiclesCount = min(50, max(1, (int) $request->input('vehiclesCount', 5)));
            $selectedModel = $request->input('selectedModel', 'OsmAnd');
            $centerLat = (float) $request->input('centerLat', -23.5505);
            $centerLon = (float) $request->input('centerLon', -46.6333);
            $radiusKm = (float) $request->input('radiusKm', 8);
            $attributeConfigs = $request->input('attributeConfigs', []);
            $createInTraccar = (bool) $request->input('createInTraccar', true);

            // Armazena configurações para o motor
            Cache::put('traccar_config', [
                'restUrl' => $traccarUrl,
                'username' => $traccarUser,
                'password' => $traccarPassword,
                'osmandHost' => $osmandHost,
                'osmandPort' => $osmandPort,
                'sendIntervalSeconds' => 3,
            ]);

            // Modelos de veículos e placas realistas (Padrão Mercosul)
            $brazilianLetters = ['BRA', 'RIO', 'SPO', 'CUR', 'BHZ', 'SAL', 'FOR', 'POA'];
            $carModels = ['Fiat Strada', 'VW Polo', 'Chevrolet Onix', 'Hyundai HB20', 'Toyota Corolla', 'Jeep Compass', 'Renault Kwid'];
            $truckModels = ['Mercedes-Benz Accelo', 'VW Delivery', 'Volvo FH 540', 'Scania R450', 'Iveco Daily'];

            // Limpa frota anterior
            Vehicle::truncate();

            $devicesToCreate = [];
            for ($i = 0; $i < $vehiclesCount; $i++) {
                $isTruck = ($i % 4 === 3);
                $platePrefix = $brazilianLetters[array_rand($brazilianLetters)];
                $plateNumber = mt_rand(0, 9) . chr(65 + mt_rand(0, 25)) . mt_rand(10, 99);
                $plate = "{$platePrefix}{$plateNumber}";

                $vehicleNameModel = $isTruck
                    ? $truckModels[array_rand($truckModels)]
                    : $carModels[array_rand($carModels)];

                $chosenModel = ($selectedModel && $selectedModel !== 'auto') ? $selectedModel : 'OsmAnd';
                $uniqueId = '867' . mt_rand(100000000, 999999999) . mt_rand(100, 999);

                $vehicleAttributes = [];
                if (is_array($attributeConfigs)) {
                    foreach ($attributeConfigs as $key => $conf) {
                        if (($conf['mode'] ?? '') === 'range' && isset($conf['min'], $conf['max'])) {
                            $min = (float) $conf['min'];
                            $max = (float) $conf['max'];
                            $vehicleAttributes[$key] = round($min + (mt_rand() / mt_getrandmax()) * ($max - $min), 1);
                        } elseif (($conf['mode'] ?? '') === 'fixed' && isset($conf['value'])) {
                            $vehicleAttributes[$key] = $conf['value'];
                        } elseif (($conf['mode'] ?? '') === 'list' && !empty($conf['list'])) {
                            $vehicleAttributes[$key] = $conf['list'][array_rand($conf['list'])];
                        } elseif (isset($conf['value'])) {
                            $vehicleAttributes[$key] = $conf['value'];
                        }
                    }
                }

                $devicesToCreate[] = [
                    'name' => "{$vehicleNameModel} - {$plate}",
                    'uniqueId' => $uniqueId,
                    'model' => $chosenModel,
                    'category' => $isTruck ? 'truck' : 'car',
                    'plate' => $plate,
                    'attributes' => $vehicleAttributes,
                ];
            }

            // Provisiona no Traccar se solicitado
            $provisionResults = ['created' => [], 'failed' => []];
            if ($createInTraccar && $traccarUrl && $traccarUser && $traccarPassword) {
                $provisionResults = $this->traccarService->createBatchDevices(
                    $traccarUrl, $traccarUser, $traccarPassword, $devicesToCreate
                );
            }

            // Cria veículos com rotas reais no banco
            $createdVehicles = [];
            foreach ($devicesToCreate as $i => $dev) {
                $isTruck = ($dev['category'] === 'truck');
                $profile = $isTruck ? 'TRUCK' : ($i % 3 === 1 ? 'DELIVERY' : 'CAR');

                $routeRes = $this->osrmService->generateCirculatingRoute($centerLat, $centerLon, $radiusKm, 4);
                $routePoints = $routeRes['points'] ?? [];

                $initialLat = $routePoints[0]['lat'] ?? $centerLat;
                $initialLon = $routePoints[0]['lon'] ?? $centerLon;

                $initialBearing = 0.0;
                if (count($routePoints) >= 2) {
                    $initialBearing = $this->osrmService->calculateBearing(
                        $routePoints[0]['lat'], $routePoints[0]['lon'],
                        $routePoints[1]['lat'], $routePoints[1]['lon']
                    );
                }

                $vehicle = Vehicle::create([
                    'uniqueId' => $dev['uniqueId'],
                    'name' => $dev['name'],
                    'model' => $dev['model'],
                    'category' => $dev['category'],
                    'plate' => $dev['plate'],
                    'profile' => $profile,
                    'routePoints' => $routePoints,
                    'currentPointIndex' => 0,
                    'progressInSegment' => 0.0,
                    'currentLat' => $initialLat,
                    'currentLon' => $initialLon,
                    'bearing' => $initialBearing,
                    'altitude' => 750.0 + mt_rand(0, 50),
                    'state' => 'MOVING',
                    'stateTimeRemaining' => 0,
                    'speedKmh' => 0.0,
                    'targetSpeedKmh' => $this->engine->getProfileMaxSpeed($profile),
                    'ignition' => true,
                    'motion' => true,
                    'power' => 14.1,
                    'batteryTracker' => 98,
                    'fuel' => 65.0 + mt_rand(0, 30),
                    'totalDistance' => (float) mt_rand(15000, 95000),
                    'engineTemp' => 86,
                    'rpm' => 2100,
                    'customAttributes' => $dev['attributes'],
                    'manualIgnition' => null,
                    'externalPowerCut' => false,
                    'engineBlocked' => false,
                    'towingSim' => false,
                    'shadowZone' => false,
                    'offlineBuffer' => [],
                    'pendingAlarm' => null,
                    'timeSinceLastSend' => mt_rand(0, 3),
                ]);

                $createdVehicles[] = $vehicle->toSimulationPayload();
            }

            Cache::put('simulation_is_paused', false);
            Cache::put('simulation_is_running', true, 60);

            $hasTraccarFailures = count($provisionResults['failed']) > 0;
            $msg = count($createdVehicles) . " veículos gerados na simulação local.";
            if ($hasTraccarFailures) {
                $failedCount = count($provisionResults['failed']);
                $firstReason = $provisionResults['failed'][0]['reason'] ?? 'Erro desconhecido';
                $msg .= " Porém, {$failedCount} veículo(s) falharam no cadastro do Traccar remoto: {$firstReason}";
            }

            return response()->json([
                'success' => true,
                'message' => $msg,
                'provisionResults' => $provisionResults,
                'vehicles' => $createdVehicles,
            ]);
        } catch (\Throwable $e) {
            return response()->json(['success' => false, 'message' => $e->getMessage()], 500);
        }
    }

    /**
     * 4. Controles Globais da Simulação
     */
    public function start(): JsonResponse
    {
        Cache::put('simulation_is_paused', false);
        Cache::put('simulation_is_running', true, 60);
        return response()->json(['success' => true, 'isRunning' => true]);
    }

    public function pause(): JsonResponse
    {
        Cache::put('simulation_is_paused', true);
        return response()->json(['success' => true, 'isPaused' => true]);
    }

    public function resume(): JsonResponse
    {
        Cache::put('simulation_is_paused', false);
        return response()->json(['success' => true, 'isPaused' => false]);
    }

    public function stop(): JsonResponse
    {
        Cache::put('simulation_is_running', false);
        return response()->json(['success' => true, 'isRunning' => false]);
    }

    public function speed(Request $request): JsonResponse
    {
        $multiplier = max(1, min(20, (int) $request->input('multiplier', 1)));
        Cache::put('simulation_time_multiplier', $multiplier);
        return response()->json(['success' => true, 'multiplier' => $multiplier]);
    }

    /**
     * 5. Remoção de Veículos
     */
    public function deleteVehicle(Request $request, string $uniqueId): JsonResponse
    {
        $deleteInTraccar = (bool) $request->input('deleteInTraccar', false);
        $traccarUrl = $request->input('traccarUrl');
        $traccarUser = $request->input('traccarUser');
        $traccarPassword = $request->input('traccarPassword');

        $deleted = Vehicle::where('uniqueId', $uniqueId)->delete();
        $traccarRes = null;

        if ($deleteInTraccar && $traccarUrl && $traccarUser && $traccarPassword) {
            $traccarRes = $this->traccarService->deleteDevice($traccarUrl, $traccarUser, $traccarPassword, $uniqueId);
        }

        return response()->json([
            'success' => true,
            'uniqueId' => $uniqueId,
            'removedFromSimulation' => (bool) $deleted,
            'traccarResult' => $traccarRes,
        ]);
    }

    public function deleteBatchVehicles(Request $request): JsonResponse
    {
        $uniqueIds = $request->input('uniqueIds', []);
        $deleteInTraccar = (bool) $request->input('deleteInTraccar', false);
        $traccarUrl = $request->input('traccarUrl');
        $traccarUser = $request->input('traccarUser');
        $traccarPassword = $request->input('traccarPassword');

        if (!is_array($uniqueIds) || empty($uniqueIds)) {
            return response()->json(['success' => false, 'message' => 'Nenhum identificador fornecido.'], 400);
        }

        $count = Vehicle::whereIn('uniqueId', $uniqueIds)->delete();

        if ($deleteInTraccar && $traccarUrl && $traccarUser && $traccarPassword) {
            foreach ($uniqueIds as $uid) {
                try {
                    $this->traccarService->deleteDevice($traccarUrl, $traccarUser, $traccarPassword, $uid);
                } catch (\Throwable $e) {}
            }
        }

        return response()->json([
            'success' => true,
            'removedCount' => $count,
            'removedIds' => $uniqueIds,
        ]);
    }

    public function clearAllVehicles(): JsonResponse
    {
        Vehicle::truncate();
        TelemetryLog::truncate();
        return response()->json(['success' => true, 'message' => 'Todos os veículos da simulação foram removidos.']);
    }

    /**
     * 6. Sensores e Atuadores do Cockpit
     */
    public function updateSensors(Request $request, string $uniqueId): JsonResponse
    {
        $traccarConfig = Cache::get('traccar_config', []);
        $host = $traccarConfig['osmandHost'] ?? 'localhost';
        $port = (int) ($traccarConfig['osmandPort'] ?? 5055);

        $vehicle = $this->engine->setVehicleSensor($uniqueId, $request->all(), $host, $port);
        if (!$vehicle) {
            return response()->json(['success' => false, 'message' => 'Veículo não encontrado.'], 404);
        }

        return response()->json([
            'success' => true,
            'uniqueId' => $uniqueId,
            'sensors' => [
                'manualIgnition' => $vehicle->manualIgnition,
                'externalPowerCut' => (bool) $vehicle->externalPowerCut,
                'engineBlocked' => (bool) $vehicle->engineBlocked,
                'towingSim' => (bool) $vehicle->towingSim,
                'shadowZone' => (bool) $vehicle->shadowZone,
            ],
        ]);
    }

    public function triggerScenario(Request $request, string $uniqueId): JsonResponse
    {
        $scenario = $request->input('scenario');
        if (!$scenario) {
            return response()->json(['success' => false, 'message' => 'Cenário não especificado.'], 400);
        }

        $traccarConfig = Cache::get('traccar_config', []);
        $host = $traccarConfig['osmandHost'] ?? 'localhost';
        $port = (int) ($traccarConfig['osmandPort'] ?? 5055);

        $vehicle = $this->engine->triggerVehicleScenario($uniqueId, $scenario, $host, $port);
        if (!$vehicle) {
            return response()->json(['success' => false, 'message' => 'Veículo não encontrado.'], 404);
        }

        return response()->json([
            'success' => true,
            'uniqueId' => $uniqueId,
            'scenario' => $scenario,
            'speedKmh' => (float) round($vehicle->speedKmh),
        ]);
    }

    public function triggerAlarm(Request $request, string $uniqueId): JsonResponse
    {
        $alarm = $request->input('alarm');
        if (!$alarm) {
            return response()->json(['success' => false, 'message' => 'Tipo de alarme não especificado.'], 400);
        }

        $traccarConfig = Cache::get('traccar_config', []);
        $host = $traccarConfig['osmandHost'] ?? 'localhost';
        $port = (int) ($traccarConfig['osmandPort'] ?? 5055);

        $vehicle = $this->engine->triggerVehicleAlarm($uniqueId, $alarm, $host, $port);
        if (!$vehicle) {
            return response()->json(['success' => false, 'message' => 'Veículo não encontrado.'], 404);
        }

        return response()->json([
            'success' => true,
            'uniqueId' => $uniqueId,
            'alarm' => $alarm,
        ]);
    }

    public function flushShadow(string $uniqueId): JsonResponse
    {
        $traccarConfig = Cache::get('traccar_config', []);
        $host = $traccarConfig['osmandHost'] ?? 'localhost';
        $port = (int) ($traccarConfig['osmandPort'] ?? 5055);

        $result = $this->engine->flushShadowBuffer($uniqueId, $host, $port);
        return response()->json(['success' => true, 'count' => $result['count']]);
    }

    /**
     * 7. Status Geral da Simulação
     */
    public function status(): JsonResponse
    {
        $vehicles = Vehicle::all()->map->toSimulationPayload();

        return response()->json([
            'isRunning' => Cache::get('simulation_is_running', false),
            'isPaused' => Cache::get('simulation_is_paused', false),
            'timeMultiplier' => Cache::get('simulation_time_multiplier', 1),
            'vehiclesCount' => $vehicles->count(),
            'vehicles' => $vehicles,
        ]);
    }

    /**
     * 8. Streaming em Tempo Real via Server-Sent Events (SSE)
     * Substitui o WebSocket com protocolo padrão nativo do navegador (EventSource).
     */
    public function events(Request $request): StreamedResponse
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }

        return response()->stream(function () {
            // Envia estado inicial
            $initialVehicles = Vehicle::all()->map->toSimulationPayload();
            $initialState = [
                'type' => 'initial_state',
                'data' => [
                    'isRunning' => Cache::get('simulation_is_running', false),
                    'isPaused' => Cache::get('simulation_is_paused', false),
                    'timeMultiplier' => Cache::get('simulation_time_multiplier', 1),
                    'vehicles' => $initialVehicles,
                ]
            ];

            echo "data: " . json_encode($initialState) . "\n\n";
            if (ob_get_level() > 0) ob_flush();
            flush();

            $lastTickSent = null;
            $startTime = time();
            $lastPing = time();

            // Executa por até 45s; o navegador (EventSource) reconecta automaticamente sem perda de dados
            while (!connection_aborted() && (time() - $startTime) < 45) {
                $currentTick = Cache::get('simulation_latest_tick');
                $tickCounter = Cache::get('simulation_tick_counter', 0);

                if ($currentTick && $tickCounter !== $lastTickSent) {
                    $lastTickSent = $tickCounter;

                    // Envia evento de tick
                    echo "data: " . json_encode([
                        'type' => 'tick',
                        'data' => [
                            'timestamp' => $currentTick['timestamp'],
                            'vehicles' => $currentTick['vehicles'],
                        ]
                    ]) . "\n\n";

                    // Envia eventos de telemetria despachada se houver
                    if (!empty($currentTick['dispatchedLogs'])) {
                        foreach ($currentTick['dispatchedLogs'] as $dispLog) {
                            echo "data: " . json_encode([
                                'type' => 'telemetry_dispatched',
                                'data' => $dispLog
                            ]) . "\n\n";
                        }
                    }

                    if (ob_get_level() > 0) ob_flush();
                    flush();
                }

                // Keepalive ping a cada 10s
                if (time() - $lastPing >= 10) {
                    $lastPing = time();
                    echo ": ping\n\n";
                    if (ob_get_level() > 0) ob_flush();
                    flush();
                }

                usleep(200000); // 200ms
            }
        }, 200, [
            'Content-Type' => 'text/event-stream',
            'Cache-Control' => 'no-cache, no-transform',
            'Connection' => 'keep-alive',
            'X-Accel-Buffering' => 'no',
        ]);
    }
}
