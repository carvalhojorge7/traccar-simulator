// Interceptador global de fetch para injeção de Bearer token e tratamento automático de 401
const _originalFetch = window.fetch;
window.fetch = async function(resource, config = {}) {
  config = config || {};
  const token = localStorage.getItem('traccar_sim_token');

  if (token) {
    if (!config.headers) {
      config.headers = { 'Authorization': `Bearer ${token}` };
    } else if (config.headers instanceof Headers) {
      if (!config.headers.has('Authorization')) {
        config.headers.set('Authorization', `Bearer ${token}`);
      }
    } else if (Array.isArray(config.headers)) {
      if (!config.headers.some(h => h[0].toLowerCase() === 'authorization')) {
        config.headers.push(['Authorization', `Bearer ${token}`]);
      }
    } else {
      if (!config.headers['Authorization'] && !config.headers['authorization']) {
        config.headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  const response = await _originalFetch(resource, config);
  if (response.status === 401 && !window.location.pathname.startsWith('/login')) {
    localStorage.removeItem('traccar_sim_token');
    window.location.href = '/login';
  }
  return response;
};

async function handleLogout() {
  if (!confirm('Deseja realmente sair da sessão administrativa do painel?')) {
    return;
  }
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Accept': 'application/json' }
    });
  } catch (e) {
    console.warn('Erro ao requisitar logout:', e);
  }
  localStorage.removeItem('traccar_sim_token');
  localStorage.removeItem('traccar_sim_admin_user');
  window.location.href = '/login';
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/user', {
      headers: { 'Accept': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('headerAdminUser');
      if (el && data.user && data.user.name) {
        el.textContent = data.user.name;
      }
    } else if (res.status === 401) {
      window.location.href = '/login';
    }
  } catch (e) {
    console.warn('Erro ao verificar autenticação inicial:', e);
  }
}

// Script Principal do Dashboard do Traccar Simulator com Abas
let mapManager = null;
let ws = null;
let currentAttributes = [];
let activeVehiclesMap = new Map();
let currentTab = 'home';
let selectedVehicleForModal = null;
let followVehicleId = '';
let selectedFleetVehicleIds = new Set();
let pendingDeleteAction = null;

document.addEventListener('DOMContentLoaded', () => {
  checkAuthStatus();

  // Inicializa o Mapa com suporte à cidade salva ou padrão
  const savedCity = localStorage.getItem('traccar_sim_selected_city');
  let initLat = -23.5505;
  let initLon = -46.6333;
  if (savedCity) {
    const parts = savedCity.split(',');
    if (parts.length === 2) {
      initLat = parseFloat(parts[0]) || initLat;
      initLon = parseFloat(parts[1]) || initLon;
    }
  }

  mapManager = new MapManager('map');
  mapManager.init(initLat, initLon, 13);

  // Sincroniza seletores de cidade se houver preferência salva
  if (savedCity) {
    const quickSelect = document.getElementById('homeQuickCitySelect');
    if (quickSelect) quickSelect.value = savedCity;
    const presetSelect = document.getElementById('presetCitySelect');
    if (presetSelect) presetSelect.value = savedCity;
    const latEl = document.getElementById('inputLat');
    const lonEl = document.getElementById('inputLon');
    if (latEl) latEl.value = initLat;
    if (lonEl) lonEl.value = initLon;
  }

  // Atualiza coordenadas nos inputs quando clica no mapa
  mapManager.onCenterChanged((lat, lon) => {
    const latEl = document.getElementById('inputLat');
    const lonEl = document.getElementById('inputLon');
    if (latEl) latEl.value = lat.toFixed(5);
    if (lonEl) lonEl.value = lon.toFixed(5);
  });

  // Conecta ao WebSocket
  setupWebSocket();

  // Event Listeners
  setupEventListeners();

  // Força cálculo de tamanho do Leaflet para evitar colapso de viewport
  setTimeout(() => {
    if (mapManager && mapManager.map) {
      mapManager.map.invalidateSize();
    }
  }, 250);

  window.addEventListener('resize', () => {
    if (mapManager && mapManager.map) {
      mapManager.map.invalidateSize();
    }
  });

  // Carrega estado inicial da simulação via REST
  fetchInitialState();
  renderHomeSidebarList();

  // Carrega configurações salvas do Traccar
  loadSavedTraccarConfig();
});

// -------------------------------------------------------------
// -------------------------------------------------------------
// Controle de Abas & Criação na Frota
// -------------------------------------------------------------
let isFleetCreateAccordionOpen = false;

window.toggleFleetCreateAccordion = function(forceOpen) {
  const panel = document.getElementById('fleetCreateAccordion');
  const icon = document.getElementById('iconFleetCreateToggle');
  const text = document.getElementById('textFleetCreateToggle');
  const btn = document.getElementById('btnToggleFleetCreate');
  if (!panel) return;

  if (typeof forceOpen === 'boolean') {
    isFleetCreateAccordionOpen = forceOpen;
  } else {
    isFleetCreateAccordionOpen = !isFleetCreateAccordionOpen;
  }

  if (isFleetCreateAccordionOpen) {
    panel.classList.remove('hidden');
    if (icon) icon.innerText = '✕';
    if (text) text.innerText = 'Fechar Formulário';
    if (btn) btn.className = 'bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-1.5 rounded-xl transition-all shrink-0 border border-slate-700 flex items-center gap-1.5';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    panel.classList.add('hidden');
    if (icon) icon.innerText = '➕';
    if (text) text.innerText = 'Inserir Veículos';
    if (btn) btn.className = 'bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-3 py-1.5 rounded-xl transition-all shrink-0 shadow-lg shadow-sky-600/20 flex items-center gap-1.5';
  }
};

window.switchTab = function(tabName) {
  if (tabName === 'create') {
    switchTab('fleet');
    toggleFleetCreateAccordion(true);
    return;
  }

  currentTab = tabName;

  const tabPanes = {
    'home': document.getElementById('contentTabHome'),
    'fleet': document.getElementById('contentTabFleet'),
    'logs': document.getElementById('contentTabLogs'),
    'config': document.getElementById('contentTabConfig')
  };

  const navBtns = {
    'home': document.getElementById('navTabHome'),
    'fleet': document.getElementById('navTabFleet'),
    'logs': document.getElementById('navTabLogs'),
    'config': document.getElementById('navTabConfig')
  };

  // Esconde todas as abas e reseta estilos dos botões
  Object.keys(tabPanes).forEach(k => {
    if (tabPanes[k]) tabPanes[k].classList.add('hidden');
    if (navBtns[k]) {
      navBtns[k].className = 'nav-tab px-3.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-200 transition-all flex items-center gap-1.5 shrink-0';
    }
  });

  // Ativa a aba selecionada
  if (tabPanes[tabName]) {
    tabPanes[tabName].classList.remove('hidden');
  }
  if (navBtns[tabName]) {
    navBtns[tabName].className = 'nav-tab px-3.5 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 bg-sky-600 text-white shadow-sm shrink-0';
  }

  // Fecha cockpit flutuante ao navegar para outras abas
  if (tabName !== 'home') {
    closeVehicleDetailModal();
  }

  // Se for a aba Home (Mapa), recalcula tamanho do Leaflet e atualiza lista lateral
  if (tabName === 'home') {
    renderHomeSidebarList();
    setTimeout(() => {
      if (mapManager && mapManager.map) {
        mapManager.map.invalidateSize();
      }
    }, 150);
  } else if (tabName === 'fleet') {
    renderFleetTab();
  } else if (tabName === 'logs') {
    updateTabLogsVehicleFilter();
    renderTabLogsTable();
  }
};

// -------------------------------------------------------------
// Comunicação em Tempo Real via WebSocket
// -------------------------------------------------------------
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  let wsFailed = false;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('🔌 Conectado ao WebSocket do Simulador (Node.js)');
      updateWsStatus(true);
    };

    ws.onclose = () => {
      if (!wsFailed) {
        wsFailed = true;
        console.log('ℹ️ WebSocket inativo, alternando para canal Server-Sent Events (SSE / Laravel)...');
        setupSSE();
      }
    };

    ws.onerror = () => {
      if (!wsFailed) {
        wsFailed = true;
        setupSSE();
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error('Erro ao processar mensagem WS:', e);
      }
    };
  } catch (e) {
    setupSSE();
  }
}

function setupSSE() {
  try {
    const token = localStorage.getItem('traccar_sim_token');
    const sseUrl = token ? `/api/simulation/events?token=${encodeURIComponent(token)}` : '/api/simulation/events';
    const sse = new EventSource(sseUrl);

    sse.onopen = () => {
      console.log('⚡ Conectado ao canal SSE do Simulador (Laravel)');
      updateWsStatus(true);
    };

    sse.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error('Erro ao processar evento SSE:', e);
      }
    };

    sse.onerror = () => {
      updateWsStatus(false);
    };
  } catch (e) {
    console.error('Falha ao instanciar SSE:', e);
  }
}

function updateWsStatus(connected) {
  const badge = document.getElementById('wsBadge');
  if (!badge) return;
  if (connected) {
    badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Online`;
  } else {
    badge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20';
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> Reconectando...`;
  }
}

async function fetchInitialState() {
  try {
    const res = await fetch('/api/simulation/status');
    const data = await res.json();
    if (data.vehicles && Array.isArray(data.vehicles)) {
      data.vehicles.forEach(v => {
        activeVehiclesMap.set(v.uniqueId, v);
        mapManager.updateVehicleMarker(v);
        if (v.routePoints) {
          mapManager.drawRoute(v.uniqueId, v.routePoints);
        }
      });
      updateSystemKPIs();
      updateFleetBadge();
    }
    setSimulationStateUI(data.isRunning ? 'running' : 'stopped');
  } catch (err) {
    console.warn('Aviso ao buscar estado inicial:', err.message);
  }
}

function handleWsMessage(msg) {
  const { type, data } = msg;

  if (type === 'tick') {
    if (data.vehicles && Array.isArray(data.vehicles)) {
      data.vehicles.forEach(v => {
        activeVehiclesMap.set(v.uniqueId, v);
        mapManager.updateVehicleMarker(v);
      });
      updateSystemKPIs();
      updateFleetBadge();
      updateFollowVehicleSelect();

      // Modo Seguir Veículo em Tempo Real (Câmera Suave com Deadband)
      if (followVehicleId && activeVehiclesMap.has(followVehicleId) && currentTab === 'home') {
        const fv = activeVehiclesMap.get(followVehicleId);
        const fLat = fv?.lat ?? fv?.currentLat;
        const fLon = fv?.lon ?? fv?.currentLon;
        if (fLat && fLon && mapManager) {
          if (typeof mapManager.smoothFollowVehicle === 'function') {
            mapManager.smoothFollowVehicle(fLat, fLon, 16);
          } else if (mapManager.map) {
            mapManager.map.panTo([fLat, fLon], { animate: true, duration: 1.2 });
          }
        }
      }

      // Se a aba Home estiver aberta, atualiza a lista lateral de veículos
      if (currentTab === 'home') {
        renderHomeSidebarList();
      }

      // Se a aba Frota estiver aberta, atualiza a lista
      if (currentTab === 'fleet') {
        renderFleetTab();
      }

      // Se modal de detalhes de veículo estiver aberto, atualiza valores
      if (selectedVehicleForModal && activeVehiclesMap.has(selectedVehicleForModal)) {
        updateVehicleDetailModalContent(activeVehiclesMap.get(selectedVehicleForModal));
      }
    }
  } else if (type === 'telemetry_dispatched') {
    addLogEntry(data);
  } else if (type === 'simulation_started' || type === 'simulation_resumed') {
    setSimulationStateUI('running');
  } else if (type === 'simulation_paused') {
    setSimulationStateUI('paused');
  } else if (type === 'simulation_stopped') {
    setSimulationStateUI('stopped');
  } else if (type === 'config_updated') {
    if (data.timeMultiplier) {
      document.getElementById('simSpeedSelect').value = data.timeMultiplier;
    }
  } else if (type === 'vehicle_removed') {
    const uid = data.uniqueId;
    mapManager.removeVehicle(uid);
    activeVehiclesMap.delete(uid);
    selectedFleetVehicleIds.delete(uid);
    if (followVehicleId === uid) followVehicleId = '';
    if (selectedVehicleForModal === uid) closeVehicleDetailModal();
    updateSystemKPIs();
    updateFleetBadge();
    updateFollowVehicleSelect();
    renderFleetTab();
    renderHomeSidebarList();
    updateFleetSelectionUI();
  } else if (type === 'vehicles_bulk_removed') {
    const uids = data.uniqueIds || [];
    uids.forEach(uid => {
      mapManager.removeVehicle(uid);
      activeVehiclesMap.delete(uid);
      selectedFleetVehicleIds.delete(uid);
      if (followVehicleId === uid) followVehicleId = '';
      if (selectedVehicleForModal === uid) closeVehicleDetailModal();
    });
    updateSystemKPIs();
    updateFleetBadge();
    updateFollowVehicleSelect();
    renderFleetTab();
    renderHomeSidebarList();
    updateFleetSelectionUI();
  } else if (type === 'vehicles_cleared') {
    mapManager.clearVehicles();
    activeVehiclesMap.clear();
    selectedFleetVehicleIds.clear();
    followVehicleId = '';
    closeVehicleDetailModal();
    updateSystemKPIs();
    updateFleetBadge();
    updateFollowVehicleSelect();
    renderFleetTab();
    renderHomeSidebarList();
    updateFleetSelectionUI();
  }
}

// -------------------------------------------------------------
// KPIs Gerais do Sistema (Home)
// -------------------------------------------------------------
function updateSystemKPIs() {
  const vehicles = Array.from(activeVehiclesMap.values());
  const total = vehicles.length;

  let moving = 0;
  let trafficStop = 0;
  let parked = 0;
  let sumSpeed = 0;
  let sumOdometer = 0;

  vehicles.forEach(v => {
    if (v.state === 'MOVING') moving++;
    else if (v.state === 'TRAFFIC_STOP') trafficStop++;
    else if (v.state === 'PARKED_OFF' || !v.ignition) parked++;

    sumSpeed += (v.speedKmh || 0);
    sumOdometer += (v.totalDistance || 0);
  });

  const avgSpeed = total > 0 ? (sumSpeed / total).toFixed(0) : '0';
  const totalKm = (sumOdometer / 1000).toFixed(1);

  const elTotal = document.getElementById('kpiTotalVehicles');
  if (elTotal) elTotal.innerText = total;
  const elMoving = document.getElementById('kpiMovingVehicles');
  if (elMoving) elMoving.innerText = moving;
  const elTraffic = document.getElementById('kpiTrafficStopVehicles');
  if (elTraffic) elTraffic.innerText = trafficStop;
  const elParked = document.getElementById('kpiParkedVehicles');
  if (elParked) elParked.innerText = parked;
  const elAvg = document.getElementById('kpiAvgSpeed');
  if (elAvg) elAvg.innerHTML = `${avgSpeed} <span class="text-xs font-normal text-slate-400">km/h</span>`;
  const elOdo = document.getElementById('kpiTotalOdo');
  if (elOdo) elOdo.innerHTML = `${totalKm} <span class="text-xs font-normal text-slate-400">km</span>`;
}

function updateFleetBadge() {
  const total = activeVehiclesMap.size;
  const badge = document.getElementById('tabFleetBadge');
  if (badge) badge.innerText = total;

  let fakes = 0;
  let imported = 0;
  activeVehiclesMap.forEach(v => {
    if (v.isImported) imported++;
    else fakes++;
  });

  const headerCount = document.getElementById('fleetHeaderCount');
  if (headerCount) {
    if (total === 0) {
      headerCount.innerText = '0 veículos';
    } else {
      headerCount.innerHTML = `<span>${total} veículos</span> <span class="text-slate-400 font-normal">(${fakes} ⚡ Sintéticos • ${imported} 📥 Importados)</span>`;
    }
  }
}

