# Traccar Fleet Simulator & Telemetry Injector 🚗📡

Simulador profissional de frotas de veículos e injetor de telemetria em tempo real para a plataforma [Traccar](https://www.traccar.org), desenvolvido em **PHP 8.2+ / Laravel 11** com arquitetura de alta performance, física veicular realista, roteamento inteligente via OSRM e streaming nativo de eventos (SSE).

---

## 🌟 Principais Recursos

### 1. Conexão & Diagnóstico Fim a Fim
- **Autenticação Segura com Traccar**: Suporte à API REST (HTTP Basic Auth e Session Cookie) em portas locais ou túneis HTTPS remotos com subdomínios.
- **Teste de Conectividade Raw TCP Socket**: Validação de conectividade em tempo real para qualquer porta (HTTP, OsmAnd, Teltonika, Coban, Suntech, etc.) com medição de latência de rede em milissegundos.
- **Diagnóstico com Dispositivo de Teste Efêmero**: Criação e remoção automática de um dispositivo teste (`DEVICE_TEST_PING_CHECK`) para validação prática de permissões da conta.

### 2. Importação Segura de Dispositivos Reais do Traccar
- **Catálogo de Dispositivos Remotos**: Lista todos os dispositivos cadastrados no seu servidor Traccar remoto com status (Online/Offline), modelo, protocolo e coordenadas atuais.
- **Alerta Crítico de Segurança Operacional**: Modal com confirmação obrigatória de risco consciente antes de associar telemetria a um IMEI real, alertando sobre possíveis impactos de bloqueio no trânsito caso haja automações e regras de corte ativas no Traccar.

### 3. Gerenciamento Completo de Protocolos & Portas Customizadas
- **Portas Editáveis em Todos os Protocolos**: Permite alterar a porta de ingestão de **qualquer protocolo** (inclusive os nativos como OsmAnd `:5055`, Teltonika `:5027`, Coban `:5001`, GT06 `:5023`, Suntech `:5011`, etc.).
- **Restauração de Fábrica em 1 Clique**: Indicador visual de protocolo customizado/editado e botão de restauração instantânea para a porta padrão de fábrica.
- **Cadastro Permanente de Protocolos Customizados**: Interface para registrar novos protocolos proprietários com transporte TCP/UDP.

### 4. Atributos Calculados (JEXL) & Injeção de Telemetria Customizada
- **Sincronização com `/settings/attributes`**: Leitura de todas as regras e expressões JEXL computadas configuradas na instância Traccar.
- **Injeção de Sensores em Tempo Real**: Configuração flexível de sensores (Combustível, Temperatura do motor, Porta aberta, Bateria do rastreador, etc.), propagados dinamicamente para os pacotes de telemetria despachados.

### 5. Física Veicular Realista & Roteamento OpenStreetMap (OSRM)
- Traçados dinâmicos e circulantes por ruas, avenidas e rodovias reais de capitais (São Paulo, Rio de Janeiro, Fortaleza, etc.) obtidos via motor OSRM.
- Curvas com redução automática de velocidade baseada na variação de azimute (*bearing*).
- Simulação de semáforos, trânsito urbano e paradas com motor ligado ou desligado.
- Voltagem de bateria realista (13.8V a 14.2V com alternador ativo; 12.0V a 12.4V desligado; 0.0V em corte de chicote VCC).
- **Controles de Hardware e Relés**:
  - Pós-chave / Ignição (Automático / Ligado Manual / Desligado Manual).
  - Corte de alimentação VCC (Bateria principal vs Backup).
  - Bloqueio remoto de combustível/motor (`blocked: true`).
  - Simulação de reboque/guincho sem ignição (`alarm: tow`).
  - Zona de Sombra com buffer offline em memória e descarregamento em rajada (*burst*).

### 6. Mapa Interativo com Câmera Inteligente Suave
- Mapa Leaflet dark mode integrado com camada OpenStreetMap.
- **Navegação Suave com Deadband (Floating Camera)**: O veículo se move livremente pela tela com interpolação contínua (sem sacolejos ou pulos bruscos); o mapa recentraliza com deslizamento suave apenas quando o carro ultrapassa a margem de conforto.
- **Acompanhamento com Zoom Automático**: Centralização imediata no nível de rua (`zoom 16`) ao focar qualquer veículo pela barra lateral ou pelo seletor de topo.

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologias Utilizadas |
| :--- | :--- |
| **Backend** | **PHP 8.2+**, **Laravel 11**, SQLite, Guzzle HTTP, Raw TCP Sockets, Artisan CLI |
| **Frontend** | Vanilla JavaScript (ES6+ modular), Tailwind CSS, Leaflet.js, OpenStreetMap |
| **Comunicação em Tempo Real** | **Server-Sent Events (SSE)** com reconnection automática e sem dependência de daemons externos |
| **Roteamento Geográfico** | OSRM (Open Source Routing Machine) API |
| **Protocolos GPS Suportados** | OsmAnd HTTP, Teltonika, Coban/GPS103, TK103, GT06, H02, Suntech, Queclink, Meitrack |

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

Abra dois terminais (ou execute via supervisor/gerenciador de processos):

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

## 📖 Fluxo de Utilização Recomendado

1. **Configuração Inicial**:
   - Abra a aba **Configurações** ⚙️ no menu superior.
   - Na sub-aba **Conexão & Diagnóstico**, informe a URL REST do seu Traccar (ex: `https://seu-traccar.com.br`), o Host e a Porta OsmAnd (ex: `10055`).
   - Informe as credenciais e clique em **Testar Conexão** e **Testar Porta**.
2. **Importação ou Criação**:
   - **Importar Dispositivo Real**: Acesse a sub-aba **Importar do Traccar**, localize seu veículo e clique em **Importar** (confirmando a ciência dos riscos operacionais).
   - **Criar Frota Sintética**: Vá para a aba **Criar Veículos**, escolha a cidade desejada (ex: Fortaleza, São Paulo), quantidade de veículos e clique em **Gerar Frota**.
3. **Monitoramento & Operação**:
   - Clique em qualquer veículo na sidebar da tela inicial para aproximar a câmera (`zoom 16`) e acompanhar a trajetória em tempo real.
   - Utilize o cockpit de telemetria para testar bloqueios de motor, simulação de reboque, corte de chicote e descarregamento de buffer de sombra.

---

## 📄 Licença

Distribuído sob a licença MIT. Consulte `LICENSE` para mais detalhes.
