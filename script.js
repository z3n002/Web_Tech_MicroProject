
function el(id) { return document.getElementById(id); }
function nowStr() { return new Date().toLocaleTimeString(); }
function log(msg) {
    const box = el('logBox');
    const line = '[' + nowStr() + '] ' + msg;
    box.innerHTML = '<div>' + line + '</div>' + box.innerHTML;
}
function toast(msg, time = 3500) {
    const area = el('toastArea');
    const id = 't' + Date.now();
    const container = document.createElement('div');
    container.id = id;
    container.style.pointerEvents = 'auto';
    container.innerHTML = `<div class="toast show" role="alert" style="min-width:260px;">
      <div class="toast-header"><strong class="me-auto">Notice</strong><small>${nowStr()}</small><button type="button" class="btn-close ms-2" data-bs-dismiss="toast"></button></div>
      <div class="toast-body">${msg}</div></div>`;
    area.appendChild(container);
    const bsToast = new bootstrap.Toast(container.querySelector('.toast'), { delay: time, autohide: true });
    bsToast.show();
    setTimeout(() => { try { area.removeChild(container) } catch (e) { } }, time + 800);
}

const map = L.map('map', { preferCanvas: true }).setView([20.5937, 78.9629], 5);

const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: "OSM" });
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: "Esri" });
streets.addTo(map);

const routeLayer = L.layerGroup().addTo(map);
const truckLayer = L.layerGroup().addTo(map);

const STATE = {
    trucks: {},
    routes: {},
    assignments: {},
    routeBeingBuilt: null,
    simSpeed: 1,
    animHandles: {},
    charts: {},
    simRunning: true,
    electedTruckId: null,
    selectedTruckId: null
};

function stopSimulation() {
    STATE.simRunning = false;

    for (const k in STATE.animHandles) {
        try { if (STATE.animHandles[k]) cancelAnimationFrame(STATE.animHandles[k]); } catch (e) { }
        STATE.animHandles[k] = null;
    }
    const btn = el('btnStopSim');
    if (btn) btn.innerText = 'Resume Sim';
    toast('Simulation paused', 1200);
}

function startSimulation() {
    STATE.simRunning = true;
    const btn = el('btnStopSim');
    if (btn) btn.innerText = 'Pause Sim';

    for (const id in STATE.trucks) {
        if (STATE.trucks[id].routeProgress && !STATE.animHandles[id]) animateTruck(id);
    }
    toast('Simulation resumed', 1200);
}

const stopBtn = el('btnStopSim');
if (stopBtn) stopBtn.addEventListener('click', () => {
    if (STATE.simRunning) stopSimulation(); else startSimulation();
});