// -------------------------------------------------------------
// Renderização da Lista de Veículos (Aba Frota)
// -------------------------------------------------------------
function renderFleetTab() {
  const container = document.getElementById('fleetCardsGrid');
  if (!container) return;

  const filterText = (document.getElementById('filterVehicleSearch')?.value || '').toLowerCase();
  let vehicles = Array.from(activeVehiclesMap.values());

  if (filterText) {
    vehicles = vehicles.filter(v =>
      (v.name && v.name.toLowerCase().includes(filterText)) ||
      (v.plate && v.plate.toLowerCase().includes(filterText)) ||
      (v.uniqueId && v.uniqueId.toLowerCase().includes(filterText))
    );
  }

  if (vehicles.length === 0) {
    if (container.dataset.hasEmpty !== 'true') {
      container.innerHTML = `
        <div class="col-span-full py-16 text-center text-slate-500 text-sm">
          ${activeVehiclesMap.size === 0 ? 'Nenhum veículo em circulação.' : 'Nenhum veículo corresponde à busca.'}<br>
          <button onclick="switchTab('create')" class="text-sky-400 hover:underline mt-2 inline-block font-medium">Clique aqui para criar e disparar veículos</button>
        </div>
      `;
      container.dataset.hasEmpty = 'true';
    }
    updateFleetSelectionUI();
    return;
  }
  container.dataset.hasEmpty = 'false';

  const stateBadges = {
    'MOVING': '<span class="text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded text-[11px] font-medium">Em Movimento</span>',
    'TRAFFIC_STOP': '<span class="text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded text-[11px] font-medium">Parado</span>',
    'PARKED_OFF': '<span class="text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded text-[11px] font-medium">Desligado</span>'
  };

  const getFleetOriginBadgeHtml = (isImported) => {
    if (isImported) {
      return `<span title="Veículo real importado da base do Traccar (não será excluído do Traccar ao remover do simulador)" class="inline-flex items-center gap-1 text-[10px] font-bold text-sky-300 bg-sky-500/15 border border-sky-500/30 px-2 py-0.5 rounded-full shrink-0 shadow-xs"><svg class="w-2.5 h-2.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>Importado</span>`;
    }
    return `<span title="Veículo sintético gerado pelo simulador (será excluído de ambos ao remover do simulador)" class="inline-flex items-center gap-1 text-[10px] font-bold text-purple-300 bg-purple-500/15 border border-purple-500/30 px-2 py-0.5 rounded-full shrink-0 shadow-xs"><svg class="w-2.5 h-2.5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>Sintético</span>`;
  };

  function getFleetPillsHtml(v) {
    let specialPills = '';
    if (v.engineBlocked) specialPills += '<span class="bg-rose-500/20 text-rose-300 border border-rose-500/40 px-1.5 py-0.5 rounded text-[10px] font-bold">BLOQ</span>';
    if (v.externalPowerCut) specialPills += '<span class="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.5 rounded text-[10px] font-bold">0V</span>';
    if (v.shadowZone) specialPills += `<span class="bg-purple-500/20 text-purple-300 border border-purple-500/40 px-1.5 py-0.5 rounded text-[10px] font-bold animate-pulse">SOMBRA (${v.offlineBufferCount || 0})</span>`;
    if (v.towingSim) specialPills += '<span class="bg-orange-500/20 text-orange-300 border border-orange-500/40 px-1.5 py-0.5 rounded text-[10px] font-bold">GUINCHO</span>';
    return specialPills;
  }

  const currentUids = new Set(vehicles.map(v => String(v.uniqueId)));

  // Remove cards that are no longer in the active list
  const existingCards = container.querySelectorAll('[data-fleet-vehicle-id]');
  existingCards.forEach(card => {
    const uid = card.getAttribute('data-fleet-vehicle-id');
    if (!currentUids.has(uid)) {
      card.remove();
    }
  });

  vehicles.forEach((v, index) => {
    const uid = String(v.uniqueId);
    const odoValue = (v.totalDistance || 0) / 1000;
    const formattedOdo = odoValue.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const powerValue = Number(v.power || 13.8).toFixed(1);
    const isChecked = selectedFleetVehicleIds.has(v.uniqueId);
    const speedFormatted = Math.round(Number(v.speedKmh) || 0);
    const fuelFormatted = Math.round(v.fuel || 75);
    const specialPillsHtml = getFleetPillsHtml(v);
    const pillsKey = `${v.engineBlocked ? 1 : 0}-${v.externalPowerCut ? 1 : 0}-${v.shadowZone ? 1 : 0}-${v.towingSim ? 1 : 0}-${v.offlineBufferCount || 0}`;

    let card = document.getElementById(`fleet-card-${uid}`);

    if (!card) {
      card = document.createElement('div');
      card.id = `fleet-card-${uid}`;
      card.setAttribute('data-fleet-vehicle-id', uid);
      card.setAttribute('onclick', `openVehicleDetailModal('${uid}')`);
      card.className = `bg-slate-900 border ${isChecked ? 'border-sky-500 bg-sky-950/20' : 'border-slate-800'} hover:border-sky-500/50 rounded-2xl p-4 transition-all cursor-pointer shadow-md hover:shadow-sky-500/5 group relative`;
      card.dataset.state = v.state;
      card.dataset.checked = String(isChecked);
      card.dataset.pills = pillsKey;
      card.dataset.ignition = String(v.ignition);
      card.dataset.isImported = String(!!v.isImported);

      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-start gap-2.5 min-w-0 pr-1">
            <input type="checkbox" ${isChecked ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleVehicleSelection('${uid}', this.checked)" class="fleet-checkbox rounded bg-slate-950 border-slate-700 text-sky-500 focus:ring-0 w-4 h-4 cursor-pointer mt-1 shrink-0">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-bold text-sm text-white group-hover:text-sky-400 transition-colors truncate">
                  ${v.name}
                </span>
                <span class="fleet-origin-badge">${getFleetOriginBadgeHtml(v.isImported)}</span>
              </div>
              <div class="text-xs text-slate-400 font-mono mt-0.5 truncate">ID: ${v.uniqueId} | ${v.model}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
            <div class="fleet-card-pills flex items-center gap-1.5">${specialPillsHtml}</div>
            <div class="fleet-card-state">${stateBadges[v.state] || v.state}</div>
            <button onclick="event.stopPropagation(); removeSingleVehicle('${uid}')" title="Excluir Dispositivo" class="p-1 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-slate-800/80 text-xs">
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
            <div class="text-[10px] text-slate-400">Velocidade</div>
            <div class="font-bold text-sky-400 text-sm font-mono"><span class="fleet-speed">${speedFormatted}</span> <span class="text-[10px] text-slate-500 font-normal">km/h</span></div>
          </div>
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
            <div class="text-[10px] text-slate-400">Ignição</div>
            <div class="fleet-ignition font-bold ${v.ignition ? 'text-emerald-400' : 'text-rose-400'} text-sm font-mono flex items-center gap-1.5">
              <span class="w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
              <span>${v.ignition ? 'LIGADA' : 'DESLIGADA'}</span>
            </div>
          </div>
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
            <div class="text-[10px] text-slate-400">Tensão Bateria</div>
            <div class="fleet-power font-bold text-slate-200 text-sm font-mono">${powerValue}V</div>
          </div>
          <div class="bg-slate-950/70 border border-slate-800/80 rounded-xl px-2.5 py-1.5 overflow-hidden">
            <div class="text-[10px] text-slate-400">Odômetro</div>
            <div class="fleet-odometer font-bold text-slate-200 text-sm font-mono truncate" title="${formattedOdo} km">${formattedOdo} <span class="text-[10px] text-slate-500 font-normal">km</span></div>
          </div>
        </div>

        <div class="mt-3 pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-400">
          <span>Combustível: <b class="fleet-fuel text-slate-200">${fuelFormatted}%</b></span>
          <span class="text-sky-400 group-hover:underline flex items-center gap-1">Ver Detalhes →</span>
        </div>
      `;
      container.appendChild(card);
    } else {
      // Card já existe: atualiza cirurgicamente sem recriar os nós DOM
      const speedEl = card.querySelector('.fleet-speed');
      if (speedEl && speedEl.textContent !== String(speedFormatted)) speedEl.textContent = speedFormatted;

      const powerEl = card.querySelector('.fleet-power');
      if (powerEl && powerEl.textContent !== `${powerValue}V`) powerEl.textContent = `${powerValue}V`;

      const odoEl = card.querySelector('.fleet-odometer');
      if (odoEl) {
        odoEl.innerHTML = `${formattedOdo} <span class="text-[10px] text-slate-500 font-normal">km</span>`;
        odoEl.title = `${formattedOdo} km`;
      }

      const fuelEl = card.querySelector('.fleet-fuel');
      if (fuelEl && fuelEl.textContent !== `${fuelFormatted}%`) fuelEl.textContent = `${fuelFormatted}%`;

      if (card.dataset.ignition !== String(v.ignition)) {
        card.dataset.ignition = String(v.ignition);
        const ignEl = card.querySelector('.fleet-ignition');
        if (ignEl) {
          ignEl.className = `fleet-ignition font-bold ${v.ignition ? 'text-emerald-400' : 'text-rose-400'} text-sm font-mono flex items-center gap-1.5`;
          ignEl.innerHTML = `
            <span class="w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
            <span>${v.ignition ? 'LIGADA' : 'DESLIGADA'}</span>
          `;
        }
      }

      if (card.dataset.state !== v.state) {
        card.dataset.state = v.state;
        const stateEl = card.querySelector('.fleet-card-state');
        if (stateEl) stateEl.innerHTML = stateBadges[v.state] || v.state;
      }

      if (card.dataset.isImported !== String(!!v.isImported)) {
        card.dataset.isImported = String(!!v.isImported);
        const originEl = card.querySelector('.fleet-origin-badge');
        if (originEl) originEl.innerHTML = getFleetOriginBadgeHtml(v.isImported);
      }

      if (card.dataset.pills !== pillsKey) {
        card.dataset.pills = pillsKey;
        const pillsEl = card.querySelector('.fleet-card-pills');
        if (pillsEl) pillsEl.innerHTML = specialPillsHtml;
      }

      if (card.dataset.checked !== String(isChecked)) {
        card.dataset.checked = String(isChecked);
        const cb = card.querySelector('.fleet-checkbox');
        if (cb) cb.checked = isChecked;
        if (isChecked) {
          card.classList.add('border-sky-500', 'bg-sky-950/20');
          card.classList.remove('border-slate-800');
        } else {
          card.classList.remove('border-sky-500', 'bg-sky-950/20');
          card.classList.add('border-slate-800');
        }
      }

      if (container.children[index] !== card) {
        container.insertBefore(card, container.children[index] || null);
      }
    }
  });

  updateFleetSelectionUI();
}

// -------------------------------------------------------------
// Modal de Detalhes e Estatísticas de um Veículo (3 Estágios: compact, expanded, collapsed)
// -------------------------------------------------------------
let vehicleModalMode = 'compact'; // 'compact' (padrão) | 'expanded' | 'collapsed'
let activeVehicleModalSubTab = 'cockpit'; // 'cockpit' | 'history'

window.applyVehicleModalModeClasses = function() {
  const modal = document.getElementById('vehicleDetailModal');
  if (!modal) return;

  modal.classList.remove('w-80', 'sm:w-88', 'w-96', 'sm:w-[420px]', 'w-[620px]', 'sm:w-[680px]', 'bottom-3', 'cursor-pointer');

  if (vehicleModalMode === 'collapsed') {
    modal.classList.add('w-96', 'sm:w-[420px]', 'cursor-pointer');
  } else if (vehicleModalMode === 'expanded') {
    modal.classList.add('w-[620px]', 'sm:w-[680px]', 'bottom-3');
  } else {
    // 'compact' (default)
    modal.classList.add('w-80', 'sm:w-88', 'bottom-3');
  }
};

window.collapseVehicleModal = function() {
  vehicleModalMode = 'collapsed';
  applyVehicleModalModeClasses();
  if (selectedVehicleForModal && activeVehiclesMap.has(selectedVehicleForModal)) {
    updateVehicleDetailModalContent(activeVehiclesMap.get(selectedVehicleForModal), true);
  }
};

window.restoreVehicleModalToCompact = function() {
  vehicleModalMode = 'compact';
  applyVehicleModalModeClasses();
  if (selectedVehicleForModal && activeVehiclesMap.has(selectedVehicleForModal)) {
    updateVehicleDetailModalContent(activeVehiclesMap.get(selectedVehicleForModal), true);
  }
};

window.toggleVehicleModalExpand = function() {
  if (vehicleModalMode === 'expanded') {
    vehicleModalMode = 'compact';
  } else {
    vehicleModalMode = 'expanded';
  }
  applyVehicleModalModeClasses();
  if (selectedVehicleForModal && activeVehiclesMap.has(selectedVehicleForModal)) {
    updateVehicleDetailModalContent(activeVehiclesMap.get(selectedVehicleForModal), true);
  }
};

window.openVehicleDetailModal = function(uniqueId) {
  selectedVehicleForModal = uniqueId;
  const v = activeVehiclesMap.get(uniqueId);
  if (!v) return;

  const modal = document.getElementById('vehicleDetailModal');
  if (!modal) return;

  // Se o modal estava oculto ou em modo colapsado, o default ao abrir pelo card é o modo compacto
  if (modal.classList.contains('hidden') || vehicleModalMode === 'collapsed') {
    vehicleModalMode = 'compact';
  }

  applyVehicleModalModeClasses();

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  updateVehicleDetailModalContent(v, true);
};

window.closeVehicleDetailModal = function() {
  selectedVehicleForModal = null;
  const modal = document.getElementById('vehicleDetailModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

// -------------------------------------------------------------
// Funções do Cockpit: Sensores, Cenários, Alarmes e Zona de Sombra (Fase 7 & 8)
// -------------------------------------------------------------
window.setVehicleIgnition = async function(uniqueId, mode) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/sensors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignition: mode })
    });
  } catch (e) {
    console.error('Erro ao alterar ignição:', e);
  }
};

window.toggleExternalPower = async function(uniqueId, isCut) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/sensors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ externalPowerCut: isCut })
    });
  } catch (e) {
    console.error('Erro ao alterar alimentação:', e);
  }
};

window.toggleEngineBlock = async function(uniqueId, isBlocked) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/sensors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engineBlocked: isBlocked })
    });
  } catch (e) {
    console.error('Erro ao alterar bloqueio:', e);
  }
};

window.toggleTowing = async function(uniqueId, isTowing) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/sensors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ towingSim: isTowing })
    });
  } catch (e) {
    console.error('Erro ao alterar modo guincho:', e);
  }
};

window.toggleShadowZone = async function(uniqueId, isShadow) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/sensors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shadowZone: isShadow })
    });
  } catch (e) {
    console.error('Erro ao alterar zona de sombra:', e);
  }
};

window.flushVehicleShadow = async function(uniqueId) {
  try {
    const res = await fetch(`/api/simulation/vehicles/${uniqueId}/flush-shadow`, {
      method: 'POST'
    });
    const data = await res.json();
    alert(`Rajada disparada! ${data.count || 0} posições descarregadas no Traccar com sucesso.`);
  } catch (e) {
    console.error('Erro ao descarregar buffer:', e);
  }
};

window.triggerVehicleScenario = async function(uniqueId, scenario) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    });
  } catch (e) {
    console.error('Erro ao disparar cenário:', e);
  }
};

window.triggerVehicleAlarm = async function(uniqueId, alarm) {
  try {
    await fetch(`/api/simulation/vehicles/${uniqueId}/alarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alarm })
    });
  } catch (e) {
    console.error('Erro ao disparar alarme:', e);
  }
};

