# Traccar Fleet Simulator & Telemetry Injector 🚗📡

> **Nota sobre o desenvolvimento**:  
> Toda a arquitetura, regras de negócio, física e serviços do **Backend (Laravel)** foram desenvolvidos por mim ([Jorge Carvalho](https://github.com/carvalhojorge7)).  
> O **Frontend** foi construído via **Vibe Coding** como interface de apoio para consumir e demonstrar as capacidades do simulador.

Motor de simulação veicular e ingestão contínua de telemetria para a plataforma [Traccar](https://www.traccar.org), desenvolvido em **PHP 8.2+ / Laravel 11** com física veicular realista, roteamento OSRM, concorrência via daemons e streaming de eventos (SSE).

---

## 🛠️ Arquitetura do Backend

Implementado com foco em engenharia de software e boas práticas no ecossistema **PHP / Laravel**:

- **Services Especializados & Desacoplados**: Separação clara entre camada de integração HTTP (`TraccarService`), roteamento viário (`OsrmService`), motor de física veicular (`SimulationEngine`) e controle REST (`SimulationController`).
- **Diagnóstico via Raw TCP Sockets**: Implementação de sondagem direta de portas via socket TCP de baixo nível com medição precisa de latência de rede em milissegundos para os protocolos GPS suportados.
- **Concorrência & Sincronização em Tempo Real**: Loop de simulação desacoplado rodando via daemon de console CLI (`php artisan simulation:run`), sincronizado com requisições HTTP do painel através de cache atômico em memória.
- **Pipeline de Streaming de Baixo Overhead (SSE)**: Substituição de stacks pesadas de WebSocket por Server-Sent Events com controle de buffer e reconexão automática nativa.
- **Governança & Gestão de Risco Operacional**: Regras de validação estritas para evitar envio de telemetria a veículos reais em trânsito sem consentimento expresso.

---

## 🌟 Recursos de Engenharia & Funcionalidades

### 1. Conexão & Diagnóstico Fim a Fim
- **Autenticação Híbrida**: Suporte à API REST (HTTP Basic Auth e Session Cookie) em redes locais ou túneis remotos HTTPS.
- **Teste Raw TCP Socket**: Checagem de conectividade com medição de latência em milissegundos para qualquer porta de telecomunicação.
- **Validação com Dispositivo Efêmero**: Rotina automatizada que cria e remove um dispositivo de teste no Traccar remoto para checar permissões de escrita antes de disparar frotas.

### 2. Importação Segura de Dispositivos Reais do Traccar
- **Catálogo de Dispositivos Remotos**: Lista os veículos da base com status (Online/Offline), protocolo e coordenadas.
- **Alerta Crítico de Segurança Operacional**: Confirmação obrigatória de risco para evitar disparos acidentais que possam acionar regras de bloqueio de combustível em veículos reais no trânsito.

### 3. Gerenciamento Completo de Protocolos & Portas Customizadas
- **Portas Editáveis em Qualquer Protocolo**: Edição liberada tanto para protocolos conhecidos (OsmAnd, Teltonika, Coban, GT06, Suntech, etc.) quanto customizados.
- **Restauração de Fábrica em 1 Clique**: Preserva as portas padrão de fábrica com botão de restauração instantânea.
- **Cadastro Permanente de Protocolos Customizados**: Interface para cadastrar novos protocolos com identificação TCP/UDP.

### 4. Atributos Calculados (JEXL) & Injeção de Telemetria
- **Sincronização com `/settings/attributes`**: Leitura de expressões e regras JEXL computadas cadastradas no servidor Traccar.
- **Injeção de Sensores em Tempo Real**: Telemetria customizada (combustível, temperatura do motor, sensor de porta, bateria backup) injetada diretamente nos pacotes enviados.

### 5. Física Veicular Realista & Roteamento OpenStreetMap (OSRM)
- Traçados dinâmicos e circulantes por vias reais de capitais (São Paulo, Rio de Janeiro, Fortaleza, etc.) obtidos via OSRM.
- Redução de velocidade automática em curvas acentuadas baseada no azimute (*bearing*).
- Simulação de semáforos, trânsito urbano e paradas com motor ligado ou desligado.
- Voltagem de bateria realista (13.8V a 14.2V com alternador ativo; 12.0V a 12.4V desligado; 0.0V em corte de chicote).
- **Controles de Hardware e Relés de Bancada**:
  - Pós-chave / Ignição (Automático / Ligado Manual / Desligado Manual).
  - Corte de alimentação VCC (Bateria principal vs Backup).
  - Bloqueio remoto de combustível/motor (`blocked: true`).
  - Simulação de reboque/guincho sem ignição (`alarm: tow`).
  - Zona de Sombra com buffer offline em memória e descarregamento em rajada (*burst*).

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologias Utilizadas |
| :--- | :--- |
| **Backend (Core Engineering)** | **PHP 8.2+**, **Laravel 11**, SQLite, Guzzle HTTP, Raw TCP Sockets, Artisan Daemon, Cache API |
| **Comunicação em Tempo Real** | **Server-Sent Events (SSE)** nativo |
| **Roteamento Geográfico** | OSRM (Open Source Routing Machine) API |
| **Protocolos GPS Suportados** | OsmAnd HTTP, Teltonika, Coban/GPS103, TK103, GT06, H02, Suntech, Queclink, Meitrack |
| **Frontend (Interface de Apoio)** | Vanilla JavaScript, Tailwind CSS, Leaflet.js |

---

## 🚀 Instalação e Execução

### Pré-requisitos
- **PHP 8.2 ou superior** com as extensões `pdo_sqlite`, `curl`, `mbstring`, `pcntl` ativas.
- **Composer** instalado.

### 1. Clonar o Repositório
```bash
git clone https://github.com/carvalhojorge7/traccar-simulator.git
cd traccar-simulator
```

### 2. Configurar o Backend Laravel
```bash
cd backend-laravel

# Instalar dependências PHP
composer install

# Criar arquivo de ambiente se não existir
cp .env.example .env

# Gerar chave da aplicação
php artisan key:generate

# Criar banco SQLite e rodar migrações
touch database/database.sqlite
php artisan migrate
```

### 3. Iniciar a Aplicação

Abra dois terminais:

**Terminal 1 — Servidor Web:**
```bash
cd backend-laravel
php -S 127.0.0.1:8000 -t public router.php
```

**Terminal 2 — Daemon de Simulação Física:**
```bash
cd backend-laravel
php artisan simulation:run
```

Acesse o painel no navegador:
👉 **`http://localhost:8000`**

---

## 🐳 Deploy com Docker & Docker Compose

A aplicação possui suporte nativo a containerização com **PHP 8.3 CLI Alpine**, executando tanto o servidor web multithread quanto o daemon de física veicular com volumes persistentes para banco SQLite e storage.

### 1. Subir a Aplicação com Docker Compose
```bash
docker compose up -d --build
```
> O container iniciará na porta **`8000`** e executará as migrações do banco de dados automaticamente.

### 2. Acompanhar Logs da Simulação
```bash
docker compose logs -f app
```

### 3. Parar os Containers
```bash
docker compose down
```

### Variáveis de Ambiente (`.env` ou docker-compose)
| Variável | Padrão | Descrição |
| :--- | :--- | :--- |
| `APP_PORT` | `8090` | Porta HTTP exposta no host |
| `ADMIN_USER` | `admin` | Usuário/login do administrador do painel |
| `ADMIN_PASSWORD` | `admin` | Senha de acesso administrativo ao painel |
| `TRACCAR_HOST` | `traccar` / `localhost` | Host padrão para despacho de telemetria |
| `TRACCAR_PORT` | `5055` | Porta padrão do protocolo OsmAnd |

---

## 🔐 Autenticação & Segurança do Painel

O painel e as APIs do simulador contam com proteção por controle de acesso:
- **Tela de Login Dedicada**: Redirecionamento automático de usuários não autorizados para `/login`.
- **Credenciais Configuráveis**: Definidas via variáveis `ADMIN_USER` e `ADMIN_PASSWORD` no `.env` (padrão: `admin` / `admin`).
- **Autenticação Híbrida**:
  - Sessão Web interativa com cookies seguros e opção "Lembrar neste navegador".
  - API Bearer Tokens (Sanctum) emitidos no login para automação e integrações.
  - HTTP Basic Auth (`curl -u admin:admin ...`) para scripts e sondagens.
  - Suporte a query param `?token=...` para conexão no canal em tempo real via Server-Sent Events (SSE).
- **Encerramento de Sessão**: Botão "Sair" integrado na barra superior do painel.

---

## 📖 Fluxo de Utilização Recomendado

1. **Configuração Inicial**:
   - Abra a aba **Configurações** ⚙️ no menu superior.
   - Na sub-aba **Conexão & Diagnóstico**, informe a URL REST do seu Traccar (ex: `https://seu-traccar.com.br`), o Host e a Porta OsmAnd (ex: `10055`).
   - Informe as credenciais e clique em **Testar Conexão** e **Testar Porta**.
2. **Importação ou Criação**:
   - **Importar Dispositivo Real**: Acesse a sub-aba **Importar do Traccar**, localize seu veículo e clique em **Importar** (confirmando a ciência dos riscos operacionais).
   - **Criar Frota Sintética**: Vá para a aba **Criar Veículos**, escolha a cidade desejada (ex: Fortaleza, São Paulo), quantidade de veículos e clique em **Gerar Frota**.
3. **Monitoramento & Operação**:
   - Monitore a frota ativa e os pacotes despachados pelo terminal ou pela tela inicial.
   - Utilize o cockpit de telemetria para testar bloqueios de motor, simulação de reboque, corte de chicote e descarregamento de buffer de sombra.

---

## 👤 Desenvolvedor

**Jorge Carvalho**  
Engenheiro de Software / Desenvolvedor PHP Laravel  
- GitHub: [@carvalhojorge7](https://github.com/carvalhojorge7)  
- Bitcoin (BTC): `bc1qs7ymrzsfy6f7dgecs8kar2lpw3jup8640nuw95`

---

## 📄 Licença

Distribuído sob a licença MIT. Consulte `LICENSE` para mais detalhes.
