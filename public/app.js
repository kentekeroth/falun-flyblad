// ─── State ────────────────────────────────────────────────────────────────────
let userName = null;
let currentRoundId = null;
let myColor = '#888';
const completions = new Map();   // wayId → { volunteer_name, marked_at }
const volunteerColors = new Map(); // name → color
let totalStreets = 0;

let map = null;
const layerByWayId = new Map();

const REFRESH_MS = 30_000;
const POSTAL_COLOR = '#0277bd';

// ─── Municipality boundary ────────────────────────────────────────────────────

async function loadBoundary() {
  try {
    const res = await fetch('/api/boundary');
    if (!res.ok) { console.warn('Boundary API error', res.status); return; }
    const geojson = await res.json();
    if (!geojson.features?.length) { console.warn('Boundary: inga segment'); return; }
    console.log('Boundary:', geojson.features.length, 'segment');
    L.geoJSON(geojson, {
      style: () => ({
        color: '#1a5c34',
        weight: 4,
        opacity: 1,
        dashArray: '12 6',
        fill: false,
        interactive: false,
      }),
    }).addTo(map);
  } catch (e) { console.error('Boundary load failed:', e); }
}

// ─── Postal code reference layer ─────────────────────────────────────────────
let postalRefLayer = null;

async function loadPostalRefLayer() {
  if (postalRefLayer) return;
  try {
    const res = await fetch('/api/postalcodes');
    if (!res.ok) return;
    const geojson = await res.json();
    postalRefLayer = L.geoJSON(geojson, {
      pointToLayer(feature, latlng) {
        return L.marker(latlng, {
          icon: L.divIcon({
            className: 'postal-label',
            html: `<span>${feature.properties.postalCode}</span>`,
            iconSize: null,
          }),
          interactive: false,
        });
      },
    });
  } catch {}
}

function showPostalRefLayer() {
  if (postalRefLayer) postalRefLayer.addTo(map);
}

function hidePostalRefLayer() {
  if (postalRefLayer) map.removeLayer(postalRefLayer);
}

// ─── Draw state ───────────────────────────────────────────────────────────────
let drawActive = false;
const drawPoints = [];   // [[lat, lng], ...]
let drawPolyline = null;
let drawPolygon  = null;

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  userName = localStorage.getItem('flyblad-user');
  if (!userName) {
    document.getElementById('login-overlay').style.display = 'flex';
    return;
  }
  startApp();
}

async function startApp() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('user-label').textContent = userName;
  initMap();
  await Promise.all([loadRounds(), loadStreets(), loadPostalRefLayer(), loadBoundary()]);
  setInterval(refreshCompletions, REFRESH_MS);
}

// ─── Login / logout ───────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = document.getElementById('name-input').value.trim();
  if (!name) return;
  localStorage.setItem('flyblad-user', name);
  userName = name;
  startApp();
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('flyblad-user');
  location.reload();
});

// ─── Map ──────────────────────────────────────────────────────────────────────
function initMap() {
  map = L.map('map').setView([60.6066, 15.6355], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
}

async function loadStreets() {
  setStatus('Hämtar gator från OpenStreetMap…');
  try {
    const res = await fetch('/api/streets');
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error ?? `HTTP ${res.status}`);
    }
    const geojson = await res.json();

    // Visual layer — non-interactive, used only for styling
    L.geoJSON(geojson, {
      style: f => streetStyle(f.properties.id),
      interactive: false,
      onEachFeature(feature, layer) {
        layerByWayId.set(feature.properties.id, layer);
      },
    }).addTo(map);

    // Hit-target layer — wide transparent lines for easy finger tapping on mobile
    L.geoJSON(geojson, {
      style: () => ({ weight: 20, opacity: 0, color: '#000' }),
      onEachFeature(feature, layer) {
        if (feature.properties.name) {
          layer.bindTooltip(feature.properties.name, {
            sticky: true,
            className: 'street-tip',
          });
        }
        layer.on('click', e => {
          if (drawActive) return;
          L.DomEvent.stopPropagation(e);
          handleStreetClick(e, feature);
        });
      },
    }).addTo(map);

    totalStreets = geojson.features.length;
    setStatus('');
    updateProgress();
  } catch (err) {
    setStatus('Fel: ' + err.message);
  }
}

