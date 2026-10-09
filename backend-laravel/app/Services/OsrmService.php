<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class OsrmService
{
    protected string $osrmBaseUrl = 'https://router.project-osrm.org';

    /**
     * Converte graus para radianos.
     */
    public function toRadians(float $degrees): float
    {
        return $degrees * (M_PI / 180.0);
    }

    /**
     * Converte radianos para graus.
     */
    public function toDegrees(float $radians): float
    {
        return $radians * (180.0 / M_PI);
    }

    /**
     * Calcula distância em metros entre dois pontos (Haversine).
     */
    public function calculateDistance(float $lat1, float $lon1, float $lat2, float $lon2): float
    {
        $R = 6371000.0; // Raio da Terra em metros
        $phi1 = $this->toRadians($lat1);
        $phi2 = $this->toRadians($lat2);
        $deltaPhi = $this->toRadians($lat2 - $lat1);
        $deltaLambda = $this->toRadians($lon2 - $lon1);

        $a = sin($deltaPhi / 2.0) * sin($deltaPhi / 2.0) +
             cos($phi1) * cos($phi2) *
             sin($deltaLambda / 2.0) * sin($deltaLambda / 2.0);

        $c = 2.0 * atan2(sqrt($a), sqrt(1.0 - $a));
        return $R * $c;
    }

    /**
     * Calcula azimute/rumo (bearing) entre dois pontos em graus (0 a 360).
     */
    public function calculateBearing(float $lat1, float $lon1, float $lat2, float $lon2): float
    {
        $phi1 = $this->toRadians($lat1);
        $phi2 = $this->toRadians($lat2);
        $deltaLambda = $this->toRadians($lon2 - $lon1);

        $y = sin($deltaLambda) * cos($phi2);
        $x = cos($phi1) * sin($phi2) -
             sin($phi1) * cos($phi2) * cos($deltaLambda);

        $brng = $this->toDegrees(atan2($y, $x));
        return fmod(($brng + 360.0), 360.0);
    }

    /**
     * Gera ponto aleatório dentro de um raio (km) a partir de um centro.
     */
    public function generateRandomPoint(float $centerLat, float $centerLon, float $radiusKm): array
    {
        $r = $radiusKm * sqrt(mt_rand() / mt_getrandmax());
        $theta = (mt_rand() / mt_getrandmax()) * 2.0 * M_PI;

        $deltaLat = ($r * cos($theta)) / 111.32;
        $deltaLon = ($r * sin($theta)) / (111.32 * cos($this->toRadians($centerLat)));

        return [
            'lat' => round($centerLat + $deltaLat, 6),
            'lon' => round($centerLon + $deltaLon, 6),
        ];
    }

    /**
     * Consulta rota viária real no OSRM passando lista de waypoints.
     */
    public function getRoute(array $waypoints): array
    {
        if (count($waypoints) < 2) {
            throw new \InvalidArgumentException('Pelo menos 2 waypoints são necessários para gerar rota.');
        }

        $coords = array_map(function ($wp) {
            return sprintf('%.6f,%.6f', (float) $wp['lon'], (float) $wp['lat']);
        }, $waypoints);

        $coordinatesString = implode(';', $coords);
        $url = "{$this->osrmBaseUrl}/route/v1/driving/{$coordinatesString}?overview=full&geometries=geojson&steps=true";

        try {
            $response = Http::timeout(10)->get($url);

            if ($response->successful()) {
                $data = $response->json();
                if (($data['code'] ?? '') === 'Ok' && !empty($data['routes'])) {
                    $route = $data['routes'][0];
                    $pathPoints = array_map(function ($coord) {
                        return [
                            'lon' => (float) $coord[0],
                            'lat' => (float) $coord[1],
                        ];
                    }, $route['geometry']['coordinates']);

                    return [
                        'success' => true,
                        'distanceMeters' => (float) ($route['distance'] ?? 0),
                        'durationSeconds' => (float) ($route['duration'] ?? 0),
                        'points' => $pathPoints,
                    ];
                }
            }
            throw new \Exception('OSRM code is not Ok or empty routes.');
        } catch (\Throwable $e) {
            Log::warning('Aviso: Falha ao obter rota do OSRM, gerando rota sintética resiliente: ' . $e->getMessage());
            return $this->generateSyntheticRoute($waypoints);
        }
    }

    /**
     * Gera uma rota urbana realista com múltiplos pontos circulares a partir de um centro e raio.
     */
    public function generateCirculatingRoute(float $centerLat, float $centerLon, float $radiusKm, int $stopsCount = 4): array
    {
        $waypoints = [];
        $waypoints[] = $this->generateRandomPoint($centerLat, $centerLon, $radiusKm * 0.4);

        for ($i = 1; $i < $stopsCount; $i++) {
            $waypoints[] = $this->generateRandomPoint($centerLat, $centerLon, $radiusKm);
        }

        $waypoints[] = $waypoints[0]; // fecha o ciclo

        return $this->getRoute($waypoints);
    }

    /**
     * Gera rota sintética interpolada caso a API pública do OSRM esteja lenta ou instável.
     */
    public function generateSyntheticRoute(array $waypoints): array
    {
        $points = [];
        $count = count($waypoints);

        for ($i = 0; $i < $count - 1; $i++) {
            $start = $waypoints[$i];
            $end = $waypoints[$i + 1];
            $dist = $this->calculateDistance($start['lat'], $start['lon'], $end['lat'], $end['lon']);
            $steps = max(10, (int) floor($dist / 30.0)); // 1 ponto a cada ~30m

            for ($s = 0; $s < $steps; $s++) {
                $ratio = $s / (float) $steps;
                $points[] = [
                    'lat' => round($start['lat'] + ($end['lat'] - $start['lat']) * $ratio, 6),
                    'lon' => round($start['lon'] + ($end['lon'] - $start['lon']) * $ratio, 6),
                ];
            }
        }
        $points[] = $waypoints[$count - 1];

        return [
            'success' => true,
            'distanceMeters' => 5000.0,
            'durationSeconds' => 600.0,
            'points' => $points,
            'isSynthetic' => true,
        ];
    }
}
