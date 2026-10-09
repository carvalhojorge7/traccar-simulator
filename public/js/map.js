// Gerenciador do Mapa Leaflet com OpenStreetMap
class MapManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.map = null;
    this.vehicleMarkers = new Map();
    this.routePolylines = new Map();
    this.centerCircle = null;
    this.centerMarker = null;
    this.onCenterChangedCallback = null;

    // Cores para distinguir rotas
    this.routeColors = [
      '#38bdf8', '#4ade80', '#f43f5e', '#fbbf24', '#a855f7',
      '#2dd4bf', '#fb923c', '#e879f9', '#60a5fa', '#34d399'
    ];
  }

  init(initialLat = -23.5505, initialLon = -46.6333, zoom = 13) {
    this.map = L.map(this.containerId, {
      zoomControl: true
    }).setView([initialLat, initialLon], zoom);

    // Camada oficial e 100% gratuita do OpenStreetMap (sem necessidade de API key)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(this.map);

    // Evento de clique para escolher centro de geração de rotas
    this.map.on('click', (e) => {
      this.setCenterPoint(e.latlng.lat, e.latlng.lng);
      if (this.onCenterChangedCallback) {
        this.onCenterChangedCallback(e.latlng.lat, e.latlng.lng);
      }
    });

    this.setCenterPoint(initialLat, initialLon, 8);
  }

  onCenterChanged(callback) {
    this.onCenterChangedCallback = callback;
  }

  setCenterPoint(lat, lon, radiusKm = 8) {
    if (this.centerCircle) {
      this.map.removeLayer(this.centerCircle);
    }
    if (this.centerMarker) {
      this.map.removeLayer(this.centerMarker);
    }

    this.centerMarker = L.circleMarker([lat, lon], {
      radius: 6,
      fillColor: '#38bdf8',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.9
    }).addTo(this.map);

    this.centerCircle = L.circle([lat, lon], {
      radius: radiusKm * 1000,
      color: '#38bdf8',
      fillColor: '#38bdf8',
      fillOpacity: 0.08,
      weight: 1.5,
      dashArray: '5, 5'
    }).addTo(this.map);
  }

  updateRadius(radiusKm) {
    if (this.centerCircle) {
      this.centerCircle.setRadius(radiusKm * 1000);
    }
  }

  /**
   * Cria ou atualiza marcador de veículo com rotação de azimute
   */
  updateVehicleMarker(v) {
    const lat = v.lat ?? v.currentLat;
    const lon = v.lon ?? v.currentLon;
    const { uniqueId, name, bearing, state, ignition } = v;
    const speedKmh = Math.round(Number(v.speedKmh) || 0);

    if (!lat || !lon) return;

    let markerData = this.vehicleMarkers.get(uniqueId);

    // Cor do ícone baseada no status
    let iconColor = '#22c55e'; // verde (andando)
    if (state === 'TRAFFIC_STOP') iconColor = '#eab308'; // amarelo (parado)
    if (!ignition || state === 'PARKED_OFF') iconColor = '#ef4444'; // vermelho (desligado)

    const iconHtml = `
      <div class="vehicle-marker-container">
        <svg class="vehicle-icon" style="transform: rotate(${bearing || 0}deg);" width="32" height="32" viewBox="0 0 24 24" fill="${iconColor}" stroke="#ffffff" stroke-width="1.5">
          <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/>
        </svg>
        <div class="vehicle-label">${name.split(' - ')[1] || name} (${speedKmh} km/h)</div>
      </div>
    `;

    const customIcon = L.divIcon({
      html: iconHtml,
      className: 'custom-vehicle-div-icon',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const stateLabels = {
      'MOVING': 'Em Movimento',
      'TRAFFIC_STOP': 'Parado',
      'PARKED_OFF': 'Desligado'
    };
    const displayState = stateLabels[state] || state;

    const popupHtml = `
      <div class="text-slate-800 p-1">
        <div class="font-bold text-sm text-slate-900">${name}</div>
        <div class="text-xs text-slate-600">ID: ${uniqueId}</div>
        <div class="text-xs mt-1">Velocidade: <b>${speedKmh} km/h</b></div>
        <div class="text-xs">Ignição: <b>${ignition ? 'Ligada' : 'Desligada'}</b></div>
        <div class="text-xs">Status: <b>${displayState}</b></div>
      </div>
    `;

    if (!markerData) {
      const marker = L.marker([lat, lon], { icon: customIcon }).addTo(this.map);
      marker.bindPopup(popupHtml);
      this.vehicleMarkers.set(uniqueId, { marker });
    } else {
      markerData.marker.setLatLng([lat, lon]);
      markerData.marker.setIcon(customIcon);
      markerData.marker.setPopupContent(popupHtml);
    }
  }

  /**
   * Alias de conveniência para atualizar ou inserir marcador de veículo
   */
  upsertVehicle(v) {
    return this.updateVehicleMarker(v);
  }

  /**
   * Adiciona o traçado da rota no mapa
   */
  drawRoute(uniqueId, routePoints, index = 0) {
    if (!routePoints || routePoints.length === 0) return;

    if (this.routePolylines.has(uniqueId)) {
      this.map.removeLayer(this.routePolylines.get(uniqueId));
    }

    const latLngs = routePoints.map(p => [p.lat, p.lon]);
    const color = this.routeColors[index % this.routeColors.length];

    const polyline = L.polyline(latLngs, {
      color,
      weight: 3.5,
      opacity: 0.65,
      lineJoin: 'round'
    }).addTo(this.map);

    this.routePolylines.set(uniqueId, polyline);
  }

  removeVehicle(uniqueId) {
    if (this.vehicleMarkers.has(uniqueId)) {
      this.map.removeLayer(this.vehicleMarkers.get(uniqueId).marker);
      this.vehicleMarkers.delete(uniqueId);
    }
    if (this.routePolylines.has(uniqueId)) {
      this.map.removeLayer(this.routePolylines.get(uniqueId));
      this.routePolylines.delete(uniqueId);
    }
  }

  clearVehicles() {
    this.vehicleMarkers.forEach(data => this.map.removeLayer(data.marker));
    this.vehicleMarkers.clear();

    this.routePolylines.forEach(poly => this.map.removeLayer(poly));
    this.routePolylines.clear();
  }

  panTo(lat, lon, zoom = 15) {
    this.map.setView([lat, lon], zoom, { animate: true });
  }

  /**
   * Navegação suave e inteligente 'seguindo' o veículo (Deadband / Câmera Flutuante):
   * O veículo se desloca livremente na área central sem puxar o mapa bruscamente a cada segundo.
   * Quando ele se distancia mais de X pixels do centro (ou se aproxima das bordas), o mapa
   * desliza suavemente com easing contínuo para recentralizar o veículo.
   */
  smoothFollowVehicle(lat, lon, minZoom = 16) {
    if (!this.map || !lat || !lon) return;

    const currentZoom = this.map.getZoom();
    if (currentZoom < minZoom - 1) {
      // Se estava muito longe, aproxima com zoom
      this.panTo(lat, lon, minZoom);
      return;
    }

    const mapCenter = this.map.getCenter();
    const targetLatLng = L.latLng(lat, lon);

    // Converte para coordenadas de pixel na tela para calcular distância visual
    const centerPoint = this.map.latLngToContainerPoint(mapCenter);
    const vehiclePoint = this.map.latLngToContainerPoint(targetLatLng);

    const dx = vehiclePoint.x - centerPoint.x;
    const dy = vehiclePoint.y - centerPoint.y;
    const distancePx = Math.sqrt(dx * dx + dy * dy);

    // Margem de liberdade (Deadband): se o carro estiver dentro de um raio de 90px do centro,
    // o mapa NÃO se move, permitindo que o carro deslize suavemente na tela sem sacolejos.
    // Assim que ultrapassar esse raio (ou se afastar das margens), o mapa desliza suavemente até o carro.
    const deadbandRadiusPx = 90;

    if (distancePx > deadbandRadiusPx) {
      this.map.panTo(targetLatLng, {
        animate: true,
        duration: 1.5,
        easeLinearity: 0.25,
        noMoveStart: true
      });
    }
  }

  fitBoundsAll() {
    const markers = Array.from(this.vehicleMarkers.values()).map(m => m.marker.getLatLng());
    if (markers.length > 0) {
      this.map.fitBounds(L.latLngBounds(markers).pad(0.2));
    }
  }
}

window.MapManager = MapManager;