function streetStyle(wayId) {
  const comp = completions.get(wayId);
  if (!comp) return { color: '#bbb', weight: 3, opacity: 0.55, interactive: true };
  if (comp.source === 'postal') {
    return { color: POSTAL_COLOR, weight: 5, opacity: 0.9, dashArray: '10 5', interactive: true };
  }
  const color = volunteerColors.get(comp.volunteer_name) ?? '#888';
  return { color, weight: 6, opacity: 1, interactive: true };
}

function refreshStreetStyles() {
  layerByWayId.forEach((layer, wayId) => layer.setStyle(streetStyle(wayId)));
}

async function handleStreetClick(e, feature) {
  if (!currentRoundId) {
    setStatus('Välj eller skapa en omgång ovan först.', 3000);
    return;
  }

  const wayId = feature.properties.id;
  const comp = completions.get(wayId);

  if (!comp) {
    await markStreet(wayId);
    return;
  }

  const streetName = feature.properties.name || 'Okänd gata';
  const dt = new Date(comp.marked_at);
  const formatted = dt.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
  const isPostal = comp.source === 'postal';
  const byLine = isPostal
    ? `<span style="color:${POSTAL_COLOR};font-weight:600">Postutdelat</span> av <b>${comp.volunteer_name}</b>`
    : `Markerad av <b>${comp.volunteer_name}</b>`;
  const unmarkBtn = comp.volunteer_name === userName
    ? `<br><button class="popup-unmark-btn" onclick="popupUnmark('${wayId}')">Avmarkera</button>`
    : '';

  L.popup()
    .setLatLng(e.latlng)
    .setContent(`<b>${streetName}</b><br>${byLine}<br>${formatted}${unmarkBtn}`)
    .openOn(map);
}

async function popupUnmark(wayId) {
  map.closePopup();
  await unmarkStreet(wayId);
}

// ─── Postal / draw-area marking ───────────────────────────────────────────────