const VEHICLE_STATE_MAP = {
  'MOVING': { label: 'Em Movimento', badgeClass: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' },
  'TRAFFIC_STOP': { label: 'Parado', badgeClass: 'bg-amber-500/10 text-amber-400 border border-amber-500/20' },
  'PARKED_OFF': { label: 'Desligado', badgeClass: 'bg-rose-500/10 text-rose-400 border border-rose-500/20' }
};

window.setVehicleModalSubTab = function(subTab) {
  activeVehicleModalSubTab = subTab;
  if (selectedVehicleForModal && activeVehiclesMap.has(selectedVehicleForModal)) {
    updateVehicleDetailModalContent(activeVehiclesMap.get(selectedVehicleForModal), true);
  }
};

function renderExpandedHardwareControls(v) {
  return `
    <div class="flex items-center justify-between">
      <div>
        <h4 class="text-xs font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
          <span>🕹️</span> Controles de Hardware & Relés de Telemetria
        </h4>
        <p class="text-[11px] text-slate-400 mt-0.5">Comandos de atuadores enviados via protocolo e refletidos no Traccar</p>
      </div>
      <span class="text-[11px] text-slate-500 font-mono bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
        ${v.manualIgnition !== null ? 'Modo Manual' : 'Ciclo Automático'}
      </span>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <!-- Ignição -->
      <div class="bg-slate-900 border border-slate-800/80 rounded-xl p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-white">Ignição (Pós-Chave)</span>
          <span class="text-[10px] font-bold ${v.ignition ? 'text-emerald-400' : 'text-rose-400'}">
            ${v.ignition ? '● LIGADA' : '○ DESLIGADA'}
          </span>
        </div>
        <p class="text-[10px] text-slate-400">Comuta o sensor digital de ignição do veículo.</p>
        <div class="grid grid-cols-3 gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800/60 text-xs">
          <button onclick="setVehicleIgnition('${v.uniqueId}', null)" class="py-1 px-1.5 rounded text-[11px] font-medium transition-all ${v.manualIgnition === null ? 'bg-sky-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'}">
            Auto
          </button>
          <button onclick="setVehicleIgnition('${v.uniqueId}', true)" class="py-1 px-1.5 rounded text-[11px] font-medium transition-all ${v.manualIgnition === true ? 'bg-emerald-600 text-white shadow' : 'text-slate-400 hover:text-emerald-300'}">
            Ligada
          </button>
          <button onclick="setVehicleIgnition('${v.uniqueId}', false)" class="py-1 px-1.5 rounded text-[11px] font-medium transition-all ${v.manualIgnition === false ? 'bg-rose-600 text-white shadow' : 'text-slate-400 hover:text-rose-300'}">
            Desligada
          </button>
        </div>
      </div>

      <!-- Alimentação Externa (VCC) -->
      <div class="bg-slate-900 border border-slate-800/80 rounded-xl p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-white">Alimentação VCC (Bateria Principal)</span>
          <span class="text-[10px] font-bold ${v.externalPowerCut ? 'text-amber-400' : 'text-emerald-400'}">
            ${v.externalPowerCut ? '0.0V (Backup)' : '13.8V (Conectada)'}
          </span>
        </div>
        <p class="text-[10px] text-slate-400">Simula corte de chicote ou desconexão da bateria automotiva.</p>
        <button onclick="toggleExternalPower('${v.uniqueId}', ${!v.externalPowerCut})" class="w-full py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all flex items-center justify-center gap-1.5 ${v.externalPowerCut ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 hover:bg-amber-500/30' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}">
          <span>${v.externalPowerCut ? '🔌 Reconectar Alimentação VCC' : '⚡ Cortar Alimentação VCC (0V)'}</span>
        </button>
      </div>

      <!-- Bloqueio de Motor -->
      <div class="bg-slate-900 border border-slate-800/80 rounded-xl p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-white">Bloqueio Remoto (Relé de Bomba)</span>
          <span class="text-[10px] font-bold ${v.engineBlocked ? 'text-rose-400' : 'text-slate-400'}">
            ${v.engineBlocked ? '🔒 BLOQUEADO' : '🔓 LIBERADO'}
          </span>
        </div>
        <p class="text-[10px] text-slate-400">Aciona o relé de corte de combustível, forçando desaceleração e parada.</p>
        <button onclick="toggleEngineBlock('${v.uniqueId}', ${!v.engineBlocked})" class="w-full py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all flex items-center justify-center gap-1.5 ${v.engineBlocked ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}">
          <span>${v.engineBlocked ? '🔓 Liberar Bloqueio do Motor' : '🔒 Ativar Bloqueio Remoto'}</span>
        </button>
      </div>

      <!-- Modo Guincho -->
      <div class="bg-slate-900 border border-slate-800/80 rounded-xl p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-white">Modo Guincho / Reboque</span>
          <span class="text-[10px] font-bold ${v.towingSim ? 'text-orange-400' : 'text-slate-400'}">
            ${v.towingSim ? '🚜 EM REBOQUE' : 'INATIVO'}
          </span>
        </div>
        <p class="text-[10px] text-slate-400">Simula movimentação do veículo com motor e ignição completamente desligados.</p>
        <button onclick="toggleTowing('${v.uniqueId}', ${!v.towingSim})" class="w-full py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all flex items-center justify-center gap-1.5 ${v.towingSim ? 'bg-orange-500/20 text-orange-300 border-orange-500/40 hover:bg-orange-500/30' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}">
          <span>${v.towingSim ? '⏹️ Parar Modo Guincho' : '🚜 Ativar Simulação de Guincho'}</span>
        </button>
      </div>
    </div>

    <!-- Buffer Offline (Zona de Sombra) -->
    <div class="bg-slate-900 border ${v.shadowZone ? 'border-purple-500/50 bg-purple-950/20' : 'border-slate-800/80'} rounded-xl p-3.5 space-y-2">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-xs font-semibold text-white flex items-center gap-2">
            <span>📡</span> Buffer de Zona de Sombra (Modo Offline / Sem Sinal GSM)
            ${v.shadowZone ? '<span class="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></span>' : ''}
          </div>
          <p class="text-[11px] text-slate-400 mt-0.5">Retém posições na memória flash do rastreador sem despachar ao Traccar até que o sinal retorne.</p>
        </div>
        <button onclick="toggleShadowZone('${v.uniqueId}', ${!v.shadowZone})" class="py-1.5 px-3 rounded-lg text-xs font-semibold border transition-all ${v.shadowZone ? 'bg-purple-600 text-white border-purple-500 shadow-md shadow-purple-600/30' : 'bg-slate-950 text-slate-300 border-slate-800 hover:border-slate-700'}">
          ${v.shadowZone ? '● Sair da Sombra (Online)' : '○ Entrar em Zona de Sombra'}
        </button>
      </div>

      ${v.shadowZone || (v.offlineBufferCount && v.offlineBufferCount > 0) ? `
        <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs">
          <span class="text-purple-300 font-mono text-[11px] flex items-center gap-1.5">
            <span class="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></span>
            ${v.offlineBufferCount || 0} pacotes retidos na fila offline
          </span>
          <button onclick="flushVehicleShadow('${v.uniqueId}')" class="bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/40 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5">
            ⚡ Descarregar em Rajada Agora
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderCompactHardwareControls(v) {
  return `
    <div class="flex items-center justify-between text-[11px] font-bold text-sky-400 uppercase tracking-wider">
      <span>Controles de Hardware</span>
      <span class="text-[9px] text-slate-500 font-normal font-sans">Toque para alternar</span>
    </div>

    <!-- Ignição Segmentada -->
    <div class="bg-slate-900 border border-slate-800/80 rounded-xl p-2 flex items-center justify-between gap-1">
      <span class="text-[11px] font-medium text-slate-300">Ignição</span>
      <div class="flex gap-1 bg-slate-950 p-0.5 rounded-lg border border-slate-800/80 text-[10px]">
        <button onclick="setVehicleIgnition('${v.uniqueId}', null)" class="py-0.5 px-1.5 rounded transition-all ${v.manualIgnition === null ? 'bg-sky-600 text-white font-bold' : 'text-slate-400'}">Auto</button>
        <button onclick="setVehicleIgnition('${v.uniqueId}', true)" class="py-0.5 px-1.5 rounded transition-all ${v.manualIgnition === true ? 'bg-emerald-600 text-white font-bold' : 'text-slate-400'}">LIG</button>
        <button onclick="setVehicleIgnition('${v.uniqueId}', false)" class="py-0.5 px-1.5 rounded transition-all ${v.manualIgnition === false ? 'bg-rose-600 text-white font-bold' : 'text-slate-400'}">OFF</button>
      </div>
    </div>

    <!-- Toggles Rápidos em Grid -->
    <div class="grid grid-cols-2 gap-1.5">
      <button onclick="toggleExternalPower('${v.uniqueId}', ${!v.externalPowerCut})" class="p-2 rounded-xl text-[11px] font-semibold border transition-all flex items-center justify-between ${v.externalPowerCut ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'}">
        <span>⚡ VCC</span>
        <span class="text-[10px] font-mono">${v.externalPowerCut ? '0V' : '13.8V'}</span>
      </button>

      <button onclick="toggleEngineBlock('${v.uniqueId}', ${!v.engineBlocked})" class="p-2 rounded-xl text-[11px] font-semibold border transition-all flex items-center justify-between ${v.engineBlocked ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'}">
        <span>🔒 Bloqueio</span>
        <span class="text-[10px] font-mono">${v.engineBlocked ? 'SIM' : 'NÃO'}</span>
      </button>

      <button onclick="toggleTowing('${v.uniqueId}', ${!v.towingSim})" class="p-2 rounded-xl text-[11px] font-semibold border transition-all flex items-center justify-between ${v.towingSim ? 'bg-orange-500/20 text-orange-300 border-orange-500/40' : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'}">
        <span>🚜 Guincho</span>
        <span class="text-[10px] font-mono">${v.towingSim ? 'ON' : 'OFF'}</span>
      </button>

      <button onclick="toggleShadowZone('${v.uniqueId}', ${!v.shadowZone})" class="p-2 rounded-xl text-[11px] font-semibold border transition-all flex items-center justify-between ${v.shadowZone ? 'bg-purple-600 text-white border-purple-500' : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'}">
        <span>📡 Sombra</span>
        <span class="text-[10px] font-mono">${v.shadowZone ? `ON (${v.offlineBufferCount || 0})` : 'OFF'}</span>
      </button>
    </div>

    ${v.shadowZone || (v.offlineBufferCount && v.offlineBufferCount > 0) ? `
      <button onclick="flushVehicleShadow('${v.uniqueId}')" class="w-full py-1.5 px-2 rounded-lg bg-purple-500/20 text-purple-300 border border-purple-500/40 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors">
        ⚡ Descarregar Buffer (${v.offlineBufferCount || 0} posições)
      </button>
    ` : ''}
  `;
}

function updateVehicleDetailModalContent(v, forceRerender = false) {
  const header = document.getElementById('vehicleDetailHeader');
  const container = document.getElementById('vehicleDetailContent');
  if (!container || !header) return;

  const odoValue = (v.totalDistance || 0) / 1000;
  const formattedOdo = odoValue.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const odoCompact = Math.round(odoValue) > 999 ? Math.round(odoValue).toLocaleString('pt-BR') : odoValue.toFixed(1);
  const powerValue = Number(v.power || 0).toFixed(1);
  const speedFormatted = Math.round(Number(v.speedKmh) || 0);
  const fuelFormatted = Math.round(v.fuel || 75);
  const bearingFormatted = Math.round(v.bearing || 0);

  // Status unificado padronizado com o card da sidebar
  const st = VEHICLE_STATE_MAP[v.state] || { label: v.state, badgeClass: 'bg-slate-800 text-slate-300' };

  // Status badges adicionais do Cockpit
  let statusBadgesHtml = '';
  if (v.engineBlocked) {
    statusBadgesHtml += '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">BLOQUEADO</span>';
  }
  if (v.externalPowerCut) {
    statusBadgesHtml += '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">0V VCC</span>';
  }
  if (v.shadowZone) {
    statusBadgesHtml += `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 animate-pulse">SOMBRA (${v.offlineBufferCount || 0})</span>`;
  }
  if (v.towingSim) {
    statusBadgesHtml += '<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 border border-orange-500/30">GUINCHO</span>';
  }

  const originBadgeHtml = v.isImported
    ? '<span title="Dispositivo real importado do Traccar (não será excluído do Traccar ao remover do simulador)" class="inline-flex items-center gap-1 text-[9px] font-bold text-sky-300 bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 rounded-full shrink-0 shadow-xs"><svg class="w-2.5 h-2.5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>Importado</span>'
    : '<span title="Veículo sintético gerado pelo simulador (será excluído de ambos ao remover do simulador)" class="inline-flex items-center gap-1 text-[9px] font-bold text-purple-300 bg-purple-500/15 border border-purple-500/30 px-1.5 py-0.5 rounded-full shrink-0 shadow-xs"><svg class="w-2.5 h-2.5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>Sintético</span>';

  const pillsKey = `${v.engineBlocked ? 1 : 0}-${v.externalPowerCut ? 1 : 0}-${v.shadowZone ? 1 : 0}-${v.towingSim ? 1 : 0}-${v.offlineBufferCount || 0}`;

  // Filtra logs específicos deste veículo
  const vehicleLogs = telemetryLogsHistory.filter(l => l.uniqueId === v.uniqueId);
  const logsCount = vehicleLogs.length;

  // 1. ATUALIZAÇÃO DO CABEÇALHO (HEADER) - PRESERVANDO ELEMENTOS DOM
  const headerKey = `${v.uniqueId}-${vehicleModalMode}-${v.isImported ? 1 : 0}`;
  if (header.dataset.headerKey !== headerKey || forceRerender) {
    header.dataset.headerKey = headerKey;
    header.dataset.state = v.state;
    header.dataset.pills = pillsKey;
    header.dataset.subTab = activeVehicleModalSubTab;
    header.dataset.logsCount = String(logsCount);

    if (vehicleModalMode === 'collapsed') {
      header.innerHTML = `
        <div class="flex items-center justify-between gap-2.5" onclick="restoreVehicleModalToCompact()">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"/></svg>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-xs font-bold text-white truncate">${v.name}</h3>
                ${originBadgeHtml}
                <span class="modal-state-badge text-[9px] px-1.5 py-0.2 rounded-full font-semibold ${st.badgeClass}">${st.label}</span>
              </div>
              <p class="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                ID: <b class="text-sky-400">${v.uniqueId}</b> • Placa: <b class="text-slate-200">${v.plate || 'N/A'}</b>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button onclick="event.stopPropagation(); restoreVehicleModalToCompact()" title="Restaurar Cockpit Completo" class="flex items-center gap-1 bg-slate-800/90 hover:bg-sky-600 text-slate-300 hover:text-white px-2 py-1 rounded-lg text-[10px] font-semibold border border-slate-700/60 transition-all shadow-sm">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
              <span>Expandir</span>
            </button>
          </div>
        </div>
      `;
    } else {
      header.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-8 h-8 rounded-xl bg-sky-500/10 border border-sky-500/20 text-sky-400 flex items-center justify-center shrink-0">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0"/></svg>
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <h3 class="text-sm font-bold text-white truncate">${v.name}</h3>
                ${originBadgeHtml}
                <span class="modal-state-badge text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${st.badgeClass}">
                  ${st.label}
                </span>
                <div class="modal-status-pills flex items-center gap-1">${statusBadgesHtml}</div>
              </div>
              <p class="text-[10px] text-slate-400 font-mono mt-0.5 truncate">
                ID: <b class="text-sky-400">${v.uniqueId}</b> • Placa: <b class="text-slate-200">${v.plate || 'N/A'}</b>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <!-- Botão Expandir / Compactar -->
            <button onclick="toggleVehicleModalExpand()" title="${vehicleModalMode === 'expanded' ? 'Compactar para modo rápido' : 'Expandir com descrições detalhadas'}" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors">
              ${vehicleModalMode === 'expanded' ? `
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9L4 4m0 0l5 0m-5 0l0 5m11 11l5 5m0 0l-5 0m5 0l0-5M4 20l5-5m0 0l-5 0m5 0l0 5m11-11l5-5m0 0l-5 0m5 0l0 5"/></svg>
              ` : `
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
              `}
            </button>
            <!-- Botão Colapsar -->
            <button onclick="collapseVehicleModal()" title="Minimizar para estatísticas pequenas" class="text-slate-400 hover:text-amber-400 p-1 rounded-lg hover:bg-slate-800 transition-colors">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4"/></svg>
            </button>
          </div>
        </div>

        <!-- Abas Internas do Modal: Testes & Atuadores vs Histórico -->
        <div class="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800/80 mt-0.5">
          <button onclick="setVehicleModalSubTab('cockpit')" class="subtab-cockpit-btn flex-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${activeVehicleModalSubTab === 'cockpit' ? 'bg-sky-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}">
            <span>🧪 Testes & Atuadores</span>
          </button>
          <button onclick="setVehicleModalSubTab('history')" class="subtab-history-btn flex-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${activeVehicleModalSubTab === 'history' ? 'bg-sky-600 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'}">
            <span>📜 Histórico</span>
            <span class="modal-history-count text-[10px] font-mono px-1.5 py-0.2 rounded-full ${activeVehicleModalSubTab === 'history' ? 'bg-white/20 text-white' : 'bg-slate-800 text-slate-400'}">${logsCount}</span>
          </button>
        </div>
      `;
    }
  } else {
    // Header já existe no DOM: preservar nós e atualizar apenas valores dinâmicos
    if (header.dataset.state !== v.state) {
      header.dataset.state = v.state;
      const stEl = header.querySelector('.modal-state-badge');
      if (stEl) {
        stEl.className = `modal-state-badge text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${st.badgeClass}`;
        stEl.textContent = st.label;
      }
    }

    if (header.dataset.pills !== pillsKey) {
      header.dataset.pills = pillsKey;
      const pillsEl = header.querySelector('.modal-status-pills');
      if (pillsEl) pillsEl.innerHTML = statusBadgesHtml;
    }

    if (header.dataset.logsCount !== String(logsCount)) {
      header.dataset.logsCount = String(logsCount);
      const countEl = header.querySelector('.modal-history-count');
      if (countEl) countEl.textContent = logsCount;
    }

    if (header.dataset.subTab !== activeVehicleModalSubTab) {
      header.dataset.subTab = activeVehicleModalSubTab;
      const cockpitBtn = header.querySelector('.subtab-cockpit-btn');
      const historyBtn = header.querySelector('.subtab-history-btn');
      if (cockpitBtn && historyBtn) {
        if (activeVehicleModalSubTab === 'cockpit') {
          cockpitBtn.className = 'subtab-cockpit-btn flex-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 bg-sky-600 text-white shadow-sm';
          historyBtn.className = 'subtab-history-btn flex-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 text-slate-400 hover:text-slate-200';
        } else {
          cockpitBtn.className = 'subtab-cockpit-btn flex-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 text-slate-400 hover:text-slate-200';
          historyBtn.className = 'subtab-history-btn flex-1 py-1 px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 bg-sky-600 text-white shadow-sm';
        }
      }
    }
  }

  // 2. ATUALIZAÇÃO DO CONTEÚDO (CONTAINER BODY)
  // CASO A: MODO COLAPSADO
  if (vehicleModalMode === 'collapsed') {
    const colViewKey = `${v.uniqueId}-collapsed`;
    if (container.dataset.viewKey !== colViewKey || forceRerender) {
      container.dataset.viewKey = colViewKey;
      container.innerHTML = `
        <div onclick="restoreVehicleModalToCompact()" class="bg-slate-950/80 border border-slate-800/80 rounded-xl p-2.5 flex items-center justify-between divide-x divide-slate-800/70 hover:border-sky-500/40 transition-colors cursor-pointer shadow-inner">
          <div class="flex-1 text-center px-1">
            <div class="text-[10px] text-slate-400 font-medium truncate">Velocidade</div>
            <div class="mt-1 flex items-baseline justify-center gap-0.5 font-mono">
              <span id="modal-col-speed" class="text-sky-400 font-bold text-sm leading-none">${speedFormatted}</span>
              <span class="text-[9px] text-slate-500 font-sans leading-none">km/h</span>
            </div>
          </div>
          <div class="flex-1 text-center px-1">
            <div class="text-[10px] text-slate-400 font-medium truncate">Ignição</div>
            <div class="mt-1 flex items-center justify-center gap-1 leading-none">
              <span id="modal-col-ign-dot" class="w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}"></span>
              <span id="modal-col-ign-text" class="${v.ignition ? 'text-emerald-400' : 'text-rose-400'} font-bold text-xs font-mono leading-none">
                ${v.ignition ? 'LIGADA' : 'OFF'}
              </span>
            </div>
          </div>
          <div class="flex-1 text-center px-1">
            <div class="text-[10px] text-slate-400 font-medium truncate">Bateria</div>
            <div class="mt-1 flex items-baseline justify-center gap-0.5 font-mono">
              <span id="modal-col-power" class="${v.externalPowerCut ? 'text-amber-400' : 'text-slate-100'} font-bold text-sm leading-none">${powerValue}</span>
              <span class="text-[9px] text-slate-500 font-sans leading-none">V</span>
            </div>
          </div>
          <div class="flex-1 text-center px-1">
            <div class="text-[10px] text-slate-400 font-medium truncate">Tanque</div>
            <div class="mt-1 flex items-baseline justify-center gap-0.5 font-mono">
              <span id="modal-col-fuel" class="text-emerald-400 font-bold text-sm leading-none">${fuelFormatted}</span>
              <span class="text-[9px] text-slate-500 font-sans leading-none">%</span>
            </div>
          </div>
          <div class="flex-1 text-center px-1">
            <div class="text-[10px] text-slate-400 font-medium truncate">Odômetro</div>
            <div class="mt-1 flex items-baseline justify-center gap-0.5 font-mono" id="modal-col-odo-wrap" title="${formattedOdo} km">
              <span id="modal-col-odo" class="text-slate-200 font-bold text-sm leading-none">${odoCompact}</span>
              <span class="text-[9px] text-slate-500 font-sans leading-none">km</span>
            </div>
          </div>
        </div>
      `;
    } else {
      // Atualiza valores cirurgicamente sem recriar o container
      const speedEl = document.getElementById('modal-col-speed');
      if (speedEl && speedEl.textContent !== String(speedFormatted)) speedEl.textContent = speedFormatted;

      const ignDot = document.getElementById('modal-col-ign-dot');
      const ignTxt = document.getElementById('modal-col-ign-text');
      if (ignDot && ignTxt) {
        ignDot.className = `w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`;
        ignTxt.className = `${v.ignition ? 'text-emerald-400' : 'text-rose-400'} font-bold text-xs font-mono leading-none`;
        ignTxt.textContent = v.ignition ? 'LIGADA' : 'OFF';
      }

      const powerEl = document.getElementById('modal-col-power');
      if (powerEl && powerEl.textContent !== powerValue) {
        powerEl.className = `${v.externalPowerCut ? 'text-amber-400' : 'text-slate-100'} font-bold text-sm leading-none`;
        powerEl.textContent = powerValue;
      }

      const fuelEl = document.getElementById('modal-col-fuel');
      if (fuelEl && fuelEl.textContent !== String(fuelFormatted)) fuelEl.textContent = fuelFormatted;

      const odoEl = document.getElementById('modal-col-odo');
      const odoWrap = document.getElementById('modal-col-odo-wrap');
      if (odoEl && odoEl.textContent !== odoCompact) odoEl.textContent = odoCompact;
      if (odoWrap) odoWrap.title = `${formattedOdo} km`;
    }
    return;
  }

  // CASO B: SUB-ABA HISTÓRICO
  if (activeVehicleModalSubTab === 'history') {
    const histViewKey = `${v.uniqueId}-history`;
    if (container.dataset.viewKey !== histViewKey || forceRerender) {
      container.dataset.viewKey = histViewKey;
      container.dataset.logsCount = String(vehicleLogs.length);

      if (vehicleLogs.length === 0) {
        container.innerHTML = `
          <div class="py-16 text-center text-slate-500 font-sans text-xs">
            Nenhum disparo de comando ou telemetria registrado para este veículo ainda.
          </div>
        `;
        return;
      }

      container.innerHTML = `
        <div class="space-y-2">
          <div class="flex items-center justify-between text-[11px] text-slate-400 px-1">
            <span id="modal-history-subcount">Últimos ${vehicleLogs.length} disparos:</span>
            <span class="font-mono text-emerald-400 text-[10px]">Tempo Real</span>
          </div>
          <div class="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
            <div class="max-h-[calc(100vh-250px)] overflow-y-auto">
              <table class="w-full text-left text-[11px] font-mono">
                <thead class="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800 text-[10px]">
                  <tr>
                    <th class="py-2 px-2">Horário</th>
                    <th class="py-2 px-2">Status</th>
                    <th class="py-2 px-2">Vel.</th>
                    <th class="py-2 px-2">Ignição</th>
                    <th class="py-2 px-2">VCC</th>
                    <th class="py-2 px-1 text-center">Payload</th>
                  </tr>
                </thead>
                <tbody id="modal-history-tbody" class="divide-y divide-slate-800/40">
                  ${vehicleLogs.map(item => `
                    <tr class="hover:bg-slate-900/50 transition-colors">
                      <td class="py-1.5 px-2 text-slate-400 whitespace-nowrap">${item.time}</td>
                      <td class="py-1.5 px-2 whitespace-nowrap">
                        <span class="px-1.5 py-0.2 rounded text-[9px] font-bold ${item.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
                          ${item.success ? `HTTP ${item.status}` : 'FALHA'}
                        </span>
                      </td>
                      <td class="py-1.5 px-2 text-slate-200 whitespace-nowrap">${item.speedKmh} km/h</td>
                      <td class="py-1.5 px-2 whitespace-nowrap">
                        <span class="px-1.5 py-0.2 rounded text-[9px] font-bold ${item.ignition ? 'text-emerald-400' : 'text-rose-400'}">
                          ${item.ignition ? 'LIG' : 'OFF'}
                        </span>
                      </td>
                      <td class="py-1.5 px-2 text-slate-300 whitespace-nowrap">${item.power}V</td>
                      <td class="py-1.5 px-1 text-center whitespace-nowrap">
                        <button onclick="openPayloadInspector('${item.id}')" title="Inspecionar Payload da Request" class="p-1 rounded bg-slate-900 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 border border-slate-800 transition-colors">
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    } else {
      // Histórico já renderizado: atualiza somente se houver novos registros
      if (container.dataset.logsCount !== String(vehicleLogs.length)) {
        container.dataset.logsCount = String(vehicleLogs.length);
        const subCount = document.getElementById('modal-history-subcount');
        if (subCount) subCount.textContent = `Últimos ${vehicleLogs.length} disparos:`;
        const tbody = document.getElementById('modal-history-tbody');
        if (tbody) {
          tbody.innerHTML = vehicleLogs.map(item => `
            <tr class="hover:bg-slate-900/50 transition-colors">
              <td class="py-1.5 px-2 text-slate-400 whitespace-nowrap">${item.time}</td>
              <td class="py-1.5 px-2 whitespace-nowrap">
                <span class="px-1.5 py-0.2 rounded text-[9px] font-bold ${item.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
                  ${item.success ? `HTTP ${item.status}` : 'FALHA'}
                </span>
              </td>
              <td class="py-1.5 px-2 text-slate-200 whitespace-nowrap">${item.speedKmh} km/h</td>
              <td class="py-1.5 px-2 whitespace-nowrap">
                <span class="px-1.5 py-0.2 rounded text-[9px] font-bold ${item.ignition ? 'text-emerald-400' : 'text-rose-400'}">
                  ${item.ignition ? 'LIG' : 'OFF'}
                </span>
              </td>
              <td class="py-1.5 px-2 text-slate-300 whitespace-nowrap">${item.power}V</td>
              <td class="py-1.5 px-1 text-center whitespace-nowrap">
                <button onclick="openPayloadInspector('${item.id}')" title="Inspecionar Payload da Request" class="p-1 rounded bg-slate-900 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 border border-slate-800 transition-colors">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
                </button>
              </td>
            </tr>
          `).join('');
        }
      }
    }
    return;
  }

  // CASO C: COCKPIT (COMPACT OU EXPANDED)
  const cockpitViewKey = `${v.uniqueId}-${vehicleModalMode}-cockpit`;
  const actuatorsKey = `${v.manualIgnition}-${v.externalPowerCut}-${v.engineBlocked}-${v.towingSim}-${v.shadowZone}-${v.offlineBufferCount || 0}`;

  if (container.dataset.viewKey !== cockpitViewKey || forceRerender) {
    container.dataset.viewKey = cockpitViewKey;
    container.dataset.actuatorsKey = actuatorsKey;

    if (vehicleModalMode === 'expanded') {
      container.innerHTML = `
        <!-- Barra Horizontal Compacta de Telemetria -->
        <div class="bg-slate-950/90 border border-slate-800/90 rounded-2xl p-2.5 flex items-center justify-around gap-2 text-xs font-mono shadow-inner">
          <div class="text-center px-2">
            <div class="text-[10px] text-slate-400 font-sans">Velocidade</div>
            <div class="font-bold text-sky-400 text-sm mt-0.5"><span class="cockpit-speed">${speedFormatted}</span> <span class="text-[10px] text-slate-500 font-normal">km/h</span></div>
            <div class="text-[9px] text-slate-500"><span class="cockpit-bearing">${bearingFormatted}</span>° azimute</div>
          </div>
          <div class="h-8 w-px bg-slate-800"></div>
          <div class="text-center px-2">
            <div class="text-[10px] text-slate-400 font-sans">Ignição</div>
            <div class="cockpit-ignition-status font-bold ${v.ignition ? 'text-emerald-400' : 'text-rose-400'} text-sm mt-0.5 flex items-center justify-center gap-1">
              <span class="cockpit-ignition-dot w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
              <span class="cockpit-ignition-label">${v.ignition ? 'LIGADA' : 'DESLIGADA'}</span>
            </div>
            <div class="text-[9px] text-slate-500"><span class="cockpit-rpm">${v.rpm || 0}</span> RPM</div>
          </div>
          <div class="h-8 w-px bg-slate-800"></div>
          <div class="text-center px-2">
            <div class="text-[10px] text-slate-400 font-sans">Alimentação VCC</div>
            <div class="cockpit-power-status font-bold ${v.externalPowerCut ? 'text-amber-400' : 'text-slate-100'} text-sm mt-0.5"><span class="cockpit-power">${powerValue}</span>V</div>
            <div class="text-[9px] text-slate-500">Tracker <span class="cockpit-tracker-battery">${v.batteryTracker || 98}</span>%</div>
          </div>
          <div class="h-8 w-px bg-slate-800"></div>
          <div class="text-center px-2">
            <div class="text-[10px] text-slate-400 font-sans">Odômetro</div>
            <div class="cockpit-odo-wrap font-bold text-slate-200 text-sm mt-0.5 truncate" title="${formattedOdo} km"><span class="cockpit-odo">${formattedOdo}</span> km</div>
            <div class="text-[9px] text-slate-500">acumulado</div>
          </div>
          <div class="h-8 w-px bg-slate-800"></div>
          <div class="text-center px-2">
            <div class="text-[10px] text-slate-400 font-sans">Motor & Tanque</div>
            <div class="font-bold text-emerald-400 text-sm mt-0.5"><span class="cockpit-fuel">${fuelFormatted}</span>%</div>
            <div class="text-[9px] text-slate-500"><span class="cockpit-temp">${v.engineTemp || 85}</span>°C</div>
          </div>
        </div>

        <!-- Controles de Hardware Expandidos -->
        <div id="cockpit-hardware-container" class="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-4 space-y-3.5">
          ${renderExpandedHardwareControls(v)}
        </div>

        <!-- 3. Roteiros Físicos Rápidos Expandidos -->
        <div class="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-4 space-y-3">
          <h4 class="text-xs font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
            <span>⚡</span> Roteiros Físicos & Cenários de Teste Dinâmico
          </h4>
          <div class="grid grid-cols-4 gap-2.5">
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'accel_0_100')" class="bg-slate-900 hover:bg-emerald-950/40 border border-slate-800 hover:border-emerald-500/40 rounded-xl p-3 text-center transition-all group">
              <div class="text-lg group-hover:scale-110 transition-transform">🚀</div>
              <div class="text-xs font-bold text-slate-200 mt-1">Arrancada</div>
              <div class="text-[10px] text-slate-400">0 a 100 km/h súbito</div>
            </button>
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'brake_100_0')" class="bg-slate-900 hover:bg-amber-950/40 border border-slate-800 hover:border-amber-500/40 rounded-xl p-3 text-center transition-all group">
              <div class="text-lg group-hover:scale-110 transition-transform">🛑</div>
              <div class="text-xs font-bold text-slate-200 mt-1">Frenagem</div>
              <div class="text-[10px] text-slate-400">100 a 0 km/h imediato</div>
            </button>
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'crash')" class="bg-slate-900 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-500/40 rounded-xl p-3 text-center transition-all group">
              <div class="text-lg group-hover:scale-110 transition-transform">💥</div>
              <div class="text-xs font-bold text-slate-200 mt-1">Colisão</div>
              <div class="text-[10px] text-slate-400">Impacto + Alarme Shock</div>
            </button>
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'warp')" class="bg-slate-900 hover:bg-indigo-950/40 border border-slate-800 hover:border-indigo-500/40 rounded-xl p-3 text-center transition-all group">
              <div class="text-lg group-hover:scale-110 transition-transform">🌌</div>
              <div class="text-xs font-bold text-slate-200 mt-1">Salto GPS</div>
              <div class="text-[10px] text-slate-400">Teletransporte (Warp)</div>
            </button>
          </div>
        </div>

        <!-- 4. Disparo Forçado de Alarmes Expandido -->
        <div class="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-4 space-y-3">
          <h4 class="text-xs font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
            <span>🚨</span> Injeção Forçada de Eventos & Alarmes (Traccar)
          </h4>
          <div class="grid grid-cols-5 gap-2">
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'sos')" class="bg-slate-900 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-500/40 rounded-xl p-2.5 text-center transition-all">
              <div class="text-base">🆘</div>
              <div class="text-xs font-bold text-slate-200 mt-0.5">SOS / Pânico</div>
              <div class="text-[9px] text-slate-500">alarm: sos</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'powerCut')" class="bg-slate-900 hover:bg-amber-950/40 border border-slate-800 hover:border-amber-500/40 rounded-xl p-2.5 text-center transition-all">
              <div class="text-base">🔌</div>
              <div class="text-xs font-bold text-slate-200 mt-0.5">Corte VCC</div>
              <div class="text-[9px] text-slate-500">alarm: powerCut</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'lowBattery')" class="bg-slate-900 hover:bg-yellow-950/40 border border-slate-800 hover:border-yellow-500/40 rounded-xl p-2.5 text-center transition-all">
              <div class="text-base">🔋</div>
              <div class="text-xs font-bold text-slate-200 mt-0.5">Bateria Fraca</div>
              <div class="text-[9px] text-slate-500">alarm: lowBattery</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'tow')" class="bg-slate-900 hover:bg-orange-950/40 border border-slate-800 hover:border-orange-500/40 rounded-xl p-2.5 text-center transition-all">
              <div class="text-base">🚜</div>
              <div class="text-xs font-bold text-slate-200 mt-0.5">Reboque</div>
              <div class="text-[9px] text-slate-500">alarm: tow</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'shock')" class="bg-slate-900 hover:bg-purple-950/40 border border-slate-800 hover:border-purple-500/40 rounded-xl p-2.5 text-center transition-all">
              <div class="text-base">💥</div>
              <div class="text-xs font-bold text-slate-200 mt-0.5">Impacto</div>
              <div class="text-[9px] text-slate-500">alarm: shock</div>
            </button>
          </div>
        </div>
      `;
    } else {
      // Modo Compacto
      container.innerHTML = `
        <!-- Resumo de Telemetria do Veículo no Modal Compacto -->
        <div class="bg-slate-950 border border-slate-800/90 rounded-2xl p-2.5 space-y-2">
          <div class="grid grid-cols-2 gap-1.5 text-xs font-mono">
            <div class="bg-slate-900 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
              <div class="text-[9px] text-slate-400 font-sans">Velocidade</div>
              <div class="font-bold text-sky-400 text-xs flex items-baseline justify-between mt-0.5">
                <span><span class="cockpit-speed">${speedFormatted}</span> <span class="text-[9px] text-slate-500 font-normal">km/h</span></span>
                <span class="text-[9px] text-slate-500 font-normal font-sans"><span class="cockpit-bearing">${bearingFormatted}</span>°</span>
              </div>
            </div>
            <div class="bg-slate-900 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
              <div class="text-[9px] text-slate-400 font-sans">Ignição</div>
              <div class="cockpit-ignition-status font-bold ${v.ignition ? 'text-emerald-400' : 'text-rose-400'} text-xs flex items-baseline justify-between mt-0.5">
                <span class="flex items-center gap-1">
                  <span class="cockpit-ignition-dot w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400' : 'bg-rose-400'}"></span>
                  <span class="cockpit-ignition-label">${v.ignition ? 'LIG' : 'OFF'}</span>
                </span>
                <span class="text-[9px] text-slate-500 font-normal font-sans"><span class="cockpit-rpm">${v.rpm || 0}</span> RPM</span>
              </div>
            </div>
            <div class="bg-slate-900 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
              <div class="text-[9px] text-slate-400 font-sans">Bateria</div>
              <div class="cockpit-power-status font-bold ${v.externalPowerCut ? 'text-amber-400' : 'text-slate-200'} text-xs flex items-baseline justify-between mt-0.5">
                <span><span class="cockpit-power">${powerValue}</span>V</span>
                <span class="text-[9px] text-slate-500 font-normal font-sans"><span class="cockpit-tracker-battery">${v.batteryTracker || 98}</span>%</span>
              </div>
            </div>
            <div class="bg-slate-900 border border-slate-800/80 rounded-xl px-2.5 py-1.5">
              <div class="text-[9px] text-slate-400 font-sans">Tanque</div>
              <div class="font-bold text-emerald-400 text-xs flex items-baseline justify-between mt-0.5">
                <span><span class="cockpit-fuel">${fuelFormatted}</span>%</span>
                <span class="text-[9px] text-slate-500 font-normal font-sans"><span class="cockpit-temp">${v.engineTemp || 85}</span>°C</span>
              </div>
            </div>
          </div>
          <div class="pt-1.5 border-t border-slate-800/60 flex items-center justify-between text-[10px] text-slate-400 font-mono">
            <span>Odômetro: <b class="cockpit-odo text-slate-200">${formattedOdo} km</b></span>
            <span class="text-[9px] text-slate-500 font-sans">Azimute: <span class="cockpit-bearing">${bearingFormatted}</span>°</span>
          </div>
        </div>

        <!-- Controles de Hardware Compactos -->
        <div id="cockpit-hardware-container" class="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-2.5 space-y-2">
          ${renderCompactHardwareControls(v)}
        </div>

        <!-- 3. Roteiros Físicos Compactos -->
        <div class="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-2.5 space-y-2">
          <div class="text-[11px] font-bold text-sky-400 uppercase tracking-wider">Roteiros Físicos</div>
          <div class="grid grid-cols-4 gap-1.5 text-center">
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'accel_0_100')" class="bg-slate-900 hover:bg-emerald-950/40 border border-slate-800 hover:border-emerald-500/40 rounded-xl p-1.5 transition-all">
              <div class="text-sm">🚀</div>
              <div class="text-[10px] font-bold text-slate-200 mt-0.5">0-100</div>
            </button>
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'brake_100_0')" class="bg-slate-900 hover:bg-amber-950/40 border border-slate-800 hover:border-amber-500/40 rounded-xl p-1.5 transition-all">
              <div class="text-sm">🛑</div>
              <div class="text-[10px] font-bold text-slate-200 mt-0.5">100-0</div>
            </button>
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'crash')" class="bg-slate-900 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-500/40 rounded-xl p-1.5 transition-all">
              <div class="text-sm">💥</div>
              <div class="text-[10px] font-bold text-slate-200 mt-0.5">Colisão</div>
            </button>
            <button onclick="triggerVehicleScenario('${v.uniqueId}', 'warp')" class="bg-slate-900 hover:bg-indigo-950/40 border border-slate-800 hover:border-indigo-500/40 rounded-xl p-1.5 transition-all">
              <div class="text-sm">🌌</div>
              <div class="text-[10px] font-bold text-slate-200 mt-0.5">Warp</div>
            </button>
          </div>
        </div>

        <!-- 4. Disparo de Alarmes Compacto -->
        <div class="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-2.5 space-y-2">
          <div class="text-[11px] font-bold text-sky-400 uppercase tracking-wider">Disparo de Alarmes</div>
          <div class="grid grid-cols-5 gap-1 text-center">
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'sos')" class="bg-slate-900 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-500/40 rounded-xl p-1 transition-all" title="SOS / Pânico">
              <div class="text-xs">🆘</div>
              <div class="text-[9px] font-bold text-slate-200">SOS</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'powerCut')" class="bg-slate-900 hover:bg-amber-950/40 border border-slate-800 hover:border-amber-500/40 rounded-xl p-1 transition-all" title="Corte Energia">
              <div class="text-xs">🔌</div>
              <div class="text-[9px] font-bold text-slate-200">VCC</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'lowBattery')" class="bg-slate-900 hover:bg-yellow-950/40 border border-slate-800 hover:border-yellow-500/40 rounded-xl p-1 transition-all" title="Bateria Fraca">
              <div class="text-xs">🔋</div>
              <div class="text-[9px] font-bold text-slate-200">Bat.</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'tow')" class="bg-slate-900 hover:bg-orange-950/40 border border-slate-800 hover:border-orange-500/40 rounded-xl p-1 transition-all" title="Reboque / Guincho">
              <div class="text-xs">🚜</div>
              <div class="text-[9px] font-bold text-slate-200">Guincho</div>
            </button>
            <button onclick="triggerVehicleAlarm('${v.uniqueId}', 'shock')" class="bg-slate-900 hover:bg-purple-950/40 border border-slate-800 hover:border-purple-500/40 rounded-xl p-1 transition-all" title="Impacto / Shock">
              <div class="text-xs">💥</div>
              <div class="text-[9px] font-bold text-slate-200">Shock</div>
            </button>
          </div>
        </div>
      `;
    }
  } else {
    // Cockpit já existe no DOM!
    // 1. Atualiza métricas de telemetria sem recriar nenhum nó
    container.querySelectorAll('.cockpit-speed').forEach(el => {
      if (el.textContent !== String(speedFormatted)) el.textContent = speedFormatted;
    });
    container.querySelectorAll('.cockpit-bearing').forEach(el => {
      if (el.textContent !== String(bearingFormatted)) el.textContent = bearingFormatted;
    });
    container.querySelectorAll('.cockpit-rpm').forEach(el => {
      if (el.textContent !== String(v.rpm || 0)) el.textContent = v.rpm || 0;
    });
    container.querySelectorAll('.cockpit-power').forEach(el => {
      if (el.textContent !== powerValue) el.textContent = powerValue;
    });
    container.querySelectorAll('.cockpit-tracker-battery').forEach(el => {
      if (el.textContent !== String(v.batteryTracker || 98)) el.textContent = v.batteryTracker || 98;
    });
    container.querySelectorAll('.cockpit-fuel').forEach(el => {
      if (el.textContent !== String(fuelFormatted)) el.textContent = fuelFormatted;
    });
    container.querySelectorAll('.cockpit-temp').forEach(el => {
      if (el.textContent !== String(v.engineTemp || 85)) el.textContent = v.engineTemp || 85;
    });
    container.querySelectorAll('.cockpit-odo').forEach(el => {
      if (vehicleModalMode === 'compact') {
        if (el.textContent !== `${formattedOdo} km`) el.textContent = `${formattedOdo} km`;
      } else {
        if (el.textContent !== formattedOdo) el.textContent = formattedOdo;
      }
    });

    const ignLabel = vehicleModalMode === 'compact' ? (v.ignition ? 'LIG' : 'OFF') : (v.ignition ? 'LIGADA' : 'DESLIGADA');
    container.querySelectorAll('.cockpit-ignition-label').forEach(el => {
      if (el.textContent !== ignLabel) el.textContent = ignLabel;
    });
    container.querySelectorAll('.cockpit-ignition-dot').forEach(el => {
      el.className = `cockpit-ignition-dot w-1.5 h-1.5 rounded-full ${v.ignition ? 'bg-emerald-400' : 'bg-rose-400'}`;
    });
    container.querySelectorAll('.cockpit-ignition-status').forEach(el => {
      el.className = `cockpit-ignition-status font-bold ${v.ignition ? 'text-emerald-400' : 'text-rose-400'} ${vehicleModalMode === 'compact' ? 'text-xs flex items-baseline justify-between mt-0.5' : 'text-sm mt-0.5 flex items-center justify-center gap-1'}`;
    });

    container.querySelectorAll('.cockpit-power-status').forEach(el => {
      el.className = `cockpit-power-status font-bold ${v.externalPowerCut ? 'text-amber-400' : (vehicleModalMode === 'compact' ? 'text-slate-200' : 'text-slate-100')} ${vehicleModalMode === 'compact' ? 'text-xs flex items-baseline justify-between mt-0.5' : 'text-sm mt-0.5'}`;
    });

    // 2. Se os atuadores de hardware mudaram, atualiza apenas o container de hardware
    if (container.dataset.actuatorsKey !== actuatorsKey) {
      container.dataset.actuatorsKey = actuatorsKey;
      const hwContainer = document.getElementById('cockpit-hardware-container');
      if (hwContainer) {
        hwContainer.innerHTML = vehicleModalMode === 'expanded' ? renderExpandedHardwareControls(v) : renderCompactHardwareControls(v);
      }
    }
  }
}

window.switchMapCity = function(coordsStr) {
  if (!coordsStr) return;
  const parts = coordsStr.split(',');
  if (parts.length !== 2) return;
  const lat = parseFloat(parts[0]);
  const lon = parseFloat(parts[1]);
  if (isNaN(lat) || isNaN(lon)) return;

  // Atualiza centro do mapa com animação suave
  if (mapManager && mapManager.map) {
    const radius = Number(document.getElementById('inputRadius')?.value) || 8;
    mapManager.setCenterPoint(lat, lon, radius);
    mapManager.map.flyTo([lat, lon], 13, { duration: 1.5 });
  }

  // Sincroniza inputs de coordenadas
  const inputLat = document.getElementById('inputLat');
  if (inputLat) inputLat.value = lat;
  const inputLon = document.getElementById('inputLon');
  if (inputLon) inputLon.value = lon;

  // Sincroniza os selects de cidade
  const presetSelect = document.getElementById('presetCitySelect');
  if (presetSelect && presetSelect.value !== coordsStr) presetSelect.value = coordsStr;

  const quickSelect = document.getElementById('homeQuickCitySelect');
  if (quickSelect && quickSelect.value !== coordsStr) quickSelect.value = coordsStr;

  // Persiste a preferência no localStorage
  localStorage.setItem('traccar_sim_selected_city', coordsStr);
};

window.locateVehicleOnMap = function(uniqueId) {
  const v = activeVehiclesMap.get(uniqueId);
  closeVehicleDetailModal();
  switchTab('home');

  followVehicleId = uniqueId;
  const followSelect = document.getElementById('selectFollowVehicle');
  if (followSelect) followSelect.value = uniqueId;

  const vLat = v?.lat ?? v?.currentLat;
  const vLon = v?.lon ?? v?.currentLon;

  if (vLat && vLon && mapManager && mapManager.map) {
    setTimeout(() => {
      mapManager.panTo(vLat, vLon, 16);
      const markerData = mapManager.vehicleMarkers.get(uniqueId);
      if (markerData && markerData.marker) {
        markerData.marker.openPopup();
      }
    }, 200);
  }
};

function updateFollowVehicleSelect() {
  const select = document.getElementById('selectFollowVehicle');
  if (!select) return;

  const previousVal = followVehicleId || select.value;
  const vehicles = Array.from(activeVehiclesMap.values());

  const currentOptionsCount = select.options.length - 1;
  if (currentOptionsCount === vehicles.length && previousVal === select.value) {
    return; // Já sincronizado
  }

  select.innerHTML = '<option value="">👁️ Visão Geral (Todos)</option>';
  vehicles.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.uniqueId;
    opt.innerText = `${v.isImported ? '📥' : '⚡'} ${v.name}`;
    select.appendChild(opt);
  });

  if (previousVal && activeVehiclesMap.has(previousVal)) {
    select.value = previousVal;
    followVehicleId = previousVal;
  } else if (!previousVal) {
    select.value = '';
    followVehicleId = '';
  }
}

// -------------------------------------------------------------
// Configuração dos Event Listeners
// -------------------------------------------------------------
function setupEventListeners() {
  document.getElementById('filterVehicleSearch')?.addEventListener('input', renderFleetTab);

  // Seletor de Seguir Veículo
  document.getElementById('selectFollowVehicle')?.addEventListener('change', (e) => {
    followVehicleId = e.target.value;
    if (!followVehicleId) {
      mapManager.fitBoundsAll();
    } else {
      const v = activeVehiclesMap.get(followVehicleId);
      const vLat = v?.lat ?? v?.currentLat;
      const vLon = v?.lon ?? v?.currentLon;
      if (vLat && vLon && mapManager && mapManager.map) {
        mapManager.panTo(vLat, vLon, 16);
        const markerData = mapManager.vehicleMarkers.get(followVehicleId);
        if (markerData && markerData.marker) {
          markerData.marker.openPopup();
        }
      }
    }
  });

  document.getElementById('btnSaveConfig')?.addEventListener('click', saveTraccarConfig);
  document.getElementById('btnTestConnection')?.addEventListener('click', testTraccarConnection);
  document.getElementById('btnTestOsmandPort')?.addEventListener('click', testOsmAndPort);
  document.getElementById('btnTestCreateDevice')?.addEventListener('click', testCreateDeviceOnTraccar);
  document.getElementById('btnAnalyze')?.addEventListener('click', analyzeTraccar);

  // Atualização dinâmica do label do botão de teste de porta
  const osmandPortInput = document.getElementById('traccarOsmandPort');
  if (osmandPortInput) {
    const updatePortLabel = () => {
      const p = osmandPortInput.value.trim() || '5055';
      const label = document.getElementById('labelTestPort');
      if (label) label.innerText = `2. Testar Porta :${p}`;
    };
    osmandPortInput.addEventListener('input', updatePortLabel);
    updatePortLabel();
  }

  // Sub-aba 2: Importar Dispositivos Remotos
  document.getElementById('btnRefreshRemoteDevices')?.addEventListener('click', () => fetchRemoteDevices(true));
  document.getElementById('searchRemoteDevicesInput')?.addEventListener('input', filterRemoteDevices);
  document.getElementById('filterRemoteStatus')?.addEventListener('change', filterRemoteDevices);
  document.getElementById('checkConfirmSecurityRisk')?.addEventListener('change', (e) => {
    const btn = document.getElementById('btnConfirmImportDevice');
    if (btn) btn.disabled = !e.target.checked;
  });
  document.getElementById('btnConfirmImportDevice')?.addEventListener('click', confirmImportDevice);

  // Sub-aba 4: Atributos Calculados
  document.getElementById('btnRefreshComputedAttributes')?.addEventListener('click', () => fetchComputedAttributesList(true));

  document.getElementById('btnTogglePassVisibility')?.addEventListener('click', () => {
    const input = document.getElementById('traccarPass');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  // Auto-sugere host OsmAnd ao digitar URL do Traccar
  document.getElementById('traccarUrl')?.addEventListener('blur', (e) => {
    try {
      const urlStr = e.target.value.trim();
      if (!urlStr) return;
      const urlObj = new URL(urlStr.startsWith('http') ? urlStr : `http://${urlStr}`);
      const osmandInput = document.getElementById('traccarOsmandHost');
      if (osmandInput && (!osmandInput.value || osmandInput.value === 'localhost')) {
        osmandInput.value = urlObj.hostname;
      }
    } catch (_) {}
  });

  document.getElementById('inputRadius')?.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    document.getElementById('radiusDisplay').innerText = `${val} km`;
    mapManager.updateRadius(val);
  });

  document.getElementById('presetCitySelect')?.addEventListener('change', (e) => {
    window.switchMapCity(e.target.value);
  });

  document.getElementById('btnAddCustomAttr')?.addEventListener('click', addManualAttribute);
  document.getElementById('btnStartBatchSimulation')?.addEventListener('click', startBatchSimulation);

  document.getElementById('btnPauseSim')?.addEventListener('click', async () => {
    await fetch('/api/simulation/pause', { method: 'POST' });
  });

  document.getElementById('btnResumeSim')?.addEventListener('click', async () => {
    await fetch('/api/simulation/resume', { method: 'POST' });
  });

  document.getElementById('btnStopSim')?.addEventListener('click', async () => {
    await fetch('/api/simulation/stop', { method: 'POST' });
    followVehicleId = '';
    mapManager.clearVehicles();
    activeVehiclesMap.clear();
    updateSystemKPIs();
    updateFleetBadge();
    updateFollowVehicleSelect();
    renderFleetTab();
  });

  document.getElementById('simSpeedSelect')?.addEventListener('change', async (e) => {
    await fetch('/api/simulation/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ multiplier: Number(e.target.value) })
    });
  });

  document.getElementById('btnClearLogs')?.addEventListener('click', () => {
    clearAllLogs();
  });

  document.getElementById('modalLogsFilterVehicle')?.addEventListener('change', (e) => {
    selectedLogFilterVehicle = e.target.value;
    renderModalLogsTable();
  });

  document.getElementById('homeFilterVehicleSearch')?.addEventListener('input', () => {
    renderHomeSidebarList();
  });

  document.getElementById('selectFollowVehicle')?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val) {
      focusVehicle(val);
    } else {
      unfocusVehicle();
    }
  });
}

