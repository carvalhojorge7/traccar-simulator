FROM php:8.3-cli-alpine

# Instala extensões essenciais e utilitários
RUN apk add --no-cache \
    curl \
    git \
    sqlite \
    sqlite-dev \
    postgresql-dev \
    libzip-dev \
    zip \
    unzip \
    linux-headers \
    && docker-php-ext-install pcntl pdo_sqlite pdo_pgsql zip

# Instala Composer oficial
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www

# Copia dependências e código do projeto
COPY backend-laravel/composer.json backend-laravel/composer.lock /var/www/backend-laravel/
RUN cd /var/www/backend-laravel && composer install --no-dev --no-scripts --no-autoloader --prefer-dist

COPY . /var/www/

# Gera autoload otimizado
RUN cd /var/www/backend-laravel && composer dump-autoload --optimize --no-dev

# Cria estrutura inicial de dados e permissões
RUN mkdir -p /var/www/backend-laravel/storage/framework/cache \
    /var/www/backend-laravel/storage/framework/sessions \
    /var/www/backend-laravel/storage/framework/views \
    /var/www/backend-laravel/storage/logs \
    /var/www/backend-laravel/bootstrap/cache \
    && chmod -R 777 /var/www/backend-laravel/storage /var/www/backend-laravel/bootstrap/cache

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
