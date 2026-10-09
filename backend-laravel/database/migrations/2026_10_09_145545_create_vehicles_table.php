<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('vehicles', function (Blueprint $table) {
            $table->id();
            $table->string('uniqueId')->unique()->index();
            $table->string('name');
            $table->string('model')->default('Teltonika FMB920');
            $table->string('category')->default('car');
            $table->string('plate')->nullable();
            $table->string('profile')->default('CAR');

            // Trajetória e coordenadas
            $table->json('routePoints')->nullable();
            $table->integer('currentPointIndex')->default(0);
            $table->float('progressInSegment')->default(0);
            $table->double('currentLat', 10, 7)->default(-23.5505);
            $table->double('currentLon', 10, 7)->default(-46.6333);
            $table->float('bearing')->default(0);
            $table->float('altitude')->default(750);

            // Física e estados de condução
            $table->string('state')->default('MOVING'); // MOVING | TRAFFIC_STOP | PARKED_OFF
            $table->integer('stateTimeRemaining')->default(0);
            $table->float('speedKmh')->default(0);
            $table->float('targetSpeedKmh')->default(60);
            $table->boolean('ignition')->default(true);
            $table->boolean('motion')->default(true);

            // Telemetria veicular
            $table->float('power')->default(14.1);
            $table->integer('batteryTracker')->default(98);
            $table->float('fuel')->default(75);
            $table->double('totalDistance')->default(0); // em metros
            $table->integer('engineTemp')->default(86);
            $table->integer('rpm')->default(2100);
            $table->json('customAttributes')->nullable();

            // Sensores e relés do Cockpit
            $table->boolean('manualIgnition')->nullable();
            $table->boolean('externalPowerCut')->default(false);
            $table->boolean('engineBlocked')->default(false);
            $table->boolean('towingSim')->default(false);
            $table->boolean('shadowZone')->default(false);
            $table->json('offlineBuffer')->nullable();
            $table->string('pendingAlarm')->nullable();

            $table->integer('timeSinceLastSend')->default(0);
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('vehicles');
    }
};