function getTraccarCredentials() {
  return {
    url: document.getElementById('traccarUrl')?.value.trim() || 'http://localhost:8082',
    username: document.getElementById('traccarUser')?.value.trim() || 'admin',
    password: document.getElementById('traccarPass')?.value.trim() || 'admin',
    osmandHost: document.getElementById('traccarOsmandHost')?.value.trim() || undefined,
    osmandPort: document.getElementById('traccarOsmandPort')?.value.trim() || 5055,
    sendIntervalSeconds: document.getElementById('simSendInterval')?.value ? parseInt(document.getElementById('simSendInterval').value, 10) : 30,
    headingThresholdDegrees: document.getElementById('simHeadingThreshold')?.value ? parseFloat(document.getElementById('simHeadingThreshold').value) : 15.0,
  };
}

// -------------------------------------------------------------
// Carregamento & Salvamento de Configuração Traccar
// -------------------------------------------------------------
async function loadSavedTraccarConfig() {
  try {
    let cfg = null;
    const res = await fetch('/api/traccar/config');
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.config) {
        cfg = data.config;
      }
    }

    if (!cfg || cfg.restUrl === 'http://localhost:8082') {
      const local = localStorage.getItem('traccar_sim_config');
      if (local) {
        try {
          const parsed = JSON.parse(local);
          if (parsed && parsed.url) {
            cfg = {
              restUrl: parsed.url,
              username: parsed.username || 'admin',
              password: parsed.password || 'admin',
              osmandHost: parsed.osmandHost || 'localhost',
              osmandPort: parsed.osmandPort || 5055,
            };
          }
        } catch (_) {}
      }
    }

    if (cfg) {
      if (cfg.restUrl && document.getElementById('traccarUrl')) {
        document.getElementById('traccarUrl').value = cfg.restUrl;
      }
      if (cfg.username && document.getElementById('traccarUser')) {
        document.getElementById('traccarUser').value = cfg.username;
      }
      if (cfg.password && document.getElementById('traccarPass')) {
        document.getElementById('traccarPass').value = cfg.password;
      }
      if (cfg.osmandHost && document.getElementById('traccarOsmandHost')) {
        document.getElementById('traccarOsmandHost').value = cfg.osmandHost;
      }
      if (cfg.osmandPort && document.getElementById('traccarOsmandPort')) {
        document.getElementById('traccarOsmandPort').value = cfg.osmandPort;
        const label = document.getElementById('labelTestPort');
        if (label) label.innerText = `2. Testar Porta :${cfg.osmandPort}`;
      }
      if (document.getElementById('simSendInterval')) {
        document.getElementById('simSendInterval').value = cfg.sendIntervalSeconds ?? 30;
      }
      if (document.getElementById('simHeadingThreshold')) {
        document.getElementById('simHeadingThreshold').value = cfg.headingThresholdDegrees ?? 15.0;
      }
    }
  } catch (err) {
    console.warn('Erro ao carregar configurações salvas:', err);
  }
}

