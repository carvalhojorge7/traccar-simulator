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
        Schema::create('telemetry_logs', function (Blueprint $table) {
            $table->id();
            $table->string('uniqueId')->index();
            $table->string('name')->nullable();
            $table->string('plate')->nullable();
            $table->string('time');
            $table->bigInteger('timestamp')->index();
            $table->float('speedKmh');
            $table->boolean('ignition');
            $table->string('power');
            $table->double('lat', 10, 7);
            $table->double('lon', 10, 7);
            $table->integer('status');
            $table->boolean('success');
            $table->text('request_url')->nullable();
            $table->json('payload')->nullable();
            $table->text('response')->nullable();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('telemetry_logs');
    }
};