function truckIcon(color = '#ff8c00') {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>
      <rect x='2' y='14' width='36' height='30' rx='3' fill='${color}' stroke='#2b2b2b'/>
      <rect x='36' y='22' width='18' height='14' rx='2' fill='${color}' stroke='#2b2b2b'/>
      <circle cx='16' cy='48' r='4' fill='#222'/><circle cx='46' cy='48' r='4' fill='#222'/></svg>`;
    return L.icon({ iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), iconSize: [44, 32], iconAnchor: [22, 16], popupAnchor: [0, -12] });
}


function toRad(v) { return v * Math.PI / 180; } //Haversine formula
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function simulateSegmentTraffic() {
    const r = Math.random();
    return r < 0.6 ? 'Clear' : (r < 0.9 ? 'Moderate' : 'Heavy');
}
function colorForTraffic(s) { return s === 'Clear' ? 'lime' : (s === 'Moderate' ? 'gold' : 'orangered'); }

function addTruck(id = null, latlng = null, type = 'truck') {
    const truckId = id || ('TRK-' + Math.floor(1000 + Math.random() * 9000));
    const pos = latlng || [20.5937 + (Math.random() - 0.5) * 5, 78.9 + (Math.random() - 0.5) * 8];
    const color = type === 'drone' ? '#00bcd4' : '#ff8c00';
    const icon = type === 'drone' ? droneIcon : truckIcon(color);
    const marker = L.marker(pos, { icon, rotationAngle: 0, title: truckId }).addTo(truckLayer);
    marker.bindPopup(`<b>${truckId}</b><div id="popup-${truckId}"></div>`);
    STATE.trucks[truckId] = {
        id: truckId,
        type,
        marker,
        latlng: [pos[0], pos[1]],
        status: 'Idle',
        speed: type === 'drone' ? 0.0012 : 0.0007,
        routeProgress: null,
        lastUpdated: new Date().toISOString()
    };
    renderTruckList();
    updateCounts();
    log(`Truck ${truckId} added`);
    return truckId;
}

function removeTruck(id) {
    const t = STATE.trucks[id];
    if (!t) return;
    truckLayer.removeLayer(t.marker);
    delete STATE.trucks[id];
    renderTruckList();
    updateCounts();
    log(`Truck ${id} removed`);
}


window.zoomToTruck = function (id) {
    const t = STATE.trucks[id];
    if (!t) return;
    map.setView(t.marker.getLatLng(), 12, { animate: true });
    t.marker.openPopup();
};

function startRouteBuild() {
    STATE.routeBeingBuilt = { id: 'R-' + Date.now(), points: [], polyline: null, segmentTraffic: [], segmentLayers: [] };
    toast('Route creation started — click map to add points');
    log('Route creation started');
}
function cancelRouteBuild() {
    if (!STATE.routeBeingBuilt) { toast('No route in progress'); return; }
    if (STATE.routeBeingBuilt.polyline) routeLayer.removeLayer(STATE.routeBeingBuilt.polyline);
    STATE.routeBeingBuilt = null;
    toast('Route creation canceled');
    log('Route creation canceled');
}
function addPointToRoute(latlng) {
    if (!STATE.routeBeingBuilt) { toast('Click "Start" to create a route'); return; }
    STATE.routeBeingBuilt.points.push([latlng.lat, latlng.lng]);
    if (STATE.routeBeingBuilt.polyline) routeLayer.removeLayer(STATE.routeBeingBuilt.polyline);
    STATE.routeBeingBuilt.polyline = L.polyline(STATE.routeBeingBuilt.points, { color: '#00aaff', weight: 4, dashArray: '6 6' }).addTo(routeLayer);
}
function finishRouteBuild() {
    const r = STATE.routeBeingBuilt;
    if (!r || r.points.length < 2) { toast('Route needs at least 2 points'); return; }
    r.segmentTraffic = [];
    for (let i = 0; i < r.points.length - 1; i++) r.segmentTraffic.push(simulateSegmentTraffic());
    if (r.segmentLayers) r.segmentLayers.forEach(l => routeLayer.removeLayer(l));
    r.segmentLayers = [];
    for (let i = 0; i < r.points.length - 1; i++) {
        const p = [r.points[i], r.points[i + 1]];
        const col = colorForTraffic(r.segmentTraffic[i]);
        const seg = L.polyline(p, { color: col, weight: 6, opacity: 0.9 }).addTo(routeLayer);
        r.segmentLayers.push(seg);
    }
    STATE.routes[r.id] = r;
    STATE.routeBeingBuilt = null;
    renderRoutes();
    toast('Route saved: ' + r.id);
    log(`Route ${r.id} created with ${r.points.length} points`);
}

function renderRoutes() {
    const container = el('routesList');
    container.innerHTML = '';
    for (const id in STATE.routes) {
        const r = STATE.routes[id];
        const div = document.createElement('div');
        div.style.display = 'flex';
        div.style.justifyContent = 'space-between';
        div.style.alignItems = 'center';
        div.style.padding = '8px';
        div.style.border = '1px dashed rgba(0,0,0,0.06)';
        div.style.borderRadius = '8px';
        div.style.marginBottom = '8px';
        div.innerHTML = `<div><strong>${id}</strong><div class="muted-small">${r.points.length} pts</div></div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="btn btn-sm btn-outline-primary" onclick="previewRoute('${id}')">Preview</button>
          <button class="btn btn-sm btn-primary" onclick="assignRoutePromptToTruck('${id}')">Assign</button>
          <button class="btn btn-sm btn-outline-danger" title="Remove route" onclick="if(confirm('Delete route ${id}?')) removeRoute('${id}')">−</button>
        </div>`;
        container.appendChild(div);
    }
}

function removeRoute(routeId) {
    const r = STATE.routes[routeId];
    if (!r) return;

    if (r.segmentLayers) r.segmentLayers.forEach(l => routeLayer.removeLayer(l));
    if (r.polyline) routeLayer.removeLayer(r.polyline);

    for (const tid in STATE.trucks) {
        if (STATE.assignments[tid] === routeId) delete STATE.assignments[tid];
        const t = STATE.trucks[tid];
        if (t.routeProgress && t.routeProgress.routeId === routeId) t.routeProgress = null;
        if (t.status === 'Assigned' || t.status === 'In Transit') t.status = 'Idle';
    }
    delete STATE.routes[routeId];
    renderRoutes();
    renderTruckList();
    toast(`Route ${routeId} removed`);
    log(`Route ${routeId} removed`);
}

window.previewRoute = function (routeId) {
    const r = STATE.routes[routeId];
    if (!r) return;
    map.fitBounds(r.points);
    r.segmentLayers.forEach((s, i) => {
        s.setStyle({ opacity: 1.0 });
        setTimeout(() => s.setStyle({ opacity: 0.9 }), 700 + i * 60);
    });
};

window.assignRoutePrompt = function (truckId) {
    const routeIds = Object.keys(STATE.routes);
    if (routeIds.length === 0) { toast('No routes available'); return; }
    const pick = prompt(`Assign route to ${truckId}\nEnter route id:\n${routeIds.join('\n')}`);
    if (!pick) return;
    if (!STATE.routes[pick]) { toast('Invalid route'); return; }
    assignRouteToTruck(truckId, pick);
};

window.assignRoutePromptToTruck = function (routeId) {
    const truckIds = Object.keys(STATE.trucks);
    if (truckIds.length === 0) { toast('No trucks available'); return; }
    const pick = prompt(`Assign ${routeId} to truck id:\n${truckIds.join('\n')}`);
    if (!pick) return;
    if (!STATE.trucks[pick]) { toast('Invalid truck'); return; }
    assignRouteToTruck(pick, routeId);
};

function assignRouteToTruck(truckId, routeId) {
    const truck = STATE.trucks[truckId];
    const route = STATE.routes[routeId];
    if (!truck || !route) { toast('Invalid truck or route'); return; }
    STATE.assignments[truckId] = routeId;
    truck.status = 'Assigned';
    truck.routeProgress = { routeId, idx: 0, t: 0 };
    truck.marker.setLatLng(route.points[0]);
    log(`Assigned ${routeId} to ${truckId}`);
    renderTruckList();
    if (!STATE.animHandles[truckId]) animateTruck(truckId);
}

function animateTruck(truckId) {
    const truck = STATE.trucks[truckId];
    if (!truck) return;
    if (!STATE.simRunning) { STATE.animHandles[truckId] = null; return; }
    const routeId = STATE.assignments[truckId];
    if (!routeId) { STATE.animHandles[truckId] = null; return; }
    const route = STATE.routes[routeId];
    if (!route) { delete STATE.assignments[truckId]; return; }

    let last = performance.now();

    function step(ts) {
        if (!STATE.simRunning) { STATE.animHandles[truckId] = null; return; }
        const dt = (ts - last) / 1000;
        last = ts;
        const prog = truck.routeProgress;
        if (!prog) { STATE.animHandles[truckId] = null; return; }
        const segIdx = prog.idx;
        const segT = prog.t;
        const segTraffic = route.segmentTraffic[segIdx] || 'Clear';
        const trafficFactor = segTraffic === 'Clear' ? 1 : (segTraffic === 'Moderate' ? 0.6 : 0.35);

        const weatherFactor = getWeatherDelayFactorForSegment(route, segIdx);

        const speedSlider = parseFloat(el('simSpeed').value) || 1.0;

        const effective = truck.speed * speedSlider * trafficFactor * (1 / weatherFactor) * STATE.simSpeed;

        let newT = segT + effective * dt * 45;

        let newIdx = segIdx;
        if (newT >= 1) {
            newT = 0;
            newIdx = segIdx + 1;
            if (newIdx >= route.points.length - 1) {
                truck.status = 'Delivered';
                truck.marker.setLatLng(route.points[route.points.length - 1]);
                truck.routeProgress = null;
                setTimeout(() => {
                    truck.status = 'Idle';
                    renderTruckList();
                }, 2000 + Math.random() * 2000);
                renderTruckList();
                STATE.animHandles[truckId] = requestAnimationFrame(step);
                return;
            }
        }

        const a = route.points[newIdx];
        const b = route.points[newIdx + 1];
        const lat = a[0] + (b[0] - a[0]) * newT;
        const lng = a[1] + (b[1] - a[1]) * newT;
        truck.marker.setLatLng([lat, lng]);
        truck.latlng = [lat, lng];
        truck.lastUpdated = new Date().toISOString();

        const popupEl = document.getElementById('popup-' + truck.id);
        if (popupEl) {
            popupEl.innerHTML = `Route: ${routeId}<br>Traffic: ${segTraffic} • ETA: ${calcETA(route, newIdx, newT)}`;
        }

        truck.routeProgress = { routeId, idx: newIdx, t: newT };
        truck.status = 'In Transit';

        renderTruckList();

        STATE.animHandles[truckId] = requestAnimationFrame(step);
    }

    if (!STATE.animHandles[truckId]) STATE.animHandles[truckId] = requestAnimationFrame(step);
}

function calcETA(route, idx, t) {
    const baseKmPerMin = 30 / 60;
    let totalKm = 0;
    for (let i = idx; i < route.points.length - 1; i++) {
        const a = route.points[i], b = route.points[i + 1];
        const d = haversineKm(a[0], a[1], b[0], b[1]);
        if (i === idx) totalKm += d * (1 - t);
        else totalKm += d;
    }
    let avgFactor = 1.0;
    for (let i = idx; i < route.segmentTraffic.length; i++) {
        const s = route.segmentTraffic[i];
        const f = s === 'Clear' ? 1.0 : (s === 'Moderate' ? 0.7 : 0.45);
        avgFactor = (avgFactor + f) / 2;
    }
    let avgWeather = 1.0;
    for (let i = idx; i < route.segmentTraffic.length; i++) {
        avgWeather = (avgWeather + getWeatherDelayFactorForSegment(route, i)) / 2;
    }
    const estMin = Math.round((totalKm / (baseKmPerMin * avgFactor)) * avgWeather);
    return estMin + ' min';
}

function getWeatherDelayFactorForSegment(route, idx) {
    const a = route.points[idx], b = route.points[idx + 1];
    const midLat = (a[0] + b[0]) / 2;
    const midLng = (a[1] + b[1]) / 2;
    const v = Math.abs(Math.sin(midLat * 12.9898 + midLng * 78.233) * 43758.5453) % 1;
    if (v < 0.6) return 1.0;
    if (v < 0.86) return 1.18;
    return 1.45;
}
setInterval(() => {
    if (!STATE.simRunning) return;
    for (const id in STATE.routes) {
        const r = STATE.routes[id];

        for (let i = 0; i < r.segmentTraffic.length; i++) {
            if (Math.random() < 0.12) {
                r.segmentTraffic[i] = simulateSegmentTraffic();
                r.segmentLayers[i].setStyle({ color: colorForTraffic(r.segmentTraffic[i]) });
            }
        }
    }
}, 10000);
el('startRoute').addEventListener('click', () => startRouteBuild());
el('cancelRoute').addEventListener('click', () => cancelRouteBuild());
el('finishRoute').addEventListener('click', () => finishRouteBuild());
el('addTruckBtn').addEventListener('click', () => {
    const id = el('newTruckId').value.trim() || null;
    addTruck(id);
    el('newTruckId').value = '';
    clusterRefresh();
});
el('btnStreets').addEventListener('click', () => { map.removeLayer(satellite); streets.addTo(map); });
el('btnSatellite').addEventListener('click', () => { map.removeLayer(streets); satellite.addTo(map); });

el('btnToggleLeft').addEventListener('click', () => {
    const lp = el('leftPanel');
    lp.classList.toggle('slide-in');
    lp.classList.toggle('side-hidden');
    document.body.classList.toggle('left-hidden', lp.classList.contains('side-hidden'));
    try { map.invalidateSize(); } catch (e) { /* map may not exist yet */ }
    setTimeout(() => { try { map.invalidateSize(); } catch (e) { } }, 380);
});

el('darkToggle').addEventListener('change', (e) => { document.body.classList.toggle('dark', e.target.checked); });

el('btnReset').addEventListener('click', () => {
    if (!confirm('Reset demo?')) return;
    for (const i in STATE.animHandles) { cancelAnimationFrame(STATE.animHandles[i]); }
    for (const id in STATE.trucks) truckLayer.removeLayer(STATE.trucks[id].marker);
    for (const r in STATE.routes) { if (STATE.routes[r].segmentLayers) STATE.routes[r].segmentLayers.forEach(l => routeLayer.removeLayer(l)); }
    STATE.trucks = {}; STATE.routes = {}; STATE.assignments = {}; STATE.animHandles = {};
    addDemoData();
    renderRoutes(); renderTruckList();
    toast('Demo reset');
    log('Demo reset');
});

el('searchBox').addEventListener('input', (e) => {
    const v = e.target.value.toLowerCase();
    el('filterTruck').value = v;
    renderTruckList();
});

el('filterTruck').addEventListener('input', () => renderTruckList());

el('simSpeed').addEventListener('input', () => { STATE.simSpeed = parseFloat(el('simSpeed').value); });

el('btnClear').addEventListener('click', () => {
    if (!confirm('Clear all routes?')) return;
    for (const id in STATE.routes) {
        const r = STATE.routes[id];
        if (r.segmentLayers) r.segmentLayers.forEach(l => routeLayer.removeLayer(l));
        if (r.polyline) routeLayer.removeLayer(r.polyline);
        delete STATE.routes[id];
    }
    renderRoutes();
    toast('All routes cleared');
});
map.on('click', (ev) => {
    if (STATE.routeBeingBuilt) addPointToRoute(ev.latlng);
    showGpsPulse(ev.containerPoint);
});
function showGpsPulse(point) {
    const elPulse = el('gpsPulse');
    elPulse.style.left = (point.x + 8) + 'px';
    elPulse.style.top = (point.y + 8) + 'px';
    elPulse.style.display = 'block';
    setTimeout(() => elPulse.style.display = 'none', 1100);
}
function assignRouteToTruck(truckId, routeId) {
    assignRouteToTruck = assignRouteToTruck;
}
const ctx = el('chartShipments').getContext('2d');
const shipmentsChart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: ['T-6', 'T-5', 'T-4', 'T-3', 'T-2', 'T-1', 'Now'],
        datasets: [{ label: 'Active', data: [2, 3, 4, 3, 5, 4, Object.keys(STATE.trucks).length], fill: true, tension: 0.4 }]
    },
    options: { responsive: true, plugins: { legend: { display: false } } }
});

function updateChart() {
    const ds = shipmentsChart.data.datasets[0];
    ds.data.shift();
    ds.data.push(Object.keys(STATE.trucks).length);
    shipmentsChart.update();

    if (STATE.selectedTruckId) {
        const t = STATE.trucks[STATE.selectedTruckId];
        if (!t) {
            STATE.selectedTruckId = null;
            el('avgEta').innerText = '—';
            return;
        }
        const routeId = (t.routeProgress && t.routeProgress.routeId) || STATE.assignments[STATE.selectedTruckId];
        const route = routeId ? STATE.routes[routeId] : null;
        if (route && (t.routeProgress || STATE.assignments[STATE.selectedTruckId])) {
            const idx = (t.routeProgress && t.routeProgress.idx) || 0;
            const tfrac = (t.routeProgress && t.routeProgress.t) || 0;
            el('avgEta').innerText = calcETA(route, idx, tfrac);
            return;
        } else {
            el('avgEta').innerText = '—';
            return;
        }
    }


    let totalMin = 0, count = 0;
    for (const rid in STATE.routes) {
        const r = STATE.routes[rid];
        const etaStr = calcETA(r, 0, 0);
        const etaNum = parseInt(etaStr, 10) || 0;
        totalMin += etaNum;
        count++;
    }
    el('avgEta').innerText = count ? Math.round(totalMin / count) + ' min' : '—';
}
setInterval(updateChart, 5000);



function renderTruckList() {
    const container = el('truckList');
    container.innerHTML = '';
    const filter = (el('filterTruck').value || '').toLowerCase();
    for (const id in STATE.trucks) {
        const t = STATE.trucks[id];
        if (filter && !(id.toLowerCase().includes(filter) || (t.status || '').toLowerCase().includes(filter))) continue;
        const card = document.createElement('div');
        card.className = 'truck-card';

        if (STATE.selectedTruckId === id) {
            card.style.boxShadow = '0 0 0 3px rgba(0,123,255,0.12)';
        } else {
            card.style.boxShadow = '';
        }

        card.innerHTML = `<div class="d-flex justify-content-between align-items-start">
        <div>
          <div class="truck-title">${id} <small class="muted-small">[${t.type}]</small></div>
          <div class="muted-small">${t.status} • Updated: ${new Date(t.lastUpdated).toLocaleTimeString()}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="btn btn-sm btn-outline-primary" onclick="zoomToTruck('${id}')" title="Zoom"><i class="fa fa-location-arrow"></i></button>
          <button class="btn btn-sm btn-success" onclick="assignRoutePrompt('${id}')" title="Assign Route"><i class="fa fa-route"></i></button>
          <button class="btn btn-sm btn-outline-danger" onclick="if(confirm('Remove truck ${id}?')) removeTruck('${id}')" title="Remove truck">−</button>
        </div>
      </div>`;

        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            STATE.selectedTruckId = id;

            const routeId = (t.routeProgress && t.routeProgress.routeId) || STATE.assignments[id];
            const route = routeId ? STATE.routes[routeId] : null;
            if (route) {
                const idx = (t.routeProgress && t.routeProgress.idx) || 0;
                const tfrac = (t.routeProgress && t.routeProgress.t) || 0;
                el('avgEta').innerText = calcETA(route, idx, tfrac);
            } else {
                el('avgEta').innerText = '—';
            }

            renderTruckList();
        });

        container.appendChild(card);
    }
    el('truckCount').innerText = Object.keys(STATE.trucks).length;
    el('liveCount').innerText = Object.keys(STATE.trucks).length;
}


function clusterRefresh() {
}
function addDemoData() {
    addTruck('TRK-1001', [19.0760, 72.8777]);
    addTruck('TRK-2002', [12.9716, 77.5946]);
    addTruck('TRK-3003', [13.0827, 80.2707]);
    renderTruckList();
    const pts = [[19.0760, 72.8777], [18.5204, 73.8567], [17.3850, 78.4867]];
    const r = { id: 'R-DEMO-1', points: pts, segmentTraffic: pts.slice(0, pts.length - 1).map(() => simulateSegmentTraffic()), segmentLayers: [] };

    for (let i = 0; i < pts.length - 1; i++) {
        const p = [pts[i], pts[i + 1]];
        const col = colorForTraffic(r.segmentTraffic[i]);
        const seg = L.polyline(p, { color: col, weight: 6, opacity: 0.9 }).addTo(routeLayer);
        r.segmentLayers.push(seg);
    }
    STATE.routes[r.id] = r;
}

addDemoData();
renderRoutes();
renderTruckList();


setInterval(() => {
    if (!STATE.simRunning) return;
    STATE.simSpeed = parseFloat(el('simSpeed').value) || 1.0;

    for (const id in STATE.trucks) {
        const truck = STATE.trucks[id];
        const assignment = STATE.assignments[id] || (truck.routeProgress ? truck.routeProgress.routeId : (truck.routeProgress ? truck.routeProgress.routeId : null));
        if (!assignment && !truck.routeProgress) continue;
        if (!truck.routeProgress) {
            if (STATE.assignments[id]) {
                truck.routeProgress = { routeId: STATE.assignments[id], idx: 0, t: 0 };
            } else continue;
        }
        if (!STATE.animHandles[id]) animateTruck(id);
    }

}, 1000);

setInterval(updateChart, 5000);


function updateSelectedETA() {
    if (!STATE.selectedTruckId) return;
    const t = STATE.trucks[STATE.selectedTruckId];
    if (!t) { STATE.selectedTruckId = null; el('avgEta').innerText = '—'; return; }
    const routeId = (t.routeProgress && t.routeProgress.routeId) || STATE.assignments[STATE.selectedTruckId];
    const route = routeId ? STATE.routes[routeId] : null;
    if (route) {
        const idx = (t.routeProgress && t.routeProgress.idx) || 0;
        const tfrac = (t.routeProgress && t.routeProgress.t) || 0;
        el('avgEta').innerText = calcETA(route, idx, tfrac);
    } else {
        el('avgEta').innerText = '—';
    }
}
setInterval(updateSelectedETA, 1000);

function assignRouteToTruck(truckId, routeId) {
    const truck = STATE.trucks[truckId];
    const route = STATE.routes[routeId];
    if (!truck || !route) { toast('Invalid truck or route'); return; }
    STATE.assignments[truckId] = routeId;
    truck.status = 'Assigned';
    truck.routeProgress = { routeId, idx: 0, t: 0 };
    truck.marker.setLatLng(route.points[0]);
    log(`Assigned route ${routeId} → ${truckId}`);
    renderTruckList();
    if (!STATE.animHandles[truckId]) animateTruck(truckId);
}

function updateCounts() { el('truckCount').innerText = Object.keys(STATE.trucks).length; el('liveCount').innerText = Object.keys(STATE.trucks).length; renderTruckList(); }

updateCounts();

el('leftPanel').classList.add('slide-in');

log('Advanced Logistics Tracker initialized.');