async function saveTraccarConfig() {
  const creds = getTraccarCredentials();
  const btn = document.getElementById('btnSaveConfig');
  const btnText = document.getElementById('btnSaveConfigText');
  const originalText = btnText ? btnText.innerText : 'Salvar Configurações';

  if (btnText) btnText.innerText = 'Salvando...';
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/traccar/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();

    if (data.success) {
      localStorage.setItem('traccar_sim_config', JSON.stringify(creds));
      if (btnText) btnText.innerText = '✓ Salvo!';
      const statusEl = document.getElementById('connectionStatusText');
      if (statusEl) {
        statusEl.className = 'text-xs text-emerald-400 p-3 bg-emerald-950/20 rounded-xl border border-emerald-500/30';
        statusEl.innerText = '✓ Configurações salvas e ativas no backend e no navegador!';
      }
    } else {
      alert(`Falha ao salvar configurações: ${data.message}`);
    }
  } catch (err) {
    alert(`Erro ao salvar: ${err.message}`);
  } finally {
    setTimeout(() => {
      if (btnText) btnText.innerText = originalText;
      if (btn) btn.disabled = false;
    }, 2000);
  }
}

// -------------------------------------------------------------
// Teste e Diagnóstico Profundo do Traccar
// -------------------------------------------------------------
async function testTraccarConnection() {
  const creds = getTraccarCredentials();
  const statusEl = document.getElementById('connectionStatusText');
  const badgeEl = document.getElementById('configBadgeStatus');

  statusEl.className = 'text-xs text-sky-400 p-3.5 bg-slate-950 rounded-xl border border-slate-800/80';
  statusEl.innerHTML = '<span class="inline-block animate-spin mr-1.5">⟳</span> Conectando e autenticando no Traccar remoto...';

  try {
    const res = await fetch('/api/traccar/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();

    if (data.success) {
      const u = data.user || {};
      const isAdmin = u.administrator === true;
      const canCreate = data.canCreateDevices !== false;

      if (badgeEl) {
        badgeEl.className = canCreate
          ? 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
          : 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30';
        badgeEl.innerText = canCreate ? (isAdmin ? 'Admin (Liberado)' : 'Conectado (Liberado)') : 'Acesso Limitado';
      }

      let permBadge = canCreate
        ? '<span class="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-semibold">✓ Permitido Cadastrar Veículos</span>'
        : `<span class="px-2 py-0.5 rounded-md bg-rose-500/20 text-rose-300 font-semibold">❌ Cadastro Bloqueado: ${data.restriction || 'Sem permissão'}</span>`;

      let roleBadge = isAdmin
        ? '<span class="px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 font-semibold">Administrador</span>'
        : '<span class="px-2 py-0.5 rounded-md bg-sky-500/20 text-sky-300 font-semibold">Usuário Comum</span>';

      statusEl.className = 'text-xs text-slate-200 p-4 bg-slate-950 rounded-xl border border-emerald-500/30 space-y-2';
      statusEl.innerHTML = `
        <div class="flex items-center justify-between border-b border-slate-800 pb-2">
          <div class="font-bold text-emerald-400 flex items-center gap-1.5">
            <span>✓</span> Conexão e Autenticação Bem-Sucedidas!
          </div>
          <div class="flex gap-1.5 text-[10px]">
            ${roleBadge}
            ${permBadge}
          </div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px] text-slate-300 font-mono">
          <div><span class="text-slate-500">Usuário:</span> ${u.name || creds.username}</div>
          <div><span class="text-slate-500">Email:</span> ${u.email || '-'}</div>
          <div><span class="text-slate-500">Dispositivos no Traccar:</span> ${data.devicesCount ?? 0}</div>
          <div><span class="text-slate-500">Limite de Veículos:</span> ${u.deviceLimit === -1 ? 'Ilimitado' : (u.deviceLimit ?? 'Ilimitado')}</div>
        </div>
        ${!canCreate ? `
          <div class="p-2.5 bg-rose-950/40 border border-rose-500/30 rounded-xl text-rose-300 text-[11px] mt-2">
            ⚠️ <strong>Atenção:</strong> Os veículos simulados NÃO poderão ser cadastrados no Traccar porque esta conta não tem permissão de escrita de dispositivos. Se você iniciar a simulação, marque ou desmarque a opção "Registrar no Traccar" conforme sua necessidade.
          </div>
        ` : ''}
      `;
    } else {
      if (badgeEl) {
        badgeEl.className = 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/30';
        badgeEl.innerText = 'Erro de Conexão';
      }
      statusEl.className = 'text-xs text-rose-300 p-4 bg-rose-950/20 rounded-xl border border-rose-500/30 space-y-1.5';
      statusEl.innerHTML = `
        <div class="font-bold text-rose-400 flex items-center gap-1.5">
          <span>✗</span> Falha ao Conectar com o Traccar
        </div>
        <div class="text-[11px] text-slate-300">${data.message}</div>
        <div class="text-[10px] text-slate-400 pt-1">
          💡 Verifique se a URL inclui a porta correta (ex: :8082), se o protocolo (http ou https) está correto e se o usuário e senha são válidos.
        </div>
      `;
    }
  } catch (err) {
    if (badgeEl) {
      badgeEl.className = 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/30';
      badgeEl.innerText = 'Erro de Rede';
    }
    statusEl.className = 'text-xs text-rose-400 font-medium p-3.5 bg-rose-950/20 rounded-xl border border-rose-500/30';
    statusEl.innerText = `✗ Erro de rede ou servidor inacessível: ${err.message}`;
  }
}

async function testOsmAndPort() {
  const creds = getTraccarCredentials();
  const statusEl = document.getElementById('connectionStatusText');
  const targetPort = creds.osmandPort || 5055;
  const targetHost = creds.osmandHost || 'localhost';

  statusEl.className = 'text-xs text-sky-400 p-3.5 bg-slate-950 rounded-xl border border-slate-800/80';
  statusEl.innerHTML = `<span class="inline-block animate-spin mr-1.5">⟳</span> Enviando ping para porta TCP/HTTP :${targetPort} em ${targetHost}...`;

  try {
    const res = await fetch('/api/traccar/test-port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: targetHost, port: targetPort })
    });
    const data = await res.json();

    if (data.success) {
      statusEl.className = 'text-xs text-emerald-300 p-3.5 bg-emerald-950/20 rounded-xl border border-emerald-500/30 space-y-1';
      statusEl.innerHTML = `
        <div class="font-bold text-emerald-400 flex items-center gap-1.5">
          <span>✓</span> Porta :${targetPort} Acessível!
        </div>
        <div class="text-[11px] text-slate-200">${data.message}</div>
        <div class="text-[10px] text-slate-400 font-mono">Latência: ${data.latencyMs}ms | Host Testado: ${data.targetHost || targetHost}:${data.targetPort || targetPort}</div>
      `;
    } else {
      statusEl.className = 'text-xs text-rose-300 p-3.5 bg-rose-950/20 rounded-xl border border-rose-500/30 space-y-1';
      statusEl.innerHTML = `
        <div class="font-bold text-rose-400 flex items-center gap-1.5">
          <span>✗</span> Porta :${targetPort} Inacessível
        </div>
        <div class="text-[11px] text-slate-200">${data.message}</div>
        <div class="text-[10px] text-amber-300/90 pt-1">
          💡 <strong>Como resolver:</strong> Acesse as regras de firewall do seu servidor e libere a porta <strong>${targetPort} TCP</strong> de entrada.
        </div>
      `;
    }
  } catch (err) {
    statusEl.className = 'text-xs text-rose-400 p-3.5 bg-rose-950/20 rounded-xl border border-rose-500/30';
    statusEl.innerText = `✗ Erro ao testar porta :${targetPort}: ${err.message}`;
  }
}


async function testCreateDeviceOnTraccar() {
  const creds = getTraccarCredentials();
  const box = document.getElementById('deviceCreationDiagnosticBox');
  const btn = document.getElementById('btnTestCreateDevice');

  box.classList.remove('hidden');
  box.className = 'text-xs p-3.5 rounded-2xl border bg-slate-950 border-slate-800 text-sky-400 flex items-center gap-2';
  box.innerHTML = '<span class="inline-block animate-spin mr-1">⟳</span> Enviando requisição POST /api/devices para o Traccar remoto...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/traccar/test-create-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();

    if (data.success && data.device) {
      const dev = data.device;
      box.className = 'text-xs p-3.5 rounded-2xl border bg-emerald-950/30 border-emerald-500/40 text-emerald-200 space-y-2';
      box.innerHTML = `
        <div class="flex items-center justify-between">
          <div class="font-bold text-emerald-400 flex items-center gap-1.5">
            <span>✓</span> Veículo Criado no Traccar Remoto com Sucesso!
          </div>
          <span class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">ID #${dev.id}</span>
        </div>
        <div class="text-[11px] text-slate-300 space-y-0.5 font-mono">
          <div><span class="text-slate-500">Nome:</span> ${dev.name}</div>
          <div><span class="text-slate-500">Identificador Único:</span> ${dev.uniqueId}</div>
          <div><span class="text-slate-500">Status:</span> Criado e pronto para receber telemetrias.</div>
        </div>
        <div class="pt-1 flex items-center justify-between">
          <span class="text-[10px] text-slate-400">Sua conta tem permissão total de criação.</span>
          <button onclick="deleteTraccarTestDevice(${dev.id})" type="button" class="text-[11px] font-semibold text-rose-400 hover:text-rose-300 hover:underline bg-rose-950/40 px-2.5 py-1 rounded-lg border border-rose-500/30 transition-colors">
            🗑️ Excluir Veículo de Teste
          </button>
        </div>
      `;
    } else {
      box.className = 'text-xs p-3.5 rounded-2xl border bg-rose-950/30 border-rose-500/40 text-rose-200 space-y-2';
      box.innerHTML = `
        <div class="font-bold text-rose-400 flex items-center gap-1.5">
          <span>❌</span> Falha ao Criar Veículo no Traccar Remoto
        </div>
        <div class="text-[11px] text-slate-200 leading-relaxed">${data.message}</div>
        ${data.error ? `<div class="p-2 bg-slate-950 rounded-lg text-[10px] font-mono text-rose-300 border border-slate-800 break-all">${data.error}</div>` : ''}
        <div class="text-[10px] text-slate-300 space-y-1 pt-1">
          <div><strong>Diagnóstico do Problema:</strong></div>
          <ul class="list-disc list-inside text-slate-400 space-y-0.5">
            <li>Verifique se o usuário possui papel de <strong>Administrador</strong> no Traccar.</li>
            <li>Se for usuário comum, acerte o campo <strong>Limite de Dispositivos (deviceLimit)</strong> ou associe o usuário a um grupo.</li>
            <li>Verifique se a opção <strong>Somente Leitura de Dispositivos (deviceReadonly)</strong> está desmarcada nas permissões do usuário no Traccar.</li>
          </ul>
        </div>
      `;
    }
  } catch (err) {
    box.className = 'text-xs p-3.5 rounded-2xl border bg-rose-950/30 border-rose-500/40 text-rose-300';
    box.innerText = `Erro de rede ao testar criação: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

window.deleteTraccarTestDevice = async function(deviceId) {
  const creds = getTraccarCredentials();
  const box = document.getElementById('deviceCreationDiagnosticBox');
  if (box) {
    box.innerHTML = '<span class="inline-block animate-spin mr-1">⟳</span> Excluindo dispositivo de teste...';
  }

  try {
    const res = await fetch(`/api/traccar/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();
    if (box) {
      box.className = 'text-xs p-3 rounded-xl border bg-slate-950 border-slate-800 text-slate-400';
      box.innerText = data.message || `Dispositivo de teste #${deviceId} excluído.`;
    }
  } catch (err) {
    alert(`Erro ao excluir: ${err.message}`);
  }
};

// -------------------------------------------------------------
// Sub-abas de Configuração & Importação Avançada
// -------------------------------------------------------------
let remoteDevicesList = [];
let selectedRemoteDeviceForImport = null;
let protocolsList = [];
let computedAttributesList = [];

window.switchConfigSubTab = function(subTabName) {
  const tabs = ['connection', 'import', 'protocols', 'attributes'];
  tabs.forEach(t => {
    const btn = document.getElementById(`btnConfigSubTab_${t}`);
    const pane = document.getElementById(`configSubPane_${t}`);
    if (btn && pane) {
      if (t === subTabName) {
        btn.className = 'config-subtab-btn px-4 py-2 rounded-xl text-xs font-semibold bg-sky-600/20 text-sky-400 border border-sky-500/30 transition-all flex items-center gap-2';
        pane.classList.remove('hidden');
      } else {
        btn.className = 'config-subtab-btn px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent transition-all flex items-center gap-2';
        pane.classList.add('hidden');
      }
    }
  });

  if (subTabName === 'import') {
    if (remoteDevicesList.length === 0) {
      fetchRemoteDevices();
    }
  } else if (subTabName === 'protocols') {
    if (protocolsList.length === 0) {
      fetchProtocolsList();
    }
  } else if (subTabName === 'attributes') {
    fetchSimulationAttributesConfig();
    if (computedAttributesList.length === 0) {
      fetchComputedAttributesList();
    }
  }
};

