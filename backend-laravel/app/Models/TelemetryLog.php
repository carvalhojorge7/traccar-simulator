<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class TelemetryLog extends Model
{
    protected $guarded = ['id'];

    protected $casts = [
        'payload' => 'array',
        'ignition' => 'boolean',
        'success' => 'boolean',
        'speedKmh' => 'float',
        'lat' => 'float',
        'lon' => 'float',
        'status' => 'integer',
        'timestamp' => 'integer',
    ];
}
