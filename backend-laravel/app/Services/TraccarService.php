<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Cache;

class TraccarService
{
    /**
     * Normaliza a URL base (remove barras finais).
     */
    public function normalizeUrl(string $url): string
    {
        return rtrim($url, '/');
    }

    /**
     * Testa conectividade e autenticação com o Traccar.
    /**
     * Realiza login no Traccar e retorna cliente HTTP configurado com sessão e/ou Basic Auth.
     */
    public function getAuthenticatedClient(string $serverUrl, string $username, string $password): array
    {
        $baseUrl = $this->normalizeUrl($serverUrl);
        $cookieJar = new \GuzzleHttp\Cookie\CookieJar();
        $user = null;

        try {
            $sessionRes = Http::timeout(8)
                ->withOptions(['cookies' => $cookieJar])
                ->asForm()
                ->acceptJson()
                ->post("{$baseUrl}/api/session", [
                    'email' => $username,
                    'password' => $password,
                ]);

            if ($sessionRes->successful()) {
                $user = $sessionRes->json();
            }
        } catch (\Throwable $e) {
            // Segue para Basic Auth se o endpoint de sessão falhar
        }

        $client = Http::timeout(8)
            ->acceptJson()
            ->withOptions(['cookies' => $cookieJar])
            ->withBasicAuth($username, $password);

        return [
            'client' => $client,
            'baseUrl' => $baseUrl,
            'user' => $user,
            'cookies' => $cookieJar,
        ];
    }

