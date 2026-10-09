#!/bin/sh
set -e

cd /var/www/backend-laravel

# Garante existência do banco SQLite se não existir
if [ ! -f database/database.sqlite ]; then
    touch database/database.sqlite
    chmod 666 database/database.sqlite
fi

# Garante permissões em storage e cache
chmod -R 777 storage bootstrap/cache database

# Gera APP_KEY se estiver vazio
if [ -z "$APP_KEY" ]; then
    php artisan key:generate --force
fi

# Executa migrações do banco
php artisan migrate --force

echo "🚀 Iniciando Traccar Simulator..."

# Inicia o daemon de simulação física em background
php artisan simulation:run &
DAEMON_PID=$!

# Função para encerrar graciosamente os processos
cleanup() {
    echo "Encerrando processos..."
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    exit 0
}

trap cleanup INT TERM

# Inicia o servidor HTTP do Laravel
PHP_CLI_SERVER_WORKERS=10 php -S 0.0.0.0:8000 -t public router.php &
SERVER_PID=$!

wait "$SERVER_PID"