// -------------------------------------------------------------
// 2. Importação de Dispositivos Remotos do Traccar
// -------------------------------------------------------------
async function fetchRemoteDevices(force = false) {
  const tbody = document.getElementById('remoteDevicesTableBody');
  const btnRefresh = document.getElementById('btnRefreshRemoteDevices');
  const icon = document.getElementById('btnRefreshRemoteDevicesIcon');

  if (icon) icon.className = 'inline-block animate-spin';
  if (btnRefresh) btnRefresh.disabled = true;

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-12 text-center text-sky-400 font-sans text-xs">
          <span class="inline-block animate-spin mr-2">⟳</span> Consultando /api/devices no Traccar remoto...
        </td>
      </tr>
    `;
  }

  try {
    const creds = getTraccarCredentials();
    const res = await fetch('/api/traccar/remote-devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();

    if (data.success && Array.isArray(data.devices)) {
      remoteDevicesList = data.devices;
      const badge = document.getElementById('badgeRemoteDevicesCount');
      if (badge) badge.innerText = remoteDevicesList.length;
      renderRemoteDevicesTable(remoteDevicesList);
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" class="py-8 text-center text-rose-400 font-sans text-xs">
              Falha ao carregar dispositivos: ${data.message || 'Erro de autenticação'}
            </td>
          </tr>
        `;
      }
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-8 text-center text-rose-400 font-sans text-xs">
            Erro de conexão com o Traccar: ${err.message}
          </td>
        </tr>
      `;
    }
  } finally {
    if (icon) icon.className = '';
    if (btnRefresh) btnRefresh.disabled = false;
  }
}

function renderRemoteDevicesTable(devices) {
  const tbody = document.getElementById('remoteDevicesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  // Atualiza KPIs da tela de importação
  const total = remoteDevicesList.length;
  const online = remoteDevicesList.filter(d => d.status === 'online').length;
  const offline = remoteDevicesList.filter(d => d.status === 'offline').length;
  const protocols = new Set(remoteDevicesList.map(d => d.protocol || 'OsmAnd')).size;

  if (document.getElementById('kpiRemoteTotal')) document.getElementById('kpiRemoteTotal').innerText = total;
  if (document.getElementById('kpiRemoteOnline')) document.getElementById('kpiRemoteOnline').innerText = online;
  if (document.getElementById('kpiRemoteOffline')) document.getElementById('kpiRemoteOffline').innerText = offline;
  if (document.getElementById('kpiRemoteProtocols')) document.getElementById('kpiRemoteProtocols').innerText = protocols;

  if (!devices || devices.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-12 text-center text-slate-500 font-sans text-xs">
          Nenhum dispositivo encontrado no servidor Traccar com os filtros atuais.
        </td>
      </tr>
    `;
    return;
  }

  devices.forEach(dev => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-900/60 transition-colors border-b border-slate-800/40';

    const statusBadge = dev.status === 'online'
      ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Online</span>'
      : (dev.status === 'offline'
        ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 text-[10px] font-semibold"><span class="w-1.5 h-1.5 rounded-full bg-rose-400"></span> Offline</span>'
        : '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 text-[10px] font-semibold">Desconhecido</span>');

    const coordsHtml = (dev.hasPosition && typeof dev.lastLat === 'number' && typeof dev.lastLon === 'number')
      ? `<div class="font-mono text-emerald-400 text-xs">${dev.lastLat.toFixed(5)}, ${dev.lastLon.toFixed(5)}</div>`
      : `<span class="text-slate-500 font-sans text-[11px]">Sem fixação GPS</span>`;

    tr.innerHTML = `
      <td class="py-3 px-4">
        <div class="font-bold text-white text-xs">${dev.name}</div>
        <div class="text-[10px] text-slate-400 font-sans capitalize">${dev.category || 'Veículo'}</div>
      </td>
      <td class="py-3 px-4 font-mono text-sky-300 text-xs font-bold">
        ${dev.uniqueId}
      </td>
      <td class="py-3 px-4 font-sans">
        ${statusBadge}
      </td>
      <td class="py-3 px-4">
        <div class="text-xs text-slate-200 font-sans">${dev.model || 'Rastreador'}</div>
        <span class="inline-block px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-mono">${dev.protocol || 'OsmAnd'}</span>
      </td>
      <td class="py-3 px-4">
        ${coordsHtml}
      </td>
      <td class="py-3 px-4 text-center">
        <button onclick="openSecurityImportModal(${dev.id})" type="button" class="bg-indigo-600/90 hover:bg-indigo-600 text-white text-[11px] font-bold px-3 py-1.5 rounded-xl transition-all shadow-sm hover:shadow-indigo-600/20 flex items-center gap-1.5 mx-auto">
          <span>📥 Importar</span>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function filterRemoteDevices() {
  const q = (document.getElementById('searchRemoteDevicesInput')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('filterRemoteStatus')?.value || 'all';

  let filtered = remoteDevicesList;
  if (statusFilter !== 'all') {
    filtered = filtered.filter(d => d.status === statusFilter);
  }
  if (q) {
    filtered = filtered.filter(d => 
      (d.name && d.name.toLowerCase().includes(q)) ||
      (d.uniqueId && String(d.uniqueId).toLowerCase().includes(q)) ||
      (d.model && d.model.toLowerCase().includes(q)) ||
      (d.protocol && d.protocol.toLowerCase().includes(q))
    );
  }
  renderRemoteDevicesTable(filtered);
}

window.openSecurityImportModal = function(deviceId) {
  const dev = remoteDevicesList.find(d => d.id === deviceId);
  if (!dev) return;

  selectedRemoteDeviceForImport = dev;
  document.getElementById('importModalDeviceName').innerText = dev.name;
  document.getElementById('importModalUniqueId').innerText = dev.uniqueId;
  document.getElementById('importModalModel').innerText = `${dev.model || 'Padrão'} (${dev.protocol || 'OsmAnd'})`;

  const checkbox = document.getElementById('checkConfirmSecurityRisk');
  const btnConfirm = document.getElementById('btnConfirmImportDevice');
  if (checkbox) checkbox.checked = false;
  if (btnConfirm) btnConfirm.disabled = true;

  const modal = document.getElementById('modalSecurityWarningImport');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
};

window.closeSecurityImportModal = function() {
  const modal = document.getElementById('modalSecurityWarningImport');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  selectedRemoteDeviceForImport = null;
};

async function confirmImportDevice() {
  if (!selectedRemoteDeviceForImport) return;

  const btnConfirm = document.getElementById('btnConfirmImportDevice');
  const originalHtml = btnConfirm.innerHTML;
  btnConfirm.innerHTML = '<span class="inline-block animate-spin mr-1">⟳</span> Importando...';
  btnConfirm.disabled = true;

  try {
    const creds = getTraccarCredentials();
    const res = await fetch('/api/traccar/import-device', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...creds,
        deviceId: selectedRemoteDeviceForImport.id,
        device: selectedRemoteDeviceForImport,
        confirmedRisk: true
      })
    });
    const data = await res.json();

    if (data.success && data.vehicle) {
      const veh = data.vehicle;
      closeSecurityImportModal();
      alert(`✓ ${data.message}`);
      
      // Adiciona ao mapa local se o mapa já estiver ativo
      if (typeof mapManager !== 'undefined' && mapManager && mapManager.map) {
        const vLat = veh.lat ?? veh.currentLat;
        const vLon = veh.lon ?? veh.currentLon;
        if (vLat && vLon) {
          if (typeof mapManager.updateVehicleMarker === 'function') {
            mapManager.updateVehicleMarker(veh);
          }
          if (veh.routePoints && typeof mapManager.drawRoute === 'function') {
            mapManager.drawRoute(veh.uniqueId, veh.routePoints, 0);
          }
          if (typeof mapManager.panTo === 'function') {
            mapManager.panTo(vLat, vLon, 15);
          }
        }
      }
      
      if (typeof activeVehiclesMap !== 'undefined') {
        activeVehiclesMap.set(veh.uniqueId, veh);
      }
      if (typeof focusVehicle === 'function') {
        focusVehicle(veh.uniqueId);
      }
      
      switchTab('fleet');
    } else {
      alert(`Falha na importação: ${data.message || 'Erro desconhecido'}`);
    }
  } catch (err) {
    alert(`Erro de conexão ao importar: ${err.message}`);
  } finally {
    btnConfirm.innerHTML = originalHtml;
    btnConfirm.disabled = false;
  }
}

// -------------------------------------------------------------
// 3. Gerenciamento de Protocolos & Portas
// -------------------------------------------------------------
async function fetchProtocolsList() {
  const tbody = document.getElementById('protocolsTableBody');
  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-sky-400 font-sans text-xs">
          <span class="inline-block animate-spin mr-2">⟳</span> Carregando protocolos cadastrados...
        </td>
      </tr>
    `;
  }

  try {
    const res = await fetch('/api/traccar/protocols');
    const data = await res.json();

    if (data.success && Array.isArray(data.protocols)) {
      protocolsList = data.protocols;
      renderProtocolsTable(protocolsList);
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="py-6 text-center text-rose-400 font-sans text-xs">
            Erro ao obter lista de protocolos: ${err.message}
          </td>
        </tr>
      `;
    }
  }
}

function renderProtocolsTable(protocols) {
  const tbody = document.getElementById('protocolsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  protocols.forEach(proto => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-900/60 transition-colors border-b border-slate-800/40';

    const customBadge = proto.isDefault
      ? '<span class="inline-block px-1.5 py-0.5 rounded bg-slate-800 text-[10px] text-slate-400 font-sans">Sistema</span>'
      : '<span class="inline-block px-1.5 py-0.5 rounded bg-indigo-500/20 text-[10px] text-indigo-300 font-sans font-semibold border border-indigo-500/30">Customizado</span>';

    const editedBadge = proto.isEdited
      ? `<span class="inline-block px-1.5 py-0.5 rounded bg-amber-500/20 text-[10px] text-amber-300 font-sans font-semibold border border-amber-500/30" title="Porta padrão de fábrica: :${proto.defaultPort}">Editado</span>`
      : '';

    const resetBtn = proto.isEdited
      ? `<button onclick="resetProtocolPort('${proto.id}')" title="Restaurar porta padrão de fábrica (:${proto.defaultPort})" class="bg-amber-900/30 hover:bg-amber-800/50 text-amber-300 text-[10px] font-semibold px-2 py-1 rounded border border-amber-700/40 transition-colors flex items-center gap-1">↺ Padrão :${proto.defaultPort}</button>`
      : '';

    const deleteBtn = !proto.isDefault
      ? `<button onclick="deleteCustomProtocol('${proto.id}')" title="Excluir Protocolo" class="text-rose-400 hover:text-rose-300 p-1 rounded hover:bg-rose-500/10">🗑️</button>`
      : '';

    tr.innerHTML = `
      <td class="py-2.5 px-4">
        <div class="font-bold text-white text-xs flex items-center gap-2 flex-wrap">
          <span>${proto.name}</span>
          ${customBadge}
          ${editedBadge}
        </div>
      </td>
      <td class="py-2.5 px-4">
        <div class="flex items-center gap-1.5">
          <span class="text-slate-500 text-xs font-mono font-bold">:</span>
          <input 
            type="number" 
            id="inputPort_${proto.id}" 
            value="${proto.port}" 
            min="1" 
            max="65535" 
            class="bg-slate-950 border border-slate-700 focus:border-sky-500 focus:outline-none rounded px-2 py-1 text-xs text-sky-400 font-mono font-bold w-20 text-center transition-colors"
          />
          <button 
            onclick="saveProtocolPort('${proto.id}', '${proto.name}')" 
            title="Salvar alteração da porta para ${proto.name}" 
            class="bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold px-2 py-1 rounded border border-sky-400/40 transition-colors shadow-sm"
          >
            💾 Salvar
          </button>
        </div>
      </td>
      <td class="py-2.5 px-4">
        <span class="inline-block px-2 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-slate-300 border border-slate-800">${proto.transport || 'TCP'}</span>
      </td>
      <td class="py-2.5 px-4 text-xs text-slate-400 font-sans">
        ${proto.description || '-'}
      </td>
      <td class="py-2.5 px-4 text-center">
        <div class="flex items-center justify-center gap-1.5 flex-wrap">
          <button onclick="testProtocolPort(null, '${proto.name}', '${proto.id}')" type="button" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold px-2 py-1 rounded border border-slate-700 transition-colors flex items-center gap-1">
            <span>🔌 Testar Porta</span>
          </button>
          ${resetBtn}
          ${deleteBtn}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.saveProtocolPort = async function(id, name) {
  const input = document.getElementById(`inputPort_${id}`);
  if (!input) return;
  const newPort = parseInt(input.value, 10);
  if (isNaN(newPort) || newPort <= 0 || newPort > 65535) {
    alert('Por favor informe uma porta válida entre 1 e 65535.');
    return;
  }

  try {
    const res = await fetch(`/api/traccar/protocols/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: newPort })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✓ ${data.message}`);
      if (id === 'osmand') {
        const osmandInput = document.getElementById('traccarOsmandPort');
        if (osmandInput) osmandInput.value = newPort;
      }
      fetchProtocolsList();
    } else {
      alert(`Erro: ${data.message}`);
    }
  } catch (err) {
    alert(`Erro de rede ao salvar porta: ${err.message}`);
  }
};

window.resetProtocolPort = async function(id) {
  if (!confirm(`Deseja restaurar a porta padrão de fábrica para este protocolo?`)) return;
  try {
    const res = await fetch(`/api/traccar/protocols/${id}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (data.success) {
      alert(`✓ ${data.message}`);
      if (id === 'osmand' && data.protocol) {
        const osmandInput = document.getElementById('traccarOsmandPort');
        if (osmandInput) osmandInput.value = data.protocol.port;
      }
      fetchProtocolsList();
    } else {
      alert(`Erro: ${data.message}`);
    }
  } catch (err) {
    alert(`Erro de rede ao restaurar porta: ${err.message}`);
  }
};

window.saveNewProtocol = function() {
  const name = document.getElementById('newProtoName')?.value.trim();
  const port = parseInt(document.getElementById('newProtoPort')?.value, 10);
  const transport = document.getElementById('newProtoTransport')?.value || 'TCP';
  const description = document.getElementById('newProtoDesc')?.value.trim() || `Porta ${port} (${transport})`;

  if (!name || isNaN(port) || port <= 0 || port > 65535) {
    alert('Por favor informe um Nome válido e uma Porta entre 1 e 65535.');
    return;
  }

  fetch('/api/traccar/protocols', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, port, transport, description })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      alert(`✓ ${data.message}`);
      document.getElementById('newProtoName').value = '';
      document.getElementById('newProtoPort').value = '';
      if (document.getElementById('newProtoDesc')) document.getElementById('newProtoDesc').value = '';
      fetchProtocolsList();
    } else {
      alert(`Erro: ${data.message}`);
    }
  })
  .catch(err => alert(`Erro de rede: ${err.message}`));
};

window.deleteCustomProtocol = function(id) {
  if (!confirm('Deseja realmente remover este protocolo customizado?')) return;
  fetch(`/api/traccar/protocols/${id}`, { method: 'DELETE' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        fetchProtocolsList();
      } else {
        alert(data.message);
      }
    })
    .catch(err => alert(`Erro: ${err.message}`));
};

window.testProtocolPort = async function(port, name, protoId) {
  let targetPort = port;
  if (protoId) {
    const input = document.getElementById(`inputPort_${protoId}`);
    if (input) {
      const parsed = parseInt(input.value, 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 65535) {
        targetPort = parsed;
      }
    }
  }

  const creds = getTraccarCredentials();
  const host = creds.osmandHost || 'localhost';

  try {
    const res = await fetch('/api/traccar/test-port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port: targetPort })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✓ Sucesso! A porta :${targetPort} (${name}) está aberta e acessível em ${host} (Latência: ${data.latencyMs}ms).`);
    } else {
      alert(`✗ Porta :${targetPort} (${name}) inacessível em ${host}: ${data.message}`);
    }
  } catch (err) {
    alert(`Erro ao testar porta :${targetPort}: ${err.message}`);
  }
};

// -------------------------------------------------------------
// 4. Atributos Calculados & Valores de Simulação
// -------------------------------------------------------------
let simulatedAttributesConfig = {};

async function fetchSimulationAttributesConfig() {
  const tbody = document.getElementById('simulatedAttributesTableBody');
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-sky-400 font-sans text-xs"><span class="inline-block animate-spin mr-2">⟳</span> Carregando parâmetros de simulação...</td></tr>`;
  }

  try {
    const res = await fetch('/api/simulation/attributes/config');
    const data = await res.json();
    if (data.success && data.configs) {
      simulatedAttributesConfig = data.configs;
      renderSimulatedAttributesTable(simulatedAttributesConfig);
    }
  } catch (err) {
    console.warn('Erro ao carregar parâmetros de simulação de atributos:', err);
  }
}

