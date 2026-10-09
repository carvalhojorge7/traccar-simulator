<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Services\SimulationEngine;
use Illuminate\Support\Facades\Cache;
use App\Models\Vehicle;

class SimulationRunCommand extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'simulation:run {--interval=1 : Intervalo em segundos entre cada tick} {--host= : Host OsmAnd} {--port= : Porta OsmAnd}';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Executa o loop contínuo do motor de simulação e física veicular (Daemon)';

    protected bool $keepRunning = true;

    /**
     * Execute the console command.
     */
    public function handle(SimulationEngine $engine): int
    {
        $this->info("🚀 Iniciando Motor de Simulação Laravel Traccar (Daemon)...");

        if (function_exists('pcntl_signal')) {
            pcntl_signal(SIGINT, function () {
                $this->info("\n🛑 Sinal de interrupção recebido. Encerrando simulação...");
                $this->keepRunning = false;
            });
            pcntl_signal(SIGTERM, function () {
                $this->keepRunning = false;
            });
        }

        $intervalSeconds = (float) $this->option('interval');
        $osmandHost = $this->option('host') ?: config('services.traccar.osmand_host', 'localhost');
        $osmandPort = (int) ($this->option('port') ?: config('services.traccar.osmand_port', 5055));

        $traccarConfig = [
            'osmandHost' => $osmandHost,
            'osmandPort' => $osmandPort,
            'sendIntervalSeconds' => 3,
        ];

        Cache::put('simulation_is_running', true, 30);
        $this->info("📡 Escutando telemetria e despachando para {$osmandHost}:{$osmandPort}...");

        $tickCount = 0;

        while ($this->keepRunning) {
            $startTime = microtime(true);

            if (function_exists('pcntl_signal_dispatch')) {
                pcntl_signal_dispatch();
            }

            // Lê dinamicamente as configurações do Traccar salvas no Cache (URL, host, porta customizada)
            $cachedConfig = Cache::get('traccar_config', []);
            $activeHost = !empty($cachedConfig['osmandHost']) ? $cachedConfig['osmandHost'] : $osmandHost;
            $activePort = !empty($cachedConfig['osmandPort']) ? (int) $cachedConfig['osmandPort'] : $osmandPort;
            $activeInterval = !empty($cachedConfig['sendIntervalSeconds']) ? (int) $cachedConfig['sendIntervalSeconds'] : 3;

            $currentTraccarConfig = [
                'osmandHost' => $activeHost,
                'osmandPort' => $activePort,
                'sendIntervalSeconds' => $activeInterval,
            ];

            // Verifica se a simulação não foi pausada via API
            $isPaused = Cache::get('simulation_is_paused', false);

            if (!$isPaused && Vehicle::count() > 0) {
                $tickData = $engine->tick($intervalSeconds, $currentTraccarConfig);

                // Publica dados no cache para o streaming SSE consumir
                Cache::put('simulation_latest_tick', $tickData, 30);
                Cache::put('simulation_tick_counter', ++$tickCount, 30);

                if (!empty($tickData['dispatchedLogs'])) {
                    $existingLogs = Cache::get('simulation_recent_logs', []);
                    $updatedLogs = array_merge($tickData['dispatchedLogs'], $existingLogs);
                    Cache::put('simulation_recent_logs', array_slice($updatedLogs, 0, 50), 30);
                }
            }

            Cache::put('simulation_is_running', true, 30);

            $elapsed = microtime(true) - $startTime;
            $sleepMicros = (int) max(0, ($intervalSeconds - $elapsed) * 1000000);

            if ($sleepMicros > 0) {
                usleep($sleepMicros);
            }
        }

        Cache::put('simulation_is_running', false);
        $this->info("Simulação encerrada com sucesso.");

        return Command::SUCCESS;
    }
}