function pointInPolygon(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function getStreetsInRing(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const ids = [];
  layerByWayId.forEach((layer, wayId) => {
    const lls = layer.getLatLngs();
    if (!lls.length) return;
    const mid = lls[Math.floor(lls.length / 2)];
    const x = mid.lng, y = mid.lat;
    if (x < minX || x > maxX || y < minY || y > maxY) return;
    if (pointInPolygon([x, y], ring)) ids.push(wayId);
  });
  return ids;
}

function startDraw() {
  drawActive = true;
  drawPoints.length = 0;
  if (drawPolyline) { map.removeLayer(drawPolyline); drawPolyline = null; }
  if (drawPolygon)  { map.removeLayer(drawPolygon);  drawPolygon  = null; }
  map.getContainer().style.cursor = 'crosshair';
  map.doubleClickZoom.disable();
  map.on('click', drawAddPoint);
  map.on('dblclick', drawFinish);
  showPostalRefLayer();
  document.getElementById('post-btn').classList.add('active');
  document.getElementById('draw-panel').hidden = false;
  document.getElementById('draw-hint').textContent = 'Klicka på kartan för att rita område. Dubbelklicka för att avsluta.';
  document.getElementById('draw-finish-btn').disabled = true;
  document.getElementById('draw-confirm-btn').hidden = true;
}

function drawAddPoint(e) {
  drawPoints.push([e.latlng.lat, e.latlng.lng]);
  if (drawPolyline) map.removeLayer(drawPolyline);
  if (drawPoints.length >= 2) {
    drawPolyline = L.polyline([...drawPoints, drawPoints[0]], {
      color: POSTAL_COLOR, weight: 2, dashArray: '6 4',
    }).addTo(map);
  }
  document.getElementById('draw-finish-btn').disabled = drawPoints.length < 3;
}

function drawFinish(e) {
  if (!e._synth) L.DomEvent.stop(e);
  map.off('click', drawAddPoint);
  map.off('dblclick', drawFinish);
  map.getContainer().style.cursor = '';
  map.doubleClickZoom.enable();
  drawActive = false;
  if (drawPoints.length < 3) { cancelDraw(); return; }

  if (drawPolyline) { map.removeLayer(drawPolyline); drawPolyline = null; }
  // Remove last duplicate point from double-click (not from button)
  if (!e._synth) drawPoints.pop();
  if (drawPoints.length < 3) { cancelDraw(); return; }

  drawPolygon = L.polygon(drawPoints, { color: POSTAL_COLOR, weight: 2, fillOpacity: 0.15 }).addTo(map);

  const ring = drawPoints.map(([lat, lng]) => [lng, lat]);
  const inside = getStreetsInRing(ring);
  const unmarked = inside.filter(id => !completions.has(id));

  document.getElementById('draw-hint').textContent =
    `${inside.length} gator inom området (${unmarked.length} omärkta).`;
  document.getElementById('draw-finish-btn').hidden = true;
  document.getElementById('draw-confirm-btn').hidden = false;
  document.getElementById('draw-confirm-btn').disabled = unmarked.length === 0;
  document.getElementById('draw-confirm-btn').dataset.wayids = JSON.stringify(unmarked);
}

async function drawConfirm() {
  if (!currentRoundId) { setStatus('Välj en omgång först.', 3000); return; }
  const btn = document.getElementById('draw-confirm-btn');
  const wayIds = JSON.parse(btn.dataset.wayids || '[]');
  if (!wayIds.length) return;

  btn.disabled = true;
  btn.textContent = 'Markerar…';

  const res = await fetch(`/api/rounds/${currentRoundId}/completions/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wayIds, volunteerName: userName, source: 'postal' }),
  });

  if (res.ok) {
    const { added } = await res.json();
    const now = new Date().toISOString();
    wayIds.forEach(id => {
      completions.set(id, { volunteer_name: userName, marked_at: now, source: 'postal' });
      layerByWayId.get(id)?.setStyle(streetStyle(id));
    });
    updateProgress();
    setStatus(`${added} gator markerade som postutdelade.`, 4000);
  } else {
    setStatus('Kunde inte markera gator.', 3000);
  }
  cancelDraw();
}

function drawFinishBtn() {
  map.off('click', drawAddPoint);
  map.off('dblclick', drawFinish);
  drawFinish({ preventDefault() {}, stopPropagation() {}, latlng: null, _synth: true });
}

function cancelDraw() {
  drawActive = false;
  drawPoints.length = 0;
  map.off('click', drawAddPoint);
  map.off('dblclick', drawFinish);
  map.getContainer().style.cursor = '';
  map.doubleClickZoom.enable();
  if (drawPolyline) { map.removeLayer(drawPolyline); drawPolyline = null; }
  if (drawPolygon)  { map.removeLayer(drawPolygon);  drawPolygon  = null; }
  document.getElementById('draw-panel').hidden = true;
  document.getElementById('post-btn').classList.remove('active');
  hidePostalRefLayer();
  document.getElementById('draw-finish-btn').hidden = false;
  document.getElementById('draw-confirm-btn').hidden = true;
  document.getElementById('draw-finish-btn').disabled = true;
}

// ─── Completions API ──────────────────────────────────────────────────────────
async function markStreet(wayId) {
  const res = await fetch(`/api/rounds/${currentRoundId}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wayId, volunteerName: userName }),
  });
  if (!res.ok) {
    setStatus('Kunde inte spara markering — kontrollera anslutningen.', 4000);
    return;
  }
  completions.set(wayId, { volunteer_name: userName, marked_at: new Date().toISOString(), source: 'manual' });
  layerByWayId.get(wayId)?.setStyle(streetStyle(wayId));
  updateProgress();
}