    /**
     * Testa conectividade e autenticação com o Traccar com diagnóstico aprofundado de permissões.
     */
    public function testConnection(string $serverUrl, string $username, string $password): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];
        $user = $auth['user'];

        // Se autenticou via /api/session
        if ($user) {
            $name = $user['name'] ?? $user['email'] ?? 'Usuário';
            $isAdmin = !empty($user['administrator']);
            $isReadonly = !empty($user['readonly']);
            $isDeviceReadonly = !empty($user['deviceReadonly']);
            $deviceLimit = $user['deviceLimit'] ?? -1;

            $devicesCount = 0;
            try {
                $devRes = $client->get("{$baseUrl}/api/devices");
                if ($devRes->successful() && is_array($devRes->json())) {
                    $devicesCount = count($devRes->json());
                }
            } catch (\Throwable $err) {}

            $canCreateDevices = true;
            $restriction = null;

            if ($isDeviceReadonly) {
                $canCreateDevices = false;
                $restriction = 'Usuário com permissão "deviceReadonly" (somente leitura de dispositivos). Não é permitido cadastrar novos veículos.';
            } elseif ($isReadonly) {
                $canCreateDevices = false;
                $restriction = 'Usuário com permissão "readonly" global. Não é permitido criar ou editar registros.';
            } elseif ($deviceLimit === 0) {
                $canCreateDevices = false;
                $restriction = 'Limite de dispositivos configurado como 0 no Traccar.';
            } elseif ($deviceLimit > 0 && $devicesCount >= $deviceLimit) {
                $canCreateDevices = false;
                $restriction = "Limite de dispositivos atingido ({$devicesCount} de {$deviceLimit}). O Traccar recusará novos cadastros.";
            }

            return [
                'success' => true,
                'user' => [
                    'id' => $user['id'] ?? null,
                    'name' => $name,
                    'email' => $user['email'] ?? $username,
                    'administrator' => $isAdmin,
                    'readonly' => $isReadonly,
                    'deviceReadonly' => $isDeviceReadonly,
                    'deviceLimit' => $deviceLimit,
                ],
                'devicesCount' => $devicesCount,
                'canCreateDevices' => $canCreateDevices,
                'restriction' => $restriction,
                'message' => "Conectado com sucesso como {$name}" . ($isAdmin ? ' (Administrador)' : ' (Usuário Comum)'),
            ];
        }

        // Fallback: tentar consulta via Basic Auth
        try {
            $fallbackRes = Http::timeout(8)
                ->withBasicAuth($username, $password)
                ->acceptJson()
                ->get("{$baseUrl}/api/devices");

            if ($fallbackRes->successful()) {
                $devices = is_array($fallbackRes->json()) ? $fallbackRes->json() : [];
                return [
                    'success' => true,
                    'user' => [
                        'name' => $username,
                        'email' => $username,
                        'administrator' => null,
                        'readonly' => false,
                        'deviceReadonly' => false,
                        'deviceLimit' => -1,
                    ],
                    'devicesCount' => count($devices),
                    'canCreateDevices' => true,
                    'restriction' => null,
                    'message' => 'Conectado com sucesso via Basic Auth.',
                ];
            }

            $status = $fallbackRes->status();
            $body = $fallbackRes->json('message') ?? $fallbackRes->body();
            return [
                'success' => false,
                'status' => $status,
                'message' => $status === 401 ? 'Credenciais inválidas (usuário ou senha incorretos).' : "Falha ao conectar ao Traccar (HTTP {$status}): {$body}",
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'status' => null,
                'message' => 'Falha ao conectar: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Testa criação de um dispositivo real no Traccar remoto para validação fim a fim.
     */
    public function testCreateDevice(string $serverUrl, string $username, string $password): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];

        $uniqueId = 'sim_test_' . mt_rand(100000, 999999);
        $payload = [
            'name' => '[TESTE-SIMULADOR] Diagnóstico de Conexão',
            'uniqueId' => $uniqueId,
            'model' => 'Simulador Traccar',
            'category' => 'car',
            'contact' => 'TESTE',
            'attributes' => (object) [],
        ];

        try {
            $res = $client->post("{$baseUrl}/api/devices", $payload);

            if ($res->successful()) {
                $created = $res->json();
                return [
                    'success' => true,
                    'device' => $created,
                    'message' => "Dispositivo de teste criado com sucesso no Traccar remoto! (ID: #{$created['id']}, UniqueId: {$uniqueId})",
                ];
            }

            $status = $res->status();
            $errorBody = $res->json('message') ?? $res->body() ?: 'Erro desconhecido retornado pelo Traccar';

            $diagnosis = match ($status) {
                400 => "Erro 400 (Bad Request): O Traccar rejeitou os dados ou o limite de dispositivos foi excedido. Detalhe: {$errorBody}",
                401 => "Erro 401 (Não Autorizado): Credenciais incorretas ou sessão recusada pelo Traccar.",
                403 => "Erro 403 (Acesso Negado): Esta conta Traccar NÃO possui permissão para cadastrar dispositivos (verifique se 'deviceReadonly' está ativo ou use conta Administrador). Detalhe: {$errorBody}",
                404 => "Erro 404 (Não Encontrado): O endpoint /api/devices não foi encontrado na URL informada ({$baseUrl}).",
                default => "Erro HTTP {$status}: {$errorBody}",
            };

            return [
                'success' => false,
                'status' => $status,
                'error' => $errorBody,
                'message' => $diagnosis,
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'status' => null,
                'error' => $e->getMessage(),
                'message' => "Falha de conexão com o Traccar ao tentar criar dispositivo: " . $e->getMessage(),
            ];
        }
    }

    /**
     * Exclui um dispositivo específico pelo ID numérico no Traccar.
     */
    public function deleteDeviceById(string $serverUrl, string $username, string $password, int $deviceId): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];

        try {
            $res = $client->delete("{$baseUrl}/api/devices/{$deviceId}");
            if ($res->successful()) {
                return [
                    'success' => true,
                    'message' => "Dispositivo de teste #{$deviceId} excluído com sucesso do Traccar.",
                ];
            }
            return [
                'success' => false,
                'message' => "Falha ao excluir dispositivo #{$deviceId}: HTTP " . $res->status(),
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'message' => "Erro ao excluir dispositivo: " . $e->getMessage(),
            ];
        }
    }

    /**
     * Testa conectividade com qualquer porta TCP/HTTP no servidor Traccar usando sockets.
     */
    public function testPortConnectivity(string $host, int $port, int $timeoutSeconds = 3): array
    {
        $cleanHost = preg_replace('/^https?:\/\//', '', $host);
        $cleanHost = preg_replace('/:[0-9]+$/', '', $cleanHost);
        $cleanHost = rtrim($cleanHost, '/');
        $port = $port ?: 5055;

        $startTime = microtime(true);
        $fp = @fsockopen($cleanHost, $port, $errno, $errstr, $timeoutSeconds);
        $latencyMs = round((microtime(true) - $startTime) * 1000);

        if ($fp) {
            fclose($fp);
            return [
                'success' => true,
                'host' => $cleanHost,
                'port' => $port,
                'latencyMs' => $latencyMs,
                'message' => "Porta {$port} (TCP) está ABERTA e respondendo em {$cleanHost} ({$latencyMs}ms). O Traccar aceita conexões nesta porta.",
            ];
        }

        // Se falhou via socket direto, mas for porta 5055 e protocolo HTTP, tenta ping HTTP simples como fallback
        if ($port === 5055) {
            try {
                $httpRes = Http::timeout(3)->get("http://{$cleanHost}:{$port}/", ['id' => 'ping', 'lat' => 0, 'lon' => 0]);
                $latencyMs = round((microtime(true) - $startTime) * 1000);
                return [
                    'success' => true,
                    'host' => $cleanHost,
                    'port' => $port,
                    'latencyMs' => $latencyMs,
                    'message' => "Porta {$port} respondeu via HTTP ({$latencyMs}ms).",
                ];
            } catch (\Throwable $_) {}
        }

        return [
            'success' => false,
            'host' => $cleanHost,
            'port' => $port,
            'latencyMs' => $latencyMs,
            'error' => "Erro {$errno}: {$errstr}",
            'message' => "Porta {$port} inacessível em {$cleanHost} (Erro {$errno}: {$errstr}). Verifique se o Traccar está em execução e se a porta {$port} (TCP) está liberada no firewall/Security Group.",
        ];
    }

    /**
     * Testa conectividade com a porta OsmAnd (ou customizada).
     */
    public function testOsmAndPort(string $osmandHost, int $osmandPort): array
    {
        return $this->testPortConnectivity($osmandHost, $osmandPort ?: 5055);
    }

    /**
     * Busca atributos calculados (Computed Attributes) cadastrados no Traccar (/settings/attributes).
     */
    public function getComputedAttributes(string $serverUrl, string $username, string $password): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];

        try {
            $res = $client->get("{$baseUrl}/api/attributes/computed");
            if ($res->successful() && is_array($res->json())) {
                return [
                    'success' => true,
                    'attributes' => $res->json(),
                ];
            }
            return [
                'success' => false,
                'status' => $res->status(),
                'message' => "Falha ao consultar computed attributes: HTTP " . $res->status(),
                'attributes' => [],
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'message' => $e->getMessage(),
                'attributes' => [],
            ];
        }
    }

    /**
     * Lista todos os dispositivos cadastrados no Traccar remoto para importação.
     */
    public function getRemoteDevices(string $serverUrl, string $username, string $password): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];

        try {
            $devicesRes = $client->get("{$baseUrl}/api/devices");
            if (!$devicesRes->successful() || !is_array($devicesRes->json())) {
                return [
                    'success' => false,
                    'message' => "Falha ao obter dispositivos: HTTP " . $devicesRes->status(),
                    'devices' => [],
                ];
            }

            $devices = $devicesRes->json();

            // Pega posições para identificar último protocolo e localização
            $positionsMap = [];
            try {
                $posRes = $client->get("{$baseUrl}/api/positions");
                if ($posRes->successful() && is_array($posRes->json())) {
                    foreach ($posRes->json() as $p) {
                        if (!empty($p['deviceId'])) {
                            $positionsMap[$p['deviceId']] = $p;
                        }
                    }
                }
            } catch (\Throwable $_) {}

            $localUniqueIds = \App\Models\Vehicle::pluck('uniqueId')->flip()->toArray();

            $formatted = [];
            foreach ($devices as $d) {
                $uid = (string) ($d['uniqueId'] ?? '');
                $pos = $positionsMap[$d['id'] ?? 0] ?? null;
                $protocol = $pos['protocol'] ?? ($d['model'] ?: 'OsmAnd');

                $formatted[] = [
                    'id' => $d['id'] ?? null,
                    'name' => $d['name'] ?? 'Dispositivo',
                    'uniqueId' => $uid,
                    'status' => $d['status'] ?? 'unknown',
                    'lastUpdate' => $d['lastUpdate'] ?? null,
                    'category' => $d['category'] ?? 'car',
                    'model' => $d['model'] ?? 'Rastreador',
                    'contact' => $d['contact'] ?? '',
                    'protocol' => $protocol,
                    'attributes' => $d['attributes'] ?? (object) [],
                    'isAlreadyImported' => isset($localUniqueIds[$uid]),
                    'lastLat' => $pos['latitude'] ?? null,
                    'lastLon' => $pos['longitude'] ?? null,
                ];
            }

            return [
                'success' => true,
                'count' => count($formatted),
                'devices' => $formatted,
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'message' => $e->getMessage(),
                'devices' => [],
            ];
        }
    }

    /**
     * Analisa a base do Traccar e extrai modelos e atributos (dispositivos, posições e atributos calculados).
     */
    public function analyzeInstance(string $serverUrl, string $username, string $password): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];

        try {
            // 1. Busca dispositivos existentes
            $devicesRes = $client->get("{$baseUrl}/api/devices");
            $devices = $devicesRes->successful() && is_array($devicesRes->json()) ? $devicesRes->json() : [];

            // 2. Busca últimas posições para extrair telemetrias reais existentes
            $positions = [];
            try {
                $posRes = $client->get("{$baseUrl}/api/positions");
                if ($posRes->successful() && is_array($posRes->json())) {
                    $positions = $posRes->json();
                }
            } catch (\Throwable $err) {
                Log::warning('Aviso: Não foi possível obter posições existentes: ' . $err->getMessage());
            }

            // 3. Busca Computed Attributes de /settings/attributes (/api/attributes/computed)
            $computedAttributes = [];
            try {
                $compRes = $client->get("{$baseUrl}/api/attributes/computed");
                if ($compRes->successful() && is_array($compRes->json())) {
                    $computedAttributes = $compRes->json();
                }
            } catch (\Throwable $err) {
                Log::warning('Aviso: Não foi possível obter computed attributes: ' . $err->getMessage());
            }

            // 4. Extração e catalogação de modelos
            $modelSet = [];
            foreach ($devices as $d) {
                if (!empty($d['model']) && trim($d['model'])) $modelSet[trim($d['model'])] = true;
                if (!empty($d['category']) && trim($d['category'])) $modelSet[trim($d['category'])] = true;
            }
            $discoveredModels = array_keys($modelSet);
            $models = count($discoveredModels) > 0 ? $discoveredModels : ['OsmAnd'];

            // 5. Catalogação de Atributos com exemplos
            $attributeCatalog = [];

            // Injeta Computed Attributes primeiro com descrições ricas
            foreach ($computedAttributes as $comp) {
                $key = $comp['attribute'] ?? null;
                if (!$key) continue;
                $type = $comp['type'] ?? 'string';
                $attributeCatalog[$key] = [
                    'key' => $key,
                    'label' => ($comp['description'] ?? $key) . " ({$key})",
                    'description' => $comp['description'] ?? '',
                    'expression' => $comp['expression'] ?? '',
                    'source' => 'computed',
                    'type' => $type,
                    'examples' => [],
                    'recommendedValue' => $type === 'boolean' ? true : ($type === 'number' ? 100 : 'OK'),
                ];
            }

            // Injeta atributos de dispositivos reais
            foreach ($devices as $device) {
                if (!empty($device['attributes']) && is_array($device['attributes'])) {
                    foreach ($device['attributes'] as $key => $value) {
                        if (!isset($attributeCatalog[$key])) {
                            $attributeCatalog[$key] = [
                                'key' => $key,
                                'label' => $key,
                                'source' => 'device',
                                'type' => gettype($value),
                                'examples' => [],
                            ];
                        }
                        if ($value !== null && $value !== '') {
                            $attributeCatalog[$key]['examples'][$value] = true;
                        }
                    }
                }
            }

            // Injeta atributos de posições
            foreach ($positions as $pos) {
                if (!empty($pos['attributes']) && is_array($pos['attributes'])) {
                    foreach ($pos['attributes'] as $key => $value) {
                        if (!isset($attributeCatalog[$key])) {
                            $attributeCatalog[$key] = [
                                'key' => $key,
                                'label' => $key,
                                'source' => 'position',
                                'type' => gettype($value),
                                'examples' => [],
                            ];
                        }
                        if ($value !== null && $value !== '') {
                            $attributeCatalog[$key]['examples'][$value] = true;
                        }
                    }
                }
            }

            $formattedAttributes = [];
            foreach ($attributeCatalog as $key => $data) {
                $examplesArr = isset($data['examples']) ? array_slice(array_keys($data['examples']), 0, 5) : [];
                $formattedAttributes[] = [
                    'key' => $key,
                    'label' => $data['label'] ?? $key,
                    'description' => $data['description'] ?? '',
                    'expression' => $data['expression'] ?? '',
                    'source' => $data['source'],
                    'type' => $data['type'],
                    'examples' => $examplesArr,
                    'recommendedValue' => $data['recommendedValue'] ?? ($examplesArr[0] ?? ($data['type'] === 'integer' || $data['type'] === 'double' || $data['type'] === 'number' ? 100 : 'exemplo')),
                ];
            }

            return [
                'success' => true,
                'devicesCount' => count($devices),
                'computedCount' => count($computedAttributes),
                'models' => $models,
                'discoveredModels' => $discoveredModels,
                'attributes' => $formattedAttributes,
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'message' => 'Erro ao analisar base Traccar: ' . $e->getMessage(),
            ];
        }
    }

    /**
     * Cria múltiplos dispositivos fictícios no Traccar via API REST.
     */
    public function createBatchDevices(string $serverUrl, string $username, string $password, array $devicesToCreate): array
    {
        $auth = $this->getAuthenticatedClient($serverUrl, $username, $password);
        $baseUrl = $auth['baseUrl'];
        $client = $auth['client'];

        $results = [
            'created' => [],
            'failed' => [],
        ];

        foreach ($devicesToCreate as $dev) {
            try {
                $payload = [
                    'name' => $dev['name'],
                    'uniqueId' => (string) $dev['uniqueId'],
                    'model' => $dev['model'] ?? 'Simulador',
                    'category' => $dev['category'] ?? 'car',
                    'contact' => $dev['plate'] ?? '',
                    'attributes' => empty($dev['attributes']) ? (object) [] : (object) $dev['attributes'],
                ];

                $res = $client->post("{$baseUrl}/api/devices", $payload);

                if ($res->successful()) {
                    $results['created'][] = $res->json();
                } else {
                    $errMsg = $res->json('message') ?? $res->body() ?: ('HTTP ' . $res->status());
                    $results['failed'][] = [
                        'name' => $dev['name'],
                        'uniqueId' => $dev['uniqueId'],
                        'status' => $res->status(),
                        'reason' => "HTTP {$res->status()}: {$errMsg}",
                    ];
                }
            } catch (\Throwable $e) {
                $results['failed'][] = [
                    'name' => $dev['name'],
                    'uniqueId' => $dev['uniqueId'],
                    'status' => null,
                    'reason' => $e->getMessage(),
                ];
            }
        }

        return $results;
    }

    /**
     * Envia pacote de telemetria para a porta de ingestão OsmAnd do Traccar (porta 5055).
     */
    public function sendOsmAndTelemetry(string $osmandHost, int $osmandPort, array $data): array
    {
        $host = preg_replace('/^https?:\/\//', '', $osmandHost);
        $host = rtrim($host, '/');
        $port = $osmandPort ?: 5055;
        $protocol = str_starts_with($osmandHost, 'https://') ? 'https' : 'http';
        $targetUrl = "{$protocol}://{$host}:{$port}/";

        // Monta os parâmetros padrão OsmAnd
        $params = [
            'id' => (string) $data['uniqueId'],
            'lat' => number_format((float) $data['lat'], 6, '.', ''),
            'lon' => number_format((float) $data['lon'], 6, '.', ''),
            'timestamp' => (int) ($data['timestamp'] ?? time()),
            'speed' => number_format((float) ($data['speedKnots'] ?? 0), 2, '.', ''),
            'bearing' => number_format((float) ($data['bearing'] ?? 0), 1, '.', ''),
            'altitude' => number_format((float) ($data['altitude'] ?? 10), 1, '.', ''),
            'accuracy' => number_format((float) ($data['accuracy'] ?? 4.5), 1, '.', ''),
            'batt' => (int) round($data['batteryTracker'] ?? 95),
            'ignition' => !empty($data['ignition']) ? 'true' : 'false',
            'motion' => !empty($data['motion']) ? 'true' : 'false',
            'power' => number_format((float) ($data['power'] ?? (!empty($data['ignition']) ? 13.9 : 12.4)), 2, '.', ''),
            'totalDistance' => (int) round($data['totalDistance'] ?? 0),
        ];

        // Injeta atributos adicionais customizados
        if (!empty($data['attributes']) && is_array($data['attributes'])) {
            foreach ($data['attributes'] as $key => $val) {
                if (!isset($params[$key]) && $val !== null) {
                    if (is_bool($val)) {
                        $params[$key] = $val ? 'true' : 'false';
                    } else {
                        $params[$key] = $val;
                    }
                }
            }
        }

        try {
            $response = Http::timeout(4)->get($targetUrl, $params);

            return [
                'success' => $response->successful(),
                'status' => $response->status(),
                'url' => $targetUrl . '?' . http_build_query($params),
                'params' => $params,
                'response' => $response->body(),
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'status' => null,
                'url' => $targetUrl . '?' . http_build_query($params),
                'error' => $e->getMessage(),
                'params' => $params,
                'response' => null,
            ];
        }
    }

    /**
     * Remove um dispositivo da base do Traccar via REST.
     */
    public function deleteDevice(string $serverUrl, string $username, string $password, string $uniqueId): array
    {
        if (!$serverUrl || !$username || !$password) {
            return ['success' => false, 'message' => 'Credenciais ausentes'];
        }
        $baseUrl = $this->normalizeUrl($serverUrl);

        try {
            $res = Http::timeout(6)
                ->withBasicAuth($username, $password)
                ->acceptJson()
                ->get("{$baseUrl}/api/devices", ['uniqueId' => $uniqueId]);

            $devices = $res->successful() && is_array($res->json()) ? $res->json() : [];
            $dev = null;
            foreach ($devices as $d) {
                if (($d['uniqueId'] ?? '') === $uniqueId) {
                    $dev = $d;
                    break;
                }
            }

            if ($dev && !empty($dev['id'])) {
                Http::timeout(6)
                    ->withBasicAuth($username, $password)
                    ->delete("{$baseUrl}/api/devices/{$dev['id']}");

                return ['success' => true, 'message' => "Dispositivo {$uniqueId} removido do Traccar."];
            }

            return ['success' => true, 'message' => 'Dispositivo não encontrado no Traccar (removido da simulação).'];
        } catch (\Throwable $e) {
            return ['success' => false, 'message' => $e->getMessage()];
        }
    }

    /**
     * Obtém conexão PDO com o PostgreSQL do Traccar para leitura direta da fila de comandos.
     */
    public function getTraccarDatabaseConnection(array $config = []): ?\PDO
    {
        $cached = Cache::get('traccar_config', []);

        $host = $config['dbHost'] ?? ($cached['dbHost'] ?? env('TRACCAR_DB_HOST', 'host.docker.internal'));
        $port = (int) ($config['dbPort'] ?? ($cached['dbPort'] ?? env('TRACCAR_DB_PORT', 5433)));
        $dbname = $config['dbName'] ?? ($cached['dbName'] ?? env('TRACCAR_DB_DATABASE', 'traccar'));
        $user = $config['dbUser'] ?? ($cached['dbUser'] ?? env('TRACCAR_DB_USERNAME', 'traccar'));
        $password = $config['dbPassword'] ?? ($cached['dbPassword'] ?? env('TRACCAR_DB_PASSWORD', 'traccar_password'));

        $candidates = [
            ['host' => $host, 'port' => $port],
        ];

        // Se o host configurado for host.docker.internal e falhar ou localhost, testa alternativas automáticas
        if ($host === 'host.docker.internal' || $host === 'localhost' || $host === '127.0.0.1') {
            $candidates[] = ['host' => 'host.docker.internal', 'port' => 5433];
            $candidates[] = ['host' => '127.0.0.1', 'port' => 5433];
            $candidates[] = ['host' => 'localhost', 'port' => 5433];
            $candidates[] = ['host' => 'traccar-db', 'port' => 5432];
            $candidates[] = ['host' => 'db', 'port' => 5432];
        }

        foreach ($candidates as $cand) {
            try {
                $dsn = "pgsql:host={$cand['host']};port={$cand['port']};dbname={$dbname};connect_timeout=2";
                $pdo = new \PDO($dsn, $user, $password, [
                    \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                    \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
                    \PDO::ATTR_TIMEOUT => 2,
                ]);
                return $pdo;
            } catch (\Throwable $e) {
                // Continua para o próximo candidato silenciosamente
            }
        }

        return null;
    }

    /**
     * Testa conectividade com o banco de dados do Traccar.
     */
    public function testDatabaseConnection(array $config = []): array
    {
        $start = microtime(true);
        try {
            $pdo = $this->getTraccarDatabaseConnection($config);
            if (!$pdo) {
                return [
                    'success' => false,
                    'latencyMs' => round((microtime(true) - $start) * 1000),
                    'message' => 'Não foi possível conectar ao banco PostgreSQL do Traccar. Verifique host, porta e credenciais.',
                    'pendingCommandsCount' => 0,
                ];
            }

            $stmt = $pdo->query("SELECT COUNT(*) as count FROM tc_commands_queue");
            $row = $stmt->fetch();
            $count = (int) ($row['count'] ?? 0);
            $latencyMs = round((microtime(true) - $start) * 1000);

            return [
                'success' => true,
                'latencyMs' => $latencyMs,
                'pendingCommandsCount' => $count,
                'message' => "Conexão com PostgreSQL do Traccar OK ({$latencyMs}ms)! Comandos pendentes na fila: {$count}",
            ];
        } catch (\Throwable $e) {
            return [
                'success' => false,
                'latencyMs' => round((microtime(true) - $start) * 1000),
                'message' => 'Erro ao conectar ao banco do Traccar: ' . $e->getMessage(),
                'pendingCommandsCount' => 0,
            ];
        }
    }

    /**
     * Faz polling na fila de comandos do Traccar (tc_commands_queue) para veículos simulados.
     */
    public function pollPendingCommands(array $config = []): array
    {
        try {
            $pdo = $this->getTraccarDatabaseConnection($config);
            if (!$pdo) {
                return [];
            }

            $sql = "
                SELECT q.id, q.deviceid, q.type, q.attributes, d.uniqueid, d.name as device_name
                FROM tc_commands_queue q
                JOIN tc_devices d ON q.deviceid = d.id
                ORDER BY q.id ASC
            ";

            $stmt = $pdo->query($sql);
            $rows = $stmt->fetchAll();

            $commands = [];
            foreach ($rows as $row) {
                $attrs = [];
                if (!empty($row['attributes'])) {
                    if (is_string($row['attributes'])) {
                        $attrs = json_decode($row['attributes'], true) ?: [];
                    } elseif (is_array($row['attributes'])) {
                        $attrs = $row['attributes'];
                    }
                }

                $commands[] = [
                    'id' => (int) $row['id'],
                    'deviceId' => (int) $row['deviceid'],
                    'type' => (string) $row['type'],
                    'attributes' => $attrs,
                    'uniqueId' => (string) $row['uniqueid'],
                    'deviceName' => (string) $row['device_name'],
                ];
            }

            return $commands;
        } catch (\Throwable $e) {
            Log::debug('TraccarService::pollPendingCommands falhou: ' . $e->getMessage());
            return [];
        }
    }

    /**
     * Confirma e remove um comando executado da fila (tc_commands_queue),
     * registrando o evento queuedCommandSent no Traccar para manter sincronia perfeita.
     */
    public function acknowledgeCommand(int $commandId, int $deviceId, array $config = []): bool
    {
        try {
            $pdo = $this->getTraccarDatabaseConnection($config);
            if (!$pdo) {
                return false;
            }

            // 1. Remove da fila
            $stmtDel = $pdo->prepare("DELETE FROM tc_commands_queue WHERE id = :id");
            $stmtDel->execute(['id' => $commandId]);

            // 2. Insere evento de conclusão no Traccar para histórico e relatórios
            try {
                $stmtEvt = $pdo->prepare("
                    INSERT INTO tc_events (type, eventtime, deviceid, attributes)
                    VALUES ('queuedCommandSent', NOW(), :deviceid, :attrs)
                ");
                $stmtEvt->execute([
                    'deviceid' => $deviceId,
                    'attrs' => json_encode(['id' => $commandId]),
                ]);
            } catch (\Throwable $_) {}

            return true;
        } catch (\Throwable $e) {
            Log::warning("Falha ao reconhecer comando #{$commandId}: " . $e->getMessage());
            return false;
        }
    }
}
