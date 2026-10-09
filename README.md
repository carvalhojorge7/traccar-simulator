# Traccar Fleet Simulator & Telemetry Injector 🚗📡

> **Nota sobre o desenvolvimento**:  
> Toda a arquitetura, regras de negócio, física e serviços do **Backend (Laravel)** foram desenvolvidos por mim ([Jorge Carvalho](https://github.com/carvalhojorge7)).  
> O **Frontend** foi construído via **Vibe Coding** como interface de apoio para consumir e demonstrar as capacidades do simulador.

Simulador de frotas veiculares e injetor de telemetria em tempo real para a plataforma [Traccar](https://www.traccar.org), desenvolvido em **PHP 8.2+ / Laravel 11** com física veicular realista, roteamento OSRM e streaming nativo de eventos (SSE).

---

## 🛠️ Arquitetura do Backend

Implementado com foco em boas práticas no ecossistema **PHP / Laravel**:

- **Services Especializados**: Desacoplamento entre integração (`TraccarService`), roteamento (`OsrmService`) e física veicular (`SimulationEngine`).
- **Diagnóstico via TCP Socket**: Validação de conectividade direta com medição de latência em milissegundos para as portas de ingestão GPS.
- **Cache & Daemon em Tempo Real**: Estado sincronizado entre requisições HTTP e o daemon Artisan (`php artisan simulation:run`).
- **Server-Sent Events (SSE)**: Streaming de telemetria e posições em tempo real para o navegador de forma leve e nativa.
- **Segurança Operacional**: Validação e alertas para evitar conflitos ao simular dispositivos reais já cadastrados no Traccar.

---

## 🌟 Recursos & Destaques de Engenharia

### 1. Conexão & Diagnóstico Fim a Fim
- **Autenticação Híbrida**: Suporte à API REST (HTTP Basic Auth e Session Cookie) em redes locais ou túneis remotos HTTPS.
- **Teste Raw TCP Socket**: Checagem de conectividade com medição de latência em milissegundos para qualquer porta de telecomunicação.
- **Validação com Dispositivo Efêmero**: Rotina automatizada que cria e remove um dispositivo de teste no Traccar remoto para checar permissões de escrita antes de disparar frotas.

### 2. Importação Segura de Dispositivos Reais do Traccar
- **Catálogo de Dispositivos Remotos**: Lista os veículos da base com status (Online/Offline), protocolo e coordenadas.
- **Alerta Crítico de Segurança Operacional**: Modal com confirmação obrigatória de risco para evitar disparos acidentais que possam acionar regras de bloqueio de combustível em veículos reais no trânsito.

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

### 6. Mapa Interativo com Câmera Inteligente Suave
- Mapa Leaflet dark mode integrado com camada OpenStreetMap.
- **Navegação Suave com Deadband (Floating Camera)**: O veículo se move livremente pela tela com interpolação contínua (sem sacolejos ou pulos bruscos); o mapa recentraliza com deslizamento suave apenas quando o carro ultrapassa a margem de conforto.
- **Acompanhamento com Zoom Automático**: Centralização imediata no nível de rua (`zoom 16`) ao focar qualquer veículo pela barra lateral ou pelo seletor de topo.

---

## 🛠️ Stack Tecnológica

| Camada | Tecnologias Utilizadas |
| :--- | :--- |
| **Backend (Core Engineering)** | **PHP 8.2+**, **Laravel 11**, SQLite, Guzzle HTTP, Raw TCP Sockets, Artisan Daemon, Cache API |
| **Frontend (Vibe Coding UI)** | Vanilla JavaScript (ES6+ modular), Tailwind CSS, Leaflet.js, OpenStreetMap |
| **Streaming em Tempo Real** | **Server-Sent Events (SSE)** nativo |
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

## 👤 Desenvolvedor

**Jorge Carvalho**  
Engenheiro de Software / Desenvolvedor PHP Laravel  
- GitHub: [@carvalhojorge7](https://github.com/carvalhojorge7)  
- Bitcoin (BTC): `bc1qs7ymrzsfy6f7dgecs8kar2lpw3jup8640nuw95`

---

## 📄 Licença

Distribuído sob a licença MIT. Consulte `LICENSE` para mais detalhes.