function renderSimulatedAttributesTable(configs) {
  const tbody = document.getElementById('simulatedAttributesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const keys = Object.keys(configs);
  if (keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 font-sans text-xs">Nenhum atributo ativo para simulação. Clique em "Sincronizar com Traccar" para carregar ou adicione manualmente.</td></tr>`;
    return;
  }

  keys.forEach(k => {
    const item = configs[k];
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-900/60 transition-colors border-b border-slate-800/40';

    const isEnabled = item.enabled !== false;
    const inputVal = item.value !== undefined ? String(item.value) : '';

    tr.innerHTML = `
      <td class="py-3 px-4 text-center">
        <input type="checkbox" id="simAttrEnabled_${k}" ${isEnabled ? 'checked' : ''} onchange="toggleSimAttr('${k}', this.checked)" class="rounded bg-slate-900 border-slate-700 text-sky-500 focus:ring-0 w-4 h-4 cursor-pointer">
      </td>
      <td class="py-3 px-4 font-mono font-bold text-sky-400 text-xs">
        ${k}
      </td>
      <td class="py-3 px-4 text-xs text-slate-300 font-sans">
        ${item.description || item.rule || 'Atributo de telemetria'}
      </td>
      <td class="py-3 px-4">
        <span class="inline-block px-2 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-slate-300 border border-slate-800 uppercase">${item.type || 'string'}</span>
      </td>
      <td class="py-3 px-4">
        <div class="flex items-center gap-2">
          <input type="text" id="simAttrValue_${k}" value="${inputVal}" placeholder="Ex: 85, true, 22.5" class="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-100 font-mono w-44 focus:border-sky-500">
          <span class="text-[10px] text-slate-500 font-mono">sugerido: ${item.suggestedValue || '-'}</span>
        </div>
      </td>
      <td class="py-3 px-4 text-center">
        <button onclick="removeSimAttr('${k}')" title="Remover da simulação" class="text-rose-400 hover:text-rose-300 p-1.5 rounded hover:bg-rose-500/10">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.toggleSimAttr = function(key, isChecked) {
  if (simulatedAttributesConfig[key]) {
    simulatedAttributesConfig[key].enabled = isChecked;
  }
};

window.removeSimAttr = function(key) {
  delete simulatedAttributesConfig[key];
  renderSimulatedAttributesTable(simulatedAttributesConfig);
};

window.addComputedToSimulation = function(key, type, description, suggestedValue) {
  simulatedAttributesConfig[key] = {
    key: key,
    type: type || 'string',
    description: description || `Atributo calculado (${key})`,
    value: suggestedValue || '',
    suggestedValue: suggestedValue || '',
    enabled: true
  };
  renderSimulatedAttributesTable(simulatedAttributesConfig);
  alert(`✓ Atributo '${key}' adicionado à tabela de injeção da simulação!`);
};

window.addManualAttribute = function() {
  const key = prompt('Informe o nome da chave do atributo (ex: door, cargoTemp, driverId):');
  if (!key || !key.trim()) return;
  const cleanKey = key.trim();
  const value = prompt(`Informe o valor padrão para o atributo '${cleanKey}':`, '1');
  if (value === null) return;

  simulatedAttributesConfig[cleanKey] = {
    key: cleanKey,
    type: isNaN(value) ? (value === 'true' || value === 'false' ? 'boolean' : 'string') : 'number',
    description: `Atributo manual (${cleanKey})`,
    value: value.trim(),
    suggestedValue: value.trim(),
    enabled: true
  };
  renderSimulatedAttributesTable(simulatedAttributesConfig);
};

window.saveSimulationAttributesConfig = async function() {
  const btn = document.getElementById('btnSaveSimulatedAttributes');
  const origText = btn ? btn.innerHTML : 'Salvar';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="inline-block animate-spin mr-1">⟳</span> Salvando...`;
  }

  // Coleta os valores atuais dos inputs
  Object.keys(simulatedAttributesConfig).forEach(k => {
    const inputEl = document.getElementById(`simAttrValue_${k}`);
    const enableEl = document.getElementById(`simAttrEnabled_${k}`);
    if (inputEl) {
      simulatedAttributesConfig[k].value = inputEl.value.trim();
    }
    if (enableEl) {
      simulatedAttributesConfig[k].enabled = enableEl.checked;
    }
  });

  try {
    const res = await fetch('/api/simulation/attributes/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configs: simulatedAttributesConfig })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✓ ${data.message}`);
    } else {
      alert(`Erro ao salvar: ${data.message}`);
    }
  } catch (err) {
    alert(`Erro de conexão: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
};

async function fetchComputedAttributesList(notify = false) {
  const tbody = document.getElementById('computedAttributesTableBody');
  const btnRefresh = document.getElementById('btnRefreshComputedAttributes');
  const icon = document.getElementById('btnRefreshComputedAttributesIcon');

  if (icon) icon.className = 'inline-block animate-spin';
  if (btnRefresh) btnRefresh.disabled = true;

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-12 text-center text-sky-400 font-sans text-xs">
          <span class="inline-block animate-spin mr-2">⟳</span> Consultando /api/attributes/computed no Traccar remoto...
        </td>
      </tr>
    `;
  }

  try {
    const creds = getTraccarCredentials();
    const res = await fetch('/api/traccar/computed-attributes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();

    if (data.success && Array.isArray(data.attributes)) {
      computedAttributesList = data.attributes;
      const badge = document.getElementById('badgeComputedAttributesCount');
      if (badge) badge.innerText = computedAttributesList.length;
      renderComputedAttributesTable(computedAttributesList);

      // Adiciona automaticamente às configurações de simulação com sugestão
      data.attributes.forEach(attr => {
        if (!simulatedAttributesConfig[attr.attribute]) {
          simulatedAttributesConfig[attr.attribute] = {
            key: attr.attribute,
            type: attr.type || 'string',
            description: attr.description || 'Atributo calculado Traccar',
            value: attr.suggestedValue || '',
            suggestedValue: attr.suggestedValue || '',
            enabled: true
          };
        }
      });
      renderSimulatedAttributesTable(simulatedAttributesConfig);

      if (notify) {
        alert(`✓ Sincronização concluída! ${data.attributes.length} atributos calculados mapeados do Traccar.`);
      }
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="5" class="py-8 text-center text-slate-400 font-sans text-xs">
              Nenhum atributo calculado retornado pelo Traccar: ${data.message || 'Sem dados'}
            </td>
          </tr>
        `;
      }
    }
  } catch (err) {
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="py-8 text-center text-rose-400 font-sans text-xs">
            Erro ao buscar atributos calculados: ${err.message}
          </td>
        </tr>
      `;
    }
  } finally {
    if (icon) icon.className = '';
    if (btnRefresh) btnRefresh.disabled = false;
  }
}

function renderComputedAttributesTable(attributes) {
  const tbody = document.getElementById('computedAttributesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!attributes || attributes.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-12 text-center text-slate-500 font-sans text-xs">
          Nenhum atributo calculado cadastrado em /settings/attributes no Traccar.
        </td>
      </tr>
    `;
    return;
  }

  attributes.forEach(attr => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-900/60 transition-colors border-b border-slate-800/40';

    tr.innerHTML = `
      <td class="py-3 px-4 font-mono font-bold text-sky-400 text-xs">
        ${attr.attribute}
      </td>
      <td class="py-3 px-4 text-xs text-slate-300 font-sans">
        ${attr.description || '-'}
      </td>
      <td class="py-3 px-4">
        <code class="bg-slate-900 text-amber-300 font-mono text-[10px] px-2 py-0.5 rounded border border-slate-800 break-all inline-block max-w-xs">
          ${attr.expression || '-'}
        </code>
      </td>
      <td class="py-3 px-4">
        <span class="inline-block px-2 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-slate-300 border border-slate-800 uppercase">
          ${attr.type || 'string'}
        </span>
      </td>
      <td class="py-3 px-4 text-center">
        <button onclick="addComputedToSimulation('${attr.attribute}', '${attr.type}', '${attr.description || ''}', '${attr.suggestedValue}')" type="button" class="bg-indigo-600/80 hover:bg-indigo-600 text-white text-[11px] font-bold px-2.5 py-1 rounded-lg transition-all flex items-center gap-1 mx-auto shadow-sm">
          <span>➕ Usar na Simulação</span>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function analyzeTraccar() {
  const creds = getTraccarCredentials();
  const btn = document.getElementById('btnAnalyze');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="inline-block animate-spin mr-2">⟳</span> Analisando Base...`;
  btn.disabled = true;

  try {
    const res = await fetch('/api/traccar/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    const data = await res.json();

    if (!data.success) {
      alert(`Falha ao analisar Traccar: ${data.message}`);
      return;
    }

    // 1. Atualiza Select de Modelos (estritamente OsmAnd ou modelos reais)
    renderModelSelect(data.models);

    // 2. Renderiza Atributos Descobertos e seus Valores de Exemplo
    currentAttributes = data.attributes || [];
    renderAttributesTable(currentAttributes);

    alert(`Análise concluída com sucesso! ${data.devicesCount} dispositivos encontrados na base do Traccar.`);
    // Redireciona para a aba de inserção
    switchTab('create');
  } catch (err) {
    alert(`Erro ao analisar Traccar: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

function renderModelSelect(models) {
  const select = document.getElementById('selectVehicleModel');
  if (!select) return;
  select.innerHTML = '';

  if (!models || models.length === 0 || (models.length === 1 && models[0] === 'OsmAnd')) {
    const opt = document.createElement('option');
    opt.value = 'OsmAnd';
    opt.innerText = 'OsmAnd (Padrão HTTP)';
    select.appendChild(opt);
    return;
  }

  select.innerHTML = '<option value="auto">Sorteio entre os Modelos do Traccar</option>';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.innerText = m;
    select.appendChild(opt);
  });
}

function renderAttributesTable(attributes) {
  const tbody = document.getElementById('attributesTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!attributes || attributes.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="3" class="py-6 text-center text-slate-500 text-xs">
        Nenhum atributo adicional cadastrado no Traccar.<br>
        <span class="text-slate-400">A telemetria básica (posição, velocidade, ignição, odômetro e bateria) será enviada normalmente.</span>
      </td>
    `;
    tbody.appendChild(tr);
    return;
  }

  attributes.forEach((attr, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-800/50 hover:bg-slate-800/40 transition-colors';

    const examplesText = (attr.examples && attr.examples.length > 0)
      ? attr.examples.join(', ')
      : (attr.recommendedValue !== undefined ? String(attr.recommendedValue) : 'Nenhum');

    const isNumeric = attr.type === 'number';

    tr.innerHTML = `
      <td class="py-3 px-3">
        <div class="font-medium text-slate-200 text-xs">${attr.label || attr.key}</div>
        <div class="text-[10px] text-slate-400 font-mono">${attr.key} (${attr.type})</div>
      </td>
      <td class="py-3 px-3">
        <span class="inline-block max-w-[150px] truncate text-[11px] font-mono bg-slate-950 text-sky-300 px-2 py-0.5 rounded border border-slate-800" title="${examplesText}">
          ${examplesText}
        </span>
      </td>
      <td class="py-3 px-3">
        <div class="flex items-center gap-1.5" id="attrControl_${idx}">
          <input type="text" id="attrVal_${idx}" value="${attr.recommendedValue || ''}" class="bg-slate-950 border border-slate-800 text-xs rounded-lg px-2 py-1 text-slate-200 w-32 focus:border-sky-500">
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function addManualAttribute() {
  const key = prompt('Informe a chave do novo atributo (ex: fuel, driverCard):');
  if (!key || !key.trim()) return;

  const cleanKey = key.trim();
  currentAttributes.push({
    key: cleanKey,
    label: cleanKey,
    source: 'user_custom',
    type: 'string',
    examples: ['Exemplo'],
    recommendedValue: 'Exemplo'
  });

  renderAttributesTable(currentAttributes);
}

// -------------------------------------------------------------
// Inserção em Massa e Inicialização da Simulação
// -------------------------------------------------------------
async function startBatchSimulation() {
  const creds = getTraccarCredentials();
  const count = Number(document.getElementById('inputVehicleCount').value) || 5;
  const selectedModel = document.getElementById('selectVehicleModel')?.value || 'OsmAnd';
  const centerLat = Number(document.getElementById('inputLat').value) || -23.5505;
  const centerLon = Number(document.getElementById('inputLon').value) || -46.6333;
  const radiusKm = Number(document.getElementById('inputRadius').value) || 8;
  const createInTraccar = document.getElementById('checkCreateInTraccar').checked;

  const attributeConfigs = {};
  currentAttributes.forEach((attr, idx) => {
    const valEl = document.getElementById(`attrVal_${idx}`);
    if (valEl) {
      attributeConfigs[attr.key] = { mode: 'fixed', value: valEl.value };
    }
  });

  const payload = {
    traccarUrl: creds.url,
    traccarUser: creds.username,
    traccarPassword: creds.password,
    osmandHost: creds.osmandHost,
    osmandPort: creds.osmandPort,
    vehiclesCount: count,
    selectedModel,
    centerLat,
    centerLon,
    radiusKm,
    attributeConfigs,
    createInTraccar
  };

  const btn = document.getElementById('btnStartBatchSimulation');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="inline-block animate-spin mr-2">⟳</span> Gerando rotas no mapa e disparando...`;
  btn.disabled = true;

  try {
    const res = await fetch('/api/simulation/setup-fleet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!data.success) {
      alert(`Falha ao inicializar frota: ${data.message}`);
      return;
    }

    mapManager.clearVehicles();
    activeVehiclesMap.clear();

    // Notificação
    let msg = `Frota de ${data.vehicles.length} veículos criada e em circulação no mapa!`;
    if (data.provisionResults?.failed?.length > 0) {
      const failedCount = data.provisionResults.failed.length;
      const firstReason = data.provisionResults.failed[0]?.reason || 'Erro no Traccar';
      msg += `\n\n⚠️ ALERTA DO TRACCAR REMOTO:\nNão foi possível cadastrar ${failedCount} veículo(s) no seu servidor Traccar.\nMotivo: ${firstReason}\n\n👉 Acesse a aba "Configurações" e utilize o botão "🧪 Criar Veículo de Teste" para diagnosticar e ajustar as permissões da sua conta Traccar.`;
    }
    alert(msg);

    // Muda automaticamente para a aba Home (Mapa)
    switchTab('home');
    mapManager.fitBoundsAll();
  } catch (err) {
    alert(`Erro ao iniciar simulação: ${err.message}`);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

// -------------------------------------------------------------
// Logs de Telemetria OsmAnd (Feed e Modal Expandido)
// -------------------------------------------------------------
// -------------------------------------------------------------
// Logs de Telemetria OsmAnd (Aba Principal e Histórico por Veículo)
// -------------------------------------------------------------
let telemetryLogsHistory = [];
let totalDispatchesCount = 0;
let autoScrollModal = true;
let autoScrollTabLogs = true;
let selectedLogFilterVehicle = '';
let selectedTabLogFilterVehicle = '';

window.toggleTabLogsAutoScroll = function() {
  autoScrollTabLogs = !autoScrollTabLogs;
  const btn = document.getElementById('btnTabLogsToggleAutoScroll');
  if (btn) {
    if (autoScrollTabLogs) {
      btn.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span><span>Rolagem: Auto</span>`;
      btn.className = 'px-3 py-1.5 rounded-xl text-xs font-medium border border-slate-800 bg-slate-900 text-sky-400 hover:text-sky-300 transition-colors flex items-center gap-1.5';
      renderTabLogsTable();
    } else {
      btn.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span><span>Rolagem: Pausada</span>`;
      btn.className = 'px-3 py-1.5 rounded-xl text-xs font-medium border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:text-amber-200 transition-colors flex items-center gap-1.5';
    }
  }
};

window.handleTabLogsFilterChange = function(vehicleId) {
  selectedTabLogFilterVehicle = vehicleId;
  renderTabLogsTable();
};

window.updateTabLogsVehicleFilter = function() {
  const filterSelect = document.getElementById('tabLogsFilterVehicle');
  if (!filterSelect) return;

  const currentVal = selectedTabLogFilterVehicle || filterSelect.value;
  filterSelect.innerHTML = '<option value="">Todos os Veículos</option>';

  const vehicles = Array.from(activeVehiclesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  vehicles.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.uniqueId;
    opt.innerText = `${v.name} (${v.uniqueId})`;
    if (v.uniqueId === currentVal) opt.selected = true;
    filterSelect.appendChild(opt);
  });
};

window.renderTabLogsTable = function() {
  const tbody = document.getElementById('tabLogsTableBody');
  if (!tbody) return;

  const filtered = selectedTabLogFilterVehicle
    ? telemetryLogsHistory.filter(l => l.uniqueId === selectedTabLogFilterVehicle)
    : telemetryLogsHistory;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="py-16 text-center text-slate-500 font-sans text-xs">Nenhum registro de telemetria encontrado.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(item => `
    <tr class="hover:bg-slate-800/40 transition-colors">
      <td class="py-2.5 px-4 text-slate-400 whitespace-nowrap">${item.time}</td>
      <td class="py-2.5 px-4 text-white font-medium whitespace-nowrap">
        <span class="text-sky-400 font-bold">${item.name}</span>
        <span class="text-[10px] text-slate-400 block font-mono">ID: ${item.uniqueId}</span>
      </td>
      <td class="py-2.5 px-4 whitespace-nowrap">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${item.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
          ${item.success ? `HTTP ${item.status}` : 'FALHA HTTP'}
        </span>
      </td>
      <td class="py-2.5 px-4 text-slate-200 whitespace-nowrap">${item.speedKmh} km/h</td>
      <td class="py-2.5 px-4 whitespace-nowrap">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${item.ignition ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
          ${item.ignition ? 'LIGADA' : 'DESLIGADA'}
        </span>
      </td>
      <td class="py-2.5 px-4 text-slate-300 whitespace-nowrap">${item.power} V</td>
      <td class="py-2.5 px-4 text-slate-400 whitespace-nowrap font-mono">${item.lat}, ${item.lon}</td>
      <td class="py-2.5 px-3 text-center whitespace-nowrap">
        <button onclick="openPayloadInspector('${item.id}')" title="Inspecionar Payload da Request" class="p-1.5 rounded-lg bg-slate-950 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 border border-slate-800 transition-colors inline-flex items-center justify-center">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
        </button>
      </td>
    </tr>
  `).join('');

  if (autoScrollTabLogs) {
    const scrollContainer = document.getElementById('tabLogsScrollContainer');
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }
};

let currentInspectedPayloadJson = '';

window.openPayloadInspector = function(logId) {
  const item = telemetryLogsHistory.find(l => String(l.id) === String(logId));
  if (!item) return;

  const modal = document.getElementById('payloadInspectorModal');
  const urlEl = document.getElementById('payloadInspectorUrl');
  const jsonEl = document.getElementById('payloadInspectorJson');
  const subtitleEl = document.getElementById('payloadInspectorSubtitle');
  const badgeEl = document.getElementById('payloadInspectorStatusBadge');
  const btnCopyText = document.getElementById('btnCopyPayloadText');

  if (!modal) return;

  if (subtitleEl) {
    subtitleEl.innerText = `${item.name} (${item.uniqueId}) • ${item.time}`;
  }
  if (badgeEl) {
    badgeEl.innerText = item.success ? `HTTP ${item.status || 200}` : `FALHA (${item.status || 'ERR'})`;
    badgeEl.className = item.success
      ? 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
      : 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20';
  }

  let fullUrl = item.url;
  if (!fullUrl) {
    const creds = getTraccarCredentials();
    const host = creds.osmandHost || 'localhost';
    const port = creds.osmandPort || 5055;
    const searchParams = new URLSearchParams();
    searchParams.set('id', item.uniqueId);
    searchParams.set('lat', item.lat);
    searchParams.set('lon', item.lon);
    searchParams.set('speed', ((item.speedKmh || 0) * 0.539957).toFixed(1));
    searchParams.set('ignition', String(item.ignition));
    searchParams.set('power', String(item.power));
    fullUrl = `http://${host}:${port}/?${searchParams.toString()}`;
  }

  if (urlEl) {
    urlEl.innerText = fullUrl;
  }

  const displayPayload = {
    uniqueId: item.uniqueId,
    timestamp: item.time,
    status: item.status,
    success: item.success,
    location: {
      latitude: Number(item.lat),
      longitude: Number(item.lon),
      speedKmh: item.speedKmh,
      speedKnots: Number(((item.speedKmh || 0) * 0.539957).toFixed(2))
    },
    attributes: {
      ignition: item.ignition,
      power: Number(item.power),
      ...(item.params || item.payload || {})
    },
    rawRequestUrl: fullUrl
  };

  currentInspectedPayloadJson = JSON.stringify(displayPayload, null, 2);
  if (jsonEl) {
    jsonEl.innerText = currentInspectedPayloadJson;
  }

  if (btnCopyText) {
    btnCopyText.innerText = 'Copiar JSON';
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
};

window.closePayloadInspectorModal = function() {
  const modal = document.getElementById('payloadInspectorModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

window.copyPayloadToClipboard = async function() {
  if (!currentInspectedPayloadJson) return;
  try {
    await navigator.clipboard.writeText(currentInspectedPayloadJson);
    const btnCopyText = document.getElementById('btnCopyPayloadText');
    if (btnCopyText) {
      btnCopyText.innerText = 'Copiado!';
      setTimeout(() => {
        btnCopyText.innerText = 'Copiar JSON';
      }, 2000);
    }
  } catch (err) {
    console.error('Falha ao copiar:', err);
  }
};

window.openTelemetryModal = function() {
  const modal = document.getElementById('telemetryLogsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');

  updateModalVehicleFilter();
  renderModalLogsTable();
};

window.closeTelemetryModal = function() {
  const modal = document.getElementById('telemetryLogsModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.classList.remove('flex');
};

window.toggleAutoScroll = function() {
  autoScrollModal = !autoScrollModal;
  const btn = document.getElementById('btnToggleAutoScroll');
  if (btn) {
    if (autoScrollModal) {
      btn.innerText = 'Rolagem: Auto';
      btn.className = 'px-2.5 py-1.5 rounded-xl text-xs font-medium border border-slate-800 bg-slate-950 text-sky-400 hover:text-sky-300 transition-colors';
    } else {
      btn.innerText = 'Rolagem: Fixa';
      btn.className = 'px-2.5 py-1.5 rounded-xl text-xs font-medium border border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-300 transition-colors';
    }
  }
};

window.clearAllLogs = function() {
  telemetryLogsHistory = [];
  totalDispatchesCount = 0;

  const tabLogsTable = document.getElementById('tabLogsTableBody');
  if (tabLogsTable) {
    tabLogsTable.innerHTML = '<tr><td colspan="7" class="py-16 text-center text-slate-500 font-sans text-xs">Feed de telemetria limpo.</td></tr>';
  }

  const modalTable = document.getElementById('modalLogsTableBody');
  if (modalTable) {
    modalTable.innerHTML = '<tr><td colspan="7" class="py-16 text-center text-slate-500 font-sans text-xs">Aguardando novos disparos de telemetria...</td></tr>';
  }

  const badgeTabHeader = document.getElementById('tabLogsBadge');
  if (badgeTabHeader) badgeTabHeader.innerText = '0';
  const badgeLogsHeader = document.getElementById('tabLogsHeaderBadge');
  if (badgeLogsHeader) badgeLogsHeader.innerText = '0 pacotes';
  const badge2 = document.getElementById('modalLogsCountBadge');
  if (badge2) badge2.innerText = '0 pacotes';

  if (selectedVehicleForModal && activeVehiclesMap.has(selectedVehicleForModal)) {
    updateVehicleDetailModalContent(activeVehiclesMap.get(selectedVehicleForModal));
  }
};

function updateModalVehicleFilter() {
  const filterSelect = document.getElementById('modalLogsFilterVehicle');
  if (!filterSelect) return;

  const currentVal = filterSelect.value;
  filterSelect.innerHTML = '<option value="">Todos os Veículos</option>';

  const vehicles = Array.from(activeVehiclesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  vehicles.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.uniqueId;
    opt.innerText = `${v.name} (${v.uniqueId})`;
    if (v.uniqueId === currentVal) opt.selected = true;
    filterSelect.appendChild(opt);
  });
}

function renderModalLogsTable() {
  const tbody = document.getElementById('modalLogsTableBody');
  if (!tbody) return;

  const filtered = selectedLogFilterVehicle
    ? telemetryLogsHistory.filter(l => l.uniqueId === selectedLogFilterVehicle)
    : telemetryLogsHistory;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-16 text-center text-slate-500 font-sans text-xs">Nenhum registro para o filtro selecionado.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(item => `
    <tr class="hover:bg-slate-800/40 transition-colors">
      <td class="py-2.5 px-3 text-slate-400 whitespace-nowrap">${item.time}</td>
      <td class="py-2.5 px-3 text-white font-medium whitespace-nowrap">
        <span class="text-sky-400 font-bold">${item.name}</span>
        <span class="text-[10px] text-slate-400 block font-mono">ID: ${item.uniqueId}</span>
      </td>
      <td class="py-2.5 px-3 whitespace-nowrap">
        ${item.isCommand
          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">COMANDO TRACCAR</span>`
          : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${item.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
              ${item.success ? `HTTP ${item.status}` : 'FALHA HTTP'}
            </span>`
        }
      </td>
      <td class="py-2.5 px-3 text-slate-200 whitespace-nowrap">${item.speedKmh} km/h</td>
      <td class="py-2.5 px-3 whitespace-nowrap">
        <span class="px-2 py-0.5 rounded text-[10px] font-bold ${item.ignition ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
          ${item.ignition ? 'LIGADA' : 'DESLIGADA'}
        </span>
      </td>
      <td class="py-2.5 px-3 text-slate-300 whitespace-nowrap">${item.power} V</td>
      <td class="py-2.5 px-3 text-slate-400 whitespace-nowrap font-mono">${item.lat}, ${item.lon}</td>
    </tr>
  `).join('');

  if (autoScrollModal) {
    const scrollContainer = document.getElementById('modalLogsScrollContainer');
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }
}

function showCommandToast(vehicleName, message) {
  let toastContainer = document.getElementById('commandToastContainer');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'commandToastContainer';
    toastContainer.className = 'fixed top-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm pointer-events-none';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  const isBlock = message.includes('BLOQUEIO');
  toast.className = `p-3.5 rounded-2xl border shadow-2xl transition-all duration-300 transform translate-y-0 opacity-100 flex items-start gap-3 pointer-events-auto ${
    isBlock
      ? 'bg-rose-950/90 border-rose-500/50 text-rose-200 shadow-rose-900/30'
      : 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200 shadow-emerald-900/30'
  }`;

  toast.innerHTML = `
    <span class="text-base">${isBlock ? '🛑' : '🟢'}</span>
    <div class="flex-1">
      <div class="font-bold text-xs ${isBlock ? 'text-rose-300' : 'text-emerald-300'} flex items-center justify-between">
        <span>Comando Traccar Refletido</span>
        <span class="text-[9px] font-mono opacity-70">${new Date().toLocaleTimeString()}</span>
      </div>
      <div class="text-[11px] font-medium text-white mt-0.5">${vehicleName}</div>
      <div class="text-[10px] text-slate-300 mt-0.5 leading-snug">${message}</div>
    </div>
  `;

  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function addLogEntry(data) {
  totalDispatchesCount++;
  const log = data.log || {};

  const isCommand = (log.request_url && log.request_url.includes('TRACCAR_COMMAND_RECEIVED')) ||
                    (log.response && typeof log.response === 'string' && log.response.includes('COMANDO REFLETIDO'));

  const entry = {
    id: 'log_' + Date.now() + '_' + Math.floor(Math.random() * 100000),
    time: log.time || new Date().toLocaleTimeString(),
    name: data.name,
    uniqueId: data.uniqueId,
    status: log.status,
    success: log.success,
    speedKmh: log.speedKmh ?? 0,
    ignition: log.ignition,
    power: log.power || (log.ignition ? '13.8' : '12.4'),
    lat: log.lat || '0.00000',
    lon: log.lon || '0.00000',
    url: log.url || log.request_url || '',
    params: log.params || log.payload || {},
    payload: log.payload || log.params || {},
    isCommand: Boolean(isCommand),
    commandAction: isCommand ? (log.response || 'Comando Traccar') : null
  };

  if (isCommand) {
    showCommandToast(data.name || data.uniqueId, log.response || 'Comando recebido do Traccar');
  }

  telemetryLogsHistory.unshift(entry);
  if (telemetryLogsHistory.length > 250) {
    telemetryLogsHistory.pop();
  }

  // Atualiza Contadores nos Badges
  const badgeTabHeader = document.getElementById('tabLogsBadge');
  if (badgeTabHeader) badgeTabHeader.innerText = totalDispatchesCount;
  const badgeLogsHeader = document.getElementById('tabLogsHeaderBadge');
  if (badgeLogsHeader) badgeLogsHeader.innerText = `${totalDispatchesCount} pacotes`;
  const badge2 = document.getElementById('modalLogsCountBadge');
  if (badge2) badge2.innerText = `${totalDispatchesCount} pacotes`;

  // 1. Se a aba Comandos & Logs estiver aberta, atualiza dinamicamente a tabela
  // Se autoScrollTabLogs estiver desativado (rolagem pausada), NÃO insere novas linhas no DOM para congelar a visão do usuário
  if (currentTab === 'logs' && autoScrollTabLogs) {
    if (!selectedTabLogFilterVehicle || selectedTabLogFilterVehicle === entry.uniqueId) {
      const tbody = document.getElementById('tabLogsTableBody');
      if (tbody) {
        if (tbody.children.length === 1 && tbody.children[0].children.length === 1) {
          tbody.innerHTML = '';
        }
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/40 transition-colors';
        tr.innerHTML = `
          <td class="py-2.5 px-4 text-slate-400 whitespace-nowrap">${entry.time}</td>
          <td class="py-2.5 px-4 text-white font-medium whitespace-nowrap">
            <span class="text-sky-400 font-bold">${entry.name}</span>
            <span class="text-[10px] text-slate-400 block font-mono">ID: ${entry.uniqueId}</span>
          </td>
          <td class="py-2.5 px-4 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${entry.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
              ${entry.success ? `HTTP ${entry.status}` : 'FALHA HTTP'}
            </span>
          </td>
          <td class="py-2.5 px-4 text-slate-200 whitespace-nowrap">${entry.speedKmh} km/h</td>
          <td class="py-2.5 px-4 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${entry.ignition ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
              ${entry.ignition ? 'LIGADA' : 'DESLIGADA'}
            </span>
          </td>
          <td class="py-2.5 px-4 text-slate-300 whitespace-nowrap">${entry.power} V</td>
          <td class="py-2.5 px-4 text-slate-400 whitespace-nowrap font-mono">${entry.lat}, ${entry.lon}</td>
          <td class="py-2.5 px-3 text-center whitespace-nowrap">
            <button onclick="openPayloadInspector('${entry.id}')" title="Inspecionar Payload da Request" class="p-1.5 rounded-lg bg-slate-950 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 border border-slate-800 transition-colors inline-flex items-center justify-center">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            </button>
          </td>
        `;
        tbody.insertBefore(tr, tbody.firstChild);
        if (tbody.children.length > 250) tbody.removeChild(tbody.lastChild);
        const scrollContainer = document.getElementById('tabLogsScrollContainer');
        if (scrollContainer) scrollContainer.scrollTop = 0;
      }
    }
  }

  // 2. Se o modal de detalhes estiver aberto e for este veículo, atualiza conteúdo
  if (selectedVehicleForModal === entry.uniqueId) {
    if (activeVehiclesMap.has(entry.uniqueId)) {
      updateVehicleDetailModalContent(activeVehiclesMap.get(entry.uniqueId));
    }
  }

  // 3. Modal de Logs legado
  const modal = document.getElementById('telemetryLogsModal');
  if (modal && !modal.classList.contains('hidden')) {
    if (!selectedLogFilterVehicle || selectedLogFilterVehicle === entry.uniqueId) {
      const tbody = document.getElementById('modalLogsTableBody');
      if (tbody) {
        if (tbody.children.length === 1 && tbody.children[0].children.length === 1) {
          tbody.innerHTML = '';
        }
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-800/40 transition-colors';
        tr.innerHTML = `
          <td class="py-2.5 px-3 text-slate-400 whitespace-nowrap">${entry.time}</td>
          <td class="py-2.5 px-3 text-white font-medium whitespace-nowrap">
            <span class="text-sky-400 font-bold">${entry.name}</span>
            <span class="text-[10px] text-slate-400 block font-mono">ID: ${entry.uniqueId}</span>
          </td>
          <td class="py-2.5 px-3 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${entry.success ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
              ${entry.success ? `HTTP ${entry.status}` : 'FALHA HTTP'}
            </span>
          </td>
          <td class="py-2.5 px-3 text-slate-200 whitespace-nowrap">${entry.speedKmh} km/h</td>
          <td class="py-2.5 px-3 whitespace-nowrap">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${entry.ignition ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'}">
              ${entry.ignition ? 'LIGADA' : 'DESLIGADA'}
            </span>
          </td>
          <td class="py-2.5 px-3 text-slate-300 whitespace-nowrap">${entry.power} V</td>
          <td class="py-2.5 px-3 text-slate-400 whitespace-nowrap font-mono">${entry.lat}, ${entry.lon}</td>
        `;
        tbody.insertBefore(tr, tbody.firstChild);
        if (tbody.children.length > 200) tbody.removeChild(tbody.lastChild);
        if (autoScrollModal) {
          const scrollContainer = document.getElementById('modalLogsScrollContainer');
          if (scrollContainer) scrollContainer.scrollTop = 0;
        }
      }
    }
  }
}


function setSimulationStateUI(state) {
  const btnPause = document.getElementById('btnPauseSim');
  const btnResume = document.getElementById('btnResumeSim');
  const stateBadge = document.getElementById('simStateBadge');

  if (!btnPause || !btnResume || !stateBadge) return;

  if (state === 'running') {
    btnPause.classList.remove('hidden');
    btnResume.classList.add('hidden');
    stateBadge.className = 'px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
    stateBadge.innerText = 'Rodando';
  } else if (state === 'paused') {
    btnPause.classList.add('hidden');
    btnResume.classList.remove('hidden');
    stateBadge.className = 'px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20';
    stateBadge.innerText = 'Pausado';
  } else {
    btnPause.classList.remove('hidden');
    btnResume.classList.add('hidden');
    stateBadge.className = 'px-2.5 py-1 text-xs font-semibold rounded-full bg-slate-800 text-slate-300';
    stateBadge.innerText = 'Parado';
  }
}

// -------------------------------------------------------------
// Controle de Seleção e Remoção de Veículos (Unitária e em Massa)
// -------------------------------------------------------------
window.toggleVehicleSelection = function(uniqueId, isChecked) {
  if (isChecked) {
    selectedFleetVehicleIds.add(uniqueId);
  } else {
    selectedFleetVehicleIds.delete(uniqueId);
  }
  updateFleetSelectionUI();
};

window.toggleSelectAllFleet = function(isChecked) {
  const filterText = (document.getElementById('filterVehicleSearch')?.value || '').toLowerCase();
  let vehicles = Array.from(activeVehiclesMap.values());
  if (filterText) {
    vehicles = vehicles.filter(v =>
      (v.name && v.name.toLowerCase().includes(filterText)) ||
      (v.plate && v.plate.toLowerCase().includes(filterText)) ||
      (v.uniqueId && v.uniqueId.toLowerCase().includes(filterText))
    );
  }

  if (isChecked) {
    vehicles.forEach(v => selectedFleetVehicleIds.add(v.uniqueId));
  } else {
    selectedFleetVehicleIds.clear();
  }

  renderFleetTab();
  updateFleetSelectionUI();
};

function updateFleetSelectionUI() {
  const count = selectedFleetVehicleIds.size;
  const badge = document.getElementById('selectedFleetBadge');
  const btnDelete = document.getElementById('btnDeleteSelectedVehicles');
  const btnText = document.getElementById('btnDeleteSelectedText');
  const selectAllCb = document.getElementById('selectAllFleetCheckbox');

  if (badge) {
    if (count > 0) {
      badge.classList.remove('hidden');
      badge.innerText = `${count} selecionado${count > 1 ? 's' : ''}`;
    } else {
      badge.classList.add('hidden');
    }
  }

  if (btnDelete) {
    if (count > 0) {
      btnDelete.classList.remove('hidden');
      btnDelete.classList.add('flex');
      if (btnText) btnText.innerText = `Excluir Selecionados (${count})`;
    } else {
      btnDelete.classList.add('hidden');
      btnDelete.classList.remove('flex');
    }
  }

  if (selectAllCb) {
    const totalVisible = activeVehiclesMap.size;
    selectAllCb.checked = totalVisible > 0 && count === totalVisible;
    selectAllCb.indeterminate = count > 0 && count < totalVisible;
  }
}

window.openConfirmDeleteModal = function(title, message, onConfirm) {
  const modal = document.getElementById('confirmDeleteModal');
  const titleEl = document.getElementById('confirmDeleteTitle');
  const msgEl = document.getElementById('confirmDeleteMessage');
  const btnConfirm = document.getElementById('btnExecuteDeleteConfirm');

  if (!modal) return;
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;

  pendingDeleteAction = onConfirm;
  btnConfirm.onclick = async () => {
    btnConfirm.disabled = true;
    btnConfirm.innerHTML = '<span class="inline-block animate-spin mr-1">⟳</span> Excluindo...';
    try {
      if (pendingDeleteAction) await pendingDeleteAction();
    } catch (err) {
      alert(`Erro ao excluir: ${err.message}`);
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.innerText = 'Confirmar Exclusão';
      closeConfirmDeleteModal();
    }
  };

  modal.classList.remove('hidden');
  modal.classList.add('flex');
};

window.closeConfirmDeleteModal = function() {
  const modal = document.getElementById('confirmDeleteModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  pendingDeleteAction = null;
};

window.removeSingleVehicle = function(uniqueId) {
  const v = activeVehiclesMap.get(uniqueId);
  const name = v ? v.name : uniqueId;
  const isImported = v ? !!v.isImported : false;
  const creds = getTraccarCredentials();

  const title = isImported ? 'Remover Veículo Importado' : 'Excluir Veículo Sintético';
  const msg = isImported
    ? `O veículo "${name}" foi IMPORTADO do Traccar.\n\n⚠️ Esta ação removerá o veículo APENAS do simulador local.\n✅ Ele permanecerá INTACTO e preservado no seu servidor Traccar.`
    : `O veículo "${name}" é um dispositivo SINTÉTICO gerado pelo simulador.\n\n⚠️ Ele será excluído TANTO do simulador local quanto do servidor Traccar.`;

  openConfirmDeleteModal(
    title,
    msg,
    async () => {
      await fetch(`/api/simulation/vehicles/${uniqueId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traccarUrl: creds.url,
          traccarUser: creds.username,
          traccarPassword: creds.password
        })
      });

      // Atualização local imediata
      mapManager.removeVehicle(uniqueId);
      activeVehiclesMap.delete(uniqueId);
      selectedFleetVehicleIds.delete(uniqueId);
      if (followVehicleId === uniqueId) followVehicleId = '';
      if (selectedVehicleForModal === uniqueId) closeVehicleDetailModal();
      updateSystemKPIs();
      updateFleetBadge();
      updateFollowVehicleSelect();
      renderFleetTab();
      updateFleetSelectionUI();
      renderHomeSidebarList();
    }
  );
};

window.confirmDeleteSelectedVehicles = function() {
  const count = selectedFleetVehicleIds.size;
  if (count === 0) return;
  const creds = getTraccarCredentials();

  let fakesCount = 0;
  let importedCount = 0;
  selectedFleetVehicleIds.forEach(uid => {
    const v = activeVehiclesMap.get(uid);
    if (v && v.isImported) importedCount++;
    else fakesCount++;
  });

  let msg = `Tem certeza que deseja remover os ${count} veículos selecionados?`;
  if (fakesCount > 0 && importedCount > 0) {
    msg += `\n\n• ${fakesCount} veículos sintéticos serão removidos do simulador e do Traccar.\n• ${importedCount} veículos importados serão removidos APENAS do simulador (preservados no Traccar).`;
  } else if (importedCount > 0) {
    msg += `\n\n• Todos os ${importedCount} veículos selecionados são importados e serão removidos APENAS do simulador (preservados no Traccar).`;
  } else {
    msg += `\n\n• Todos os ${fakesCount} veículos selecionados são sintéticos e serão removidos de ambos (simulador e Traccar).`;
  }

  openConfirmDeleteModal(
    'Excluir Veículos em Lote',
    msg,
    async () => {
      const uids = Array.from(selectedFleetVehicleIds);
      await fetch('/api/simulation/vehicles/delete-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uniqueIds: uids,
          traccarUrl: creds.url,
          traccarUser: creds.username,
          traccarPassword: creds.password
        })
      });

      uids.forEach(uid => {
        mapManager.removeVehicle(uid);
        activeVehiclesMap.delete(uid);
      });
      selectedFleetVehicleIds.clear();
      closeVehicleDetailModal();
      updateSystemKPIs();
      updateFleetBadge();
      updateFollowVehicleSelect();
      renderFleetTab();
      updateFleetSelectionUI();
      renderHomeSidebarList();
    }
  );
};

window.confirmClearAllFleet = function() {
  if (activeVehiclesMap.size === 0) {
    alert('Nenhum veículo em circulação para remover.');
    return;
  }

  const creds = getTraccarCredentials();
  let fakesCount = 0;
  let importedCount = 0;
  activeVehiclesMap.forEach(v => {
    if (v.isImported) importedCount++;
    else fakesCount++;
  });

  let msg = `Tem certeza que deseja remover TODOS os ${activeVehiclesMap.size} veículos da simulação?`;
  if (fakesCount > 0 && importedCount > 0) {
    msg += `\n\n• ${fakesCount} veículos sintéticos serão removidos do simulador e do Traccar.\n• ${importedCount} veículos importados serão removidos APENAS do simulador (preservados no Traccar).`;
  } else if (importedCount > 0) {
    msg += `\n\n• Todos os ${importedCount} veículos são importados e serão removidos APENAS do simulador (preservados no Traccar).`;
  } else {
    msg += `\n\n• Todos os veículos sintéticos serão removidos do simulador e do Traccar.`;
  }

  openConfirmDeleteModal(
    'Limpar Toda a Frota',
    msg,
    async () => {
      await fetch('/api/simulation/vehicles', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traccarUrl: creds.url,
          traccarUser: creds.username,
          traccarPassword: creds.password
        })
      });
      mapManager.clearVehicles();
      activeVehiclesMap.clear();
      selectedFleetVehicleIds.clear();
      followVehicleId = '';
      closeVehicleDetailModal();
      updateSystemKPIs();
      updateFleetBadge();
      updateFollowVehicleSelect();
      renderFleetTab();
      updateFleetSelectionUI();
      renderHomeSidebarList();
    }
  );
};

// -------------------------------------------------------------
// Painel Lateral de Veículos na Home (Centro de Comando)
// -------------------------------------------------------------
let isHomeSidebarCollapsed = false;

window.toggleHomeSidebar = function() {
  const sidebar = document.getElementById('homeFleetSidebar');
  const btnFloating = document.getElementById('btnOpenSidebarFloating');
  if (!sidebar) return;

  isHomeSidebarCollapsed = !isHomeSidebarCollapsed;
  if (isHomeSidebarCollapsed) {
    sidebar.classList.add('hidden');
    if (btnFloating) btnFloating.classList.remove('hidden');
  } else {
    sidebar.classList.remove('hidden');
    if (btnFloating) btnFloating.classList.add('hidden');
  }

  // Recalcula tamanho do mapa para evitar corte visual
  setTimeout(() => {
    if (mapManager && mapManager.map) {
      mapManager.map.invalidateSize();
    }
  }, 250);
};

window.focusVehicle = function(uniqueId) {
  const v = activeVehiclesMap.get(uniqueId);
  if (!v) return;

  followVehicleId = uniqueId;

  // Atualiza select de seguir
  const select = document.getElementById('selectFollowVehicle');
  if (select) select.value = uniqueId;

  // Atualiza notice de foco na sidebar
  const notice = document.getElementById('homeFocusNotice');
  const nameEl = document.getElementById('homeFocusedVehicleName');
  if (notice && nameEl) {
    nameEl.innerText = v.name;
    notice.classList.remove('hidden');
    notice.classList.add('flex');
  }

  // Centraliza o mapa no veículo com zoom
  const vLat = v?.lat ?? v?.currentLat;
  const vLon = v?.lon ?? v?.currentLon;

  if (vLat && vLon && mapManager && mapManager.map) {
    mapManager.panTo(vLat, vLon, 16);
    const markerData = mapManager.vehicleMarkers.get(uniqueId);
    if (markerData && markerData.marker) {
      markerData.marker.openPopup();
    }
  }

  renderHomeSidebarList();
};

window.unfocusVehicle = function() {
  followVehicleId = '';

  // Atualiza select de seguir
  const select = document.getElementById('selectFollowVehicle');
  if (select) select.value = '';

  // Oculta notice de foco
  const notice = document.getElementById('homeFocusNotice');
  if (notice) {
    notice.classList.add('hidden');
    notice.classList.remove('flex');
  }

  // Fecha o painel de detalhes/cockpit
  closeVehicleDetailModal();

  // Fecha popups e enquadra todos os veículos no mapa
  if (mapManager && mapManager.map) {
    mapManager.map.closePopup();
  }
  mapManager.fitBoundsAll();

  renderHomeSidebarList();
};

window.handleSidebarCardClick = function(uniqueId) {
  if (followVehicleId === uniqueId) {
    unfocusVehicle();
  } else {
    focusVehicle(uniqueId);
    openVehicleDetailModal(uniqueId);
  }
};

function renderHomeSidebarList() {
  const container = document.getElementById('homeFleetListContainer');
  if (!container) return;

  const countBadge = document.getElementById('homeSidebarCountBadge');
  if (countBadge) {
    let fakes = 0;
    let imported = 0;
    activeVehiclesMap.forEach(v => {
      if (v.isImported) imported++;
      else fakes++;
    });
    countBadge.innerText = `${activeVehiclesMap.size} ativos (${fakes} ⚡ | ${imported} 📥)`;
  }

  const filterText = (document.getElementById('homeFilterVehicleSearch')?.value || '').toLowerCase();
  let vehicles = Array.from(activeVehiclesMap.values());

  if (filterText) {
    vehicles = vehicles.filter(v =>
      (v.name && v.name.toLowerCase().includes(filterText)) ||
      (v.plate && v.plate.toLowerCase().includes(filterText)) ||
      (v.uniqueId && v.uniqueId.toLowerCase().includes(filterText))
    );
  }

  if (vehicles.length === 0) {
    if (container.dataset.hasEmpty !== 'true') {
      container.innerHTML = `
        <div class="py-12 text-center text-slate-500 text-xs">
          ${activeVehiclesMap.size === 0 ? 'Nenhum veículo em circulação.' : 'Nenhum veículo encontrado para a busca.'}<br>
          <button onclick="switchTab('create')" class="text-sky-400 hover:underline mt-2 inline-block font-medium">
            Clique aqui para criar veículos
          </button>
        </div>
      `;
      container.dataset.hasEmpty = 'true';
    }
    return;
  }
  container.dataset.hasEmpty = 'false';

  const stateBadges = {
    'MOVING': '<span class="text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded text-[10px] font-semibold">Em Movimento</span>',
    'TRAFFIC_STOP': '<span class="text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded text-[10px] font-semibold">Parado</span>',
    'PARKED_OFF': '<span class="text-rose-400 bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 rounded text-[10px] font-semibold">Desligado</span>'
  };

  const stateIconStyles = {
    'MOVING': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
    'TRAFFIC_STOP': 'bg-amber-500/10 text-amber-400 border-amber-500/25',
    'PARKED_OFF': 'bg-rose-500/10 text-rose-400 border-rose-500/25'
  };

  function getSidebarPillsHtml(v) {
    let pills = '';
    if (v.engineBlocked) pills += '<span class="bg-rose-500/20 text-rose-300 border border-rose-500/40 px-1 py-0.2 rounded text-[9px] font-bold">BLOQ</span>';
    if (v.externalPowerCut) pills += '<span class="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1 py-0.2 rounded text-[9px] font-bold">0V</span>';
    if (v.shadowZone) pills += `<span class="bg-purple-500/20 text-purple-300 border border-purple-500/40 px-1 py-0.2 rounded text-[9px] font-bold animate-pulse">SOMBRA</span>`;
    if (v.towingSim) pills += '<span class="bg-orange-500/20 text-orange-300 border border-orange-500/40 px-1 py-0.2 rounded text-[9px] font-bold">GUINCHO</span>';
    return pills;
  }

  const currentUids = new Set(vehicles.map(v => String(v.uniqueId)));

  // Remove cards that are no longer in the active list
  const existingCards = container.querySelectorAll('[data-sidebar-vehicle-id]');
  existingCards.forEach(card => {
    const uid = card.getAttribute('data-sidebar-vehicle-id');
    if (!currentUids.has(uid)) {
      card.remove();
    }
  });

  vehicles.forEach((v, index) => {
    const uid = String(v.uniqueId);
    const isFocused = followVehicleId === v.uniqueId;
    const iconStyle = stateIconStyles[v.state] || 'bg-slate-800 text-slate-300 border-slate-700';
    const stateBadgeHtml = stateBadges[v.state] || v.state;
    const specialPillsHtml = getSidebarPillsHtml(v);
    const pillsKey = `${v.engineBlocked ? 1 : 0}-${v.externalPowerCut ? 1 : 0}-${v.shadowZone ? 1 : 0}-${v.towingSim ? 1 : 0}`;

    let card = document.getElementById(`sidebar-card-${uid}`);

    if (!card) {
      card = document.createElement('div');
      card.id = `sidebar-card-${uid}`;
      card.setAttribute('data-sidebar-vehicle-id', uid);
      card.setAttribute('onclick', `handleSidebarCardClick('${uid}')`);
      card.className = `rounded-xl px-3 py-2.5 transition-all cursor-pointer shadow-sm select-none group border flex items-center justify-between gap-2.5 ${isFocused ? 'bg-sky-950/50 border-sky-400 ring-2 ring-sky-500/30' : 'bg-slate-950/70 border-slate-800/80 hover:border-slate-700 hover:bg-slate-900'}`;
      card.dataset.state = v.state;
      card.dataset.focused = String(isFocused);
      card.dataset.pills = pillsKey;
      card.dataset.isImported = String(!!v.isImported);

      card.innerHTML = `
        <!-- Ícone do Carro com cor do estado + Identificação -->
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="sidebar-card-icon w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${iconStyle}">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>
          </div>
          <div class="min-w-0">
            <div class="sidebar-card-name font-bold text-xs ${isFocused ? 'text-sky-300' : 'text-white'} group-hover:text-sky-400 transition-colors truncate flex items-center gap-1.5">
              <span>${v.isImported ? '📥' : '⚡'}</span>
              <span class="truncate">${v.name}</span>
            </div>
            <div class="text-[10px] text-slate-400 font-mono truncate">
              ID: ${v.uniqueId}
            </div>
          </div>
        </div>

        <!-- Estado Atual & Remoção -->
        <div class="shrink-0 flex items-center gap-1.5">
          <div class="sidebar-card-pills flex items-center gap-1.5">${specialPillsHtml}</div>
          <div class="sidebar-card-state">${stateBadgeHtml}</div>
          <button onclick="event.stopPropagation(); removeSingleVehicle('${v.uniqueId}')" title="Remover Veículo" class="p-1 rounded-md text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      `;
      container.appendChild(card);
    } else {
      // O card já existe: NÃO recriar nós para manter :hover totalmente estável e sem piscar
      if (card.dataset.focused !== String(isFocused)) {
        card.dataset.focused = String(isFocused);
        if (isFocused) {
          card.classList.remove('bg-slate-950/70', 'border-slate-800/80', 'hover:border-slate-700', 'hover:bg-slate-900');
          card.classList.add('bg-sky-950/50', 'border-sky-400', 'ring-2', 'ring-sky-500/30');
          const nameEl = card.querySelector('.sidebar-card-name');
          if (nameEl) {
            nameEl.classList.remove('text-white');
            nameEl.classList.add('text-sky-300');
          }
        } else {
          card.classList.remove('bg-sky-950/50', 'border-sky-400', 'ring-2', 'ring-sky-500/30');
          card.classList.add('bg-slate-950/70', 'border-slate-800/80', 'hover:border-slate-700', 'hover:bg-slate-900');
          const nameEl = card.querySelector('.sidebar-card-name');
          if (nameEl) {
            nameEl.classList.remove('text-sky-300');
            nameEl.classList.add('text-white');
          }
        }
      }

      if (card.dataset.isImported !== String(!!v.isImported)) {
        card.dataset.isImported = String(!!v.isImported);
        const nameEl = card.querySelector('.sidebar-card-name');
        if (nameEl) {
          nameEl.innerHTML = `<span>${v.isImported ? '📥' : '⚡'}</span> <span class="truncate">${v.name}</span>`;
        }
      }

      if (card.dataset.state !== v.state) {
        card.dataset.state = v.state;
        const iconEl = card.querySelector('.sidebar-card-icon');
        if (iconEl) {
          iconEl.className = `sidebar-card-icon w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${iconStyle}`;
        }
        const stateEl = card.querySelector('.sidebar-card-state');
        if (stateEl) {
          stateEl.innerHTML = stateBadgeHtml;
        }
      }

      if (card.dataset.pills !== pillsKey) {
        card.dataset.pills = pillsKey;
        const pillsEl = card.querySelector('.sidebar-card-pills');
        if (pillsEl) {
          pillsEl.innerHTML = specialPillsHtml;
        }
      }

      if (container.children[index] !== card) {
        container.insertBefore(card, container.children[index] || null);
      }
    }
  });
}


