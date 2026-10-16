# Changelog

Todas as alterações notáveis neste projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
e este projeto adere ao [Semantic Versioning](https://semver.org/lang/pt-BR/).

---

## [1.5.0] - 2026-10-16

### Adicionado
- **Diferenciação Visual Fakes vs Importados**:
  - Distinção clara e intuitiva entre **Veículos Sintéticos / Fakes** (⚡) e **Dispositivos Reais Importados** (📥) em toda a interface do usuário.
  - Badges dedicados nos cards da aba Frota (`fleetCardsGrid`), no painel lateral do mapa (`homeSidebar`), no Cockpit de Telemetria (modo normal e colapsado) e no dropdown de foco ("Acompanhar Veículo").
  - Marcadores do mapa Leaflet (`map.js`) agora exibem o prefixo de origem no rótulo e um badge de status estilizado no popup de informações.
  - Contadores em tempo real na aba Frota e na Sidebar da Home destacando a quantidade de veículos de cada tipo: `X veículos (Y ⚡ Sintéticos • Z 📥 Importados)`.
- **Política de Exclusão Segura & Preservação do Traccar**:
  - Veículos **importados do Traccar** são removidos **exclusivamente do simulador local**, garantindo que dispositivos reais no servidor Traccar nunca sejam excluídos acidentalmente.
  - Veículos **sintéticos/fakes** criados pelo simulador são removidos **em ambos** (simulador local e servidor Traccar via API REST).
  - A limpeza total da frota (`clearAllVehicles`) remove do Traccar apenas veículos sintéticos e preserva os dispositivos importados intactos.
  - A geração em lote de nova frota (`setupFleet`) limpa dispositivos sintéticos órfãos no Traccar sem afetar os importados.
- **Modais de Confirmação Inteligentes**:
  - Mensagens contextuais com aviso claro e formatado sobre o impacto da remoção (se o veículo será excluído de ambos ou apenas da simulação local).
- **Testes Automatizados de Política de Exclusão**:
  - Testes unitários e de integração adicionados em `SimulationApiTest.php` cobrindo a política de exclusão de veículos importados, sintéticos e exclusões em lote.
- **Sincronização Dinâmica de Migrações em Docker**:
  - `docker-entrypoint.sh` e `Dockerfile` atualizados para copiar e sincronizar automaticamente novas migrações mesmo quando volumes nomeados estiverem vinculados ao diretório do banco.

---

## [1.4.0] - 2026-10-16

### Adicionado
- **Autenticação Administrativa e Proteção do Painel**:
  - Middleware `SimulatorAuthMiddleware` protegendo todas as rotas de controle e configuração.
  - Tela de login dedicada em `/login` com layout moderno e suporte à função "Lembrar neste navegador".
  - Credenciais configuráveis diretamente pelo arquivo de ambiente `.env` (`ADMIN_USER` e `ADMIN_PASSWORD`).
  - Suporte híbrido a Sessões Web, tokens Sanctum Bearer (`/api/auth/login`) e HTTP Basic Auth (`admin:admin`).
  - Botão de logout integrado no cabeçalho do painel com encerramento de sessão local e revogação de tokens.

### Modificado
- **Eliminação de Bloqueios de Conexão com PostgreSQL do Traccar**:
  - Removido qualquer timeout ou dependência síncrona com o banco PostgreSQL do Traccar no ciclo de tick da simulação (`SimulationEngine`), operando de maneira 100% assíncrona e autônoma.

---

## [1.3.0] - 2026-10-15

### Adicionado
- **Cockpit Avançado de Sensores & Atuadores**:
  - Simulação de pós-chave / ignição manual (`manualIgnition`: ligada/desligada/automática).
  - Corte de alimentação principal (`externalPowerCut`: 0V com alternador desativado).
  - Simulação de alarme de reboque/guincho sem ignição ativa (`alarm: tow`).
  - Simulação de Zona de Sombra com buffer offline em memória e disparo em rajada (*burst flush*) no restabelecimento de sinal.
- **Suporte Bidirecional a Comandos de Bloqueio e Desbloqueio**:
  - Processamento em tempo real de comandos recebidos na resposta HTTP do protocolo OsmAnd (:5055) e via Webhook.
  - Interpretação nativa de comandos `engineStop` (bloqueio de motor e desligamento de ignição) e `engineResume` (desbloqueio e religamento de ignição).

---

## [1.2.0] - 2026-10-14

### Adicionado
- **Importação Direta de Dispositivos do Traccar**:
  - Sub-aba para listar dispositivos remotos da base Traccar via API REST com busca por nome, ID e status online.
  - Modal de consentimento e alerta de risco operacional para evitar disparos inadvertidos a veículos reais.
- **Gestão Avançada de Protocolos e Portas Customizadas**:
  - Edição de portas TCP/UDP para protocolos populares (OsmAnd, Teltonika, Coban, TK103, Suntech, Queclink, Meitrack, GT06, H02).
  - Suporte ao cadastro e persistência de novos protocolos customizados.
  - Botão de restauração das portas padrão de fábrica em 1 clique.
- **Atributos Calculados (JEXL)**:
  - Leitura e sincronização dos atributos computados configurados no servidor Traccar.

---

## [1.1.0] - 2026-10-12

### Adicionado
- **Física Veicular Realista & Roteamento OSRM**:
  - Roteamento viário dinâmico utilizando a API pública do OSRM (Open Source Routing Machine).
  - Circulação contínua com redução de velocidade em curvas fechadas calculada com base no azimute (*bearing*).
  - Simulação de comportamento urbano com paradas semafóricas, aceleração e frenagem progressivas.
  - Variação dinâmica de tensão de bateria (13.8V a 14.2V em trânsito; 12.2V estacionado; 0V em chicote rompido).

---

## [1.0.0] - 2026-10-09

### Adicionado
- **Lançamento Inicial do Traccar Simulator**:
  - Core do simulador desenvolvido em **PHP 8.2+ / Laravel 11**.
  - Daemon de simulação física rodando via console CLI (`php artisan simulation:run`).
  - Comunicação de telemetria em tempo real via **Server-Sent Events (SSE)** nativo.
  - Ingestão contínua de telemetria via protocolo OsmAnd HTTP (`:5055`).
  - Interface web moderna com Tailwind CSS e mapa Leaflet.js interativo.
  - Geração em lote de frotas com rotas e placas no padrão Mercosul.
  - Diagnóstico de rede de baixo nível com Raw TCP Sockets e medição de latência em milissegundos.
  - Suporte completo a containerização com Docker e Docker Compose.