async function unmarkStreet(wayId) {
  const res = await fetch(
    `/api/rounds/${currentRoundId}/completions/${wayId}?volunteer=${encodeURIComponent(userName)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) return;
  completions.delete(wayId);
  layerByWayId.get(wayId)?.setStyle(streetStyle(wayId));
  updateProgress();
}

async function refreshCompletions() {
  if (!currentRoundId) return;
  try {
    const res = await fetch(`/api/rounds/${currentRoundId}/completions`);
    if (!res.ok) return;
    const data = await res.json();

    completions.clear();
    data.completions.forEach(c => completions.set(c.way_id, c));

    volunteerColors.clear();
    data.volunteers.forEach(v => {
      volunteerColors.set(v.name, v.color);
      if (v.name === userName) {
        myColor = v.color;
        renderMyDot();
      }
    });

    if (data.totalStreets) totalStreets = data.totalStreets;
    refreshStreetStyles();
    updateProgress();
  } catch {}
}

// ─── Rounds ───────────────────────────────────────────────────────────────────
async function loadRounds() {
  const res = await fetch('/api/rounds');
  const rounds = await res.json();
  const select = document.getElementById('round-select');
  select.innerHTML = '<option value="">— Välj omgång —</option>';
  rounds.forEach(r => addRoundOption(r));
  if (rounds.length === 1) {
    select.value = String(rounds[0].id);
    await selectRound(rounds[0].id);
  }
}

function addRoundOption({ id, name }) {
  const opt = document.createElement('option');
  opt.value = String(id);
  opt.textContent = name;
  document.getElementById('round-select').appendChild(opt);
}

document.getElementById('round-select').addEventListener('change', async e => {
  const id = Number(e.target.value);
  if (id) await selectRound(id);
});

document.getElementById('new-round-btn').addEventListener('click', async () => {
  const name = prompt('Namn på omgången (t.ex. "Maj 2026"):');
  if (!name?.trim()) return;
  const res = await fetch('/api/rounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    setStatus(error ?? 'Kunde inte skapa omgång', 4000);
    return;
  }
  const round = await res.json();
  addRoundOption(round);
  document.getElementById('round-select').value = String(round.id);
  await selectRound(round.id);
});

document.getElementById('refresh-btn').addEventListener('click', refreshCompletions);
document.getElementById('post-btn').addEventListener('click', startDraw);

async function selectRound(roundId) {
  currentRoundId = roundId;
  completions.clear();
  volunteerColors.clear();

  const res = await fetch(`/api/rounds/${roundId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: userName }),
  });
  if (res.ok) {
    const data = await res.json();
    myColor = data.color;
    renderMyDot();
  }
  await refreshCompletions();
}

// ─── Progress ─────────────────────────────────────────────────────────────────
function updateProgress() {
  const done = completions.size;
  const total = totalStreets;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const postalDone = [...completions.values()].filter(c => c.source === 'postal').length;
  const manualDone = done - postalDone;
  const details = postalDone > 0
    ? ` (${manualDone} manuellt + ${postalDone} post)`
    : '';
  document.getElementById('progress-text').textContent =
    total > 0
      ? `${pct}% av Falun klart — ${done} av ${total} gator utdelade${details}`
      : 'Laddar gatadata…';

  // Count per volunteer
  const counts = new Map();
  completions.forEach(c => counts.set(c.volunteer_name, (counts.get(c.volunteer_name) ?? 0) + 1));

  // Stacked progress bar
  const bar = document.getElementById('progress-bar');
  bar.innerHTML = '';
  let usedPct = 0;
  counts.forEach((count, name) => {
    const color = volunteerColors.get(name) ?? '#888';
    const w = total > 0 ? (count / total) * 100 : 0;
    usedPct += w;
    const seg = document.createElement('div');
    seg.className = 'progress-segment';
    seg.style.cssText = `width:${w.toFixed(2)}%;background:${color};`;
    seg.title = `${name}: ${count} gator`;
    bar.appendChild(seg);
  });
  // Remainder
  const empty = document.createElement('div');
  empty.className = 'progress-empty';
  bar.appendChild(empty);

  // Legend
  const legend = document.getElementById('volunteer-legend');
  legend.innerHTML = '';
  counts.forEach((count, name) => {
    const color = volunteerColors.get(name) ?? '#888';
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML =
      `<span class="color-dot" style="background:${color}"></span>` +
      `${name} (${count})`;
    legend.appendChild(item);
  });
}

function renderMyDot() {
  const dot = document.getElementById('my-color-dot');
  dot.style.background = myColor;
  dot.style.display = 'inline-block';
  dot.style.marginLeft = '4px';
}

let _statusTimer = null;
function setStatus(msg, autoHideMs = 0) {
  document.getElementById('streets-status').textContent = msg;
  if (_statusTimer) clearTimeout(_statusTimer);
  if (autoHideMs > 0) _statusTimer = setTimeout(() => setStatus(''), autoHideMs);
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
