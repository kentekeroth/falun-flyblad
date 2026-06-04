// ─── State ────────────────────────────────────────────────────────────────────
let userName = null;
let authToken = null;
let isSuperuser = false;
let currentRoundId = null;
let myColor = '#888';
const completions = new Map();   // wayId → { volunteer_name, marked_at }
const volunteerColors = new Map(); // name → color
const lengthByWayId = new Map();   // wayId → meters
const householdsByWayId = new Map(); // wayId → household_count
const SCORE_KM_FACTOR = 2.0; // poäng = hushåll × (1 + km × faktor)
let totalStreets = 0;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function authHeaders() {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

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
  authToken = localStorage.getItem('flyblad-token');
  isSuperuser = localStorage.getItem('flyblad-superuser') === '1';
  if (!userName || !authToken) {
    localStorage.removeItem('flyblad-user');
    localStorage.removeItem('flyblad-token');
    localStorage.removeItem('flyblad-superuser');
    userName = null; authToken = null; isSuperuser = false;
    document.getElementById('login-overlay').style.display = 'flex';
    loadExistingUsers();
    return;
  }
  startApp();
}

async function loadExistingUsers() {
  try {
    const [volRes, cfgRes] = await Promise.all([fetch('/api/volunteers'), fetch('/api/config')]);
    if (!volRes.ok) return;
    const names = await volRes.json();
    const { superuserName = '' } = cfgRes.ok ? await cfgRes.json() : {};
    if (!names.length) return;
    const list = document.getElementById('user-list');
    list.hidden = false;
    names.forEach(name => {
      if (name === superuserName) return; // superuser måste logga in via formuläret med PIN
      const chip = document.createElement('div');
      chip.className = 'user-chip';
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'user-chip-name';
      nameBtn.textContent = name;
      nameBtn.onclick = () => loginAsChip(name);
      chip.appendChild(nameBtn);
      list.appendChild(chip);
    });
    document.getElementById('login-desc').textContent = 'Välj ditt namn eller ange ett nytt nedan.';
    document.getElementById('name-input').placeholder = 'Nytt namn…';
    document.getElementById('name-input').removeAttribute('required');
  } catch {}
}

async function loginAsChip(name) {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin: '' }),
    });
    if (!res.ok) return;
    const { token, isSuperuser: superFlag } = await res.json();
    doLogin(name, token, superFlag);
  } catch {}
}

function doLogin(name, token, superFlag) {
  userName = name;
  authToken = token;
  isSuperuser = superFlag;
  localStorage.setItem('flyblad-user', name);
  localStorage.setItem('flyblad-token', token);
  localStorage.setItem('flyblad-superuser', superFlag ? '1' : '0');
  document.getElementById('login-overlay').style.display = 'none';
  startApp();
}

async function deleteUser(name, rowEl) {
  if (!confirm(`Ta bort "${name}"? Alla deras markeringar tas också bort.`)) return;
  try {
    const res = await fetch(`/api/volunteers/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (res.ok) rowEl.remove();
    else {
      const { error } = await res.json().catch(() => ({}));
      alert(error ?? 'Kunde inte ta bort användare');
    }
  } catch {}
}

async function startApp() {
  document.getElementById('login-overlay').style.display = 'none';
  document.getElementById('user-label').textContent = userName;
  setLeafletName(localStorage.getItem('lastLeafletName') || '');
  if (isSuperuser) {
    document.getElementById('admin-btn').hidden = false;
    document.getElementById('new-round-btn').hidden = false;
    document.getElementById('delete-round-btn').hidden = false;
    document.getElementById('user-label').textContent = userName + ' ★';
  }
  initMap();
  await Promise.all([loadRounds(), loadStreets(), loadPostalRefLayer(), loadBoundary(), loadWayMetadata()]);
  setInterval(refreshCompletions, REFRESH_MS);
}

// ─── Login / logout ───────────────────────────────────────────────────────────
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('name-input').value.trim();
  const pin = document.getElementById('pin-input').value;
  if (!name) return;
  const errEl = document.getElementById('login-error');
  errEl.hidden = true;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      errEl.textContent = error ?? 'Inloggning misslyckades';
      errEl.hidden = false;
      return;
    }
    const { token, isSuperuser: superFlag } = await res.json();
    doLogin(name, token, superFlag);
  } catch {
    errEl.textContent = 'Nätverksfel — försök igen';
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('flyblad-user');
  localStorage.removeItem('flyblad-token');
  localStorage.removeItem('flyblad-superuser');
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

    geojson.features.forEach(f => {
      const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
      let len = 0;
      for (const line of lines)
        for (let i = 1; i < line.length; i++)
          len += haversineMeters(line[i-1][1], line[i-1][0], line[i][1], line[i][0]);
      lengthByWayId.set(f.properties.id, len);
    });

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

async function loadWayMetadata() {
  try {
    const res = await fetch('/api/way-metadata');
    if (!res.ok) return;
    const data = await res.json();
    Object.entries(data).forEach(([id, count]) => householdsByWayId.set(id, count));
  } catch (_) {}
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
    await markStreet(wayId, localStorage.getItem('lastLeafletName') || '');
    return;
  }

  const streetName = feature.properties.name || 'Okänd gata';
  const dt = new Date(comp.marked_at);
  const formatted = dt.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
  const isPostal = comp.source === 'postal';
  const byLine = isPostal
    ? `<span style="color:${POSTAL_COLOR};font-weight:600">Postutdelat</span> av <b>${comp.volunteer_name}</b>`
    : `Markerad av <b>${comp.volunteer_name}</b>`;
  const leafletLine = comp.leaflet_name ? `<br>Flygblad: <i>${escapeHtml(comp.leaflet_name)}</i>` : '';
  const unmarkBtn = (comp.volunteer_name === userName || isSuperuser)
    ? `<br><button class="popup-unmark-btn" data-wayid="${wayId}" data-volunteer="${escapeAttr(comp.volunteer_name)}" onclick="popupUnmark(this)">Avmarkera</button>`
    : '';

  L.popup()
    .setLatLng(e.latlng)
    .setContent(`<b>${streetName}</b><br>${byLine}<br>${formatted}${leafletLine}${unmarkBtn}`)
    .openOn(map);
}

function setLeafletName(name) {
  if (name) localStorage.setItem('lastLeafletName', name);
  else localStorage.removeItem('lastLeafletName');
  const display = document.getElementById('leaflet-display');
  const btn = document.getElementById('leaflet-edit-btn');
  if (display) display.textContent = name || 'Inget valt';
  if (btn) btn.textContent = name ? 'Ändra' : 'Ange';
}

function leafletIndicatorEdit() {
  const name = localStorage.getItem('lastLeafletName') || '';
  const input = document.getElementById('leaflet-edit-input');
  if (input) input.value = name;
  document.getElementById('leaflet-display').hidden = true;
  document.getElementById('leaflet-edit-btn').hidden = true;
  document.getElementById('leaflet-edit-form').hidden = false;
  input?.focus();
}

function leafletIndicatorSave() {
  const input = document.getElementById('leaflet-edit-input');
  setLeafletName(input ? input.value.trim() : '');
  leafletIndicatorCancel();
}

function leafletIndicatorCancel() {
  document.getElementById('leaflet-display').hidden = false;
  document.getElementById('leaflet-edit-btn').hidden = false;
  document.getElementById('leaflet-edit-form').hidden = true;
}

async function popupUnmark(btn) {
  const wayId = btn.dataset.wayid;
  const volunteer = btn.dataset.volunteer;
  map.closePopup();
  await unmarkStreet(wayId, volunteer);
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
  const marked = inside.filter(id => completions.has(id));

  document.getElementById('draw-hint').textContent =
    `${inside.length} gator inom området (${unmarked.length} omärkta, ${marked.length} redan markerade).`;
  document.getElementById('draw-finish-btn').hidden = true;
  document.getElementById('draw-confirm-btn').hidden = false;
  document.getElementById('draw-confirm-btn').disabled = unmarked.length === 0;
  document.getElementById('draw-confirm-btn').dataset.wayids = JSON.stringify(unmarked);
  const leafletRow = document.getElementById('draw-leaflet-row');
  if (leafletRow) {
    leafletRow.style.display = unmarked.length > 0 ? '' : 'none';
    const li = document.getElementById('draw-leaflet-input');
    if (li && !li.value) li.value = localStorage.getItem('lastLeafletName') || '';
  }
  const unmarkBtn = document.getElementById('draw-unmark-btn');
  unmarkBtn.hidden = marked.length === 0;
  unmarkBtn.disabled = false;
  unmarkBtn.textContent = 'Avmarkera hela området';
  unmarkBtn.dataset.wayids = JSON.stringify(marked);
}

async function drawConfirm() {
  if (!currentRoundId) { setStatus('Välj en omgång först.', 3000); return; }
  const btn = document.getElementById('draw-confirm-btn');
  const wayIds = JSON.parse(btn.dataset.wayids || '[]');
  if (!wayIds.length) return;

  const leafletInput = document.getElementById('draw-leaflet-input');
  const leafletName = leafletInput ? leafletInput.value.trim() : '';
  if (leafletName) setLeafletName(leafletName);

  btn.disabled = true;
  btn.textContent = 'Markerar…';

  const res = await fetch(`/api/rounds/${currentRoundId}/completions/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wayIds, volunteerName: userName, source: 'postal', leafletName: leafletName || undefined }),
  });

  if (res.ok) {
    const { added } = await res.json();
    const now = new Date().toISOString();
    wayIds.forEach(id => {
      completions.set(id, { volunteer_name: userName, marked_at: now, source: 'postal', leaflet_name: leafletName || null });
      layerByWayId.get(id)?.setStyle(streetStyle(id));
    });
    updateProgress();
    document.getElementById('draw-hint').textContent = `${added} gator markerade som postutdelade.`;
    btn.hidden = true;
    const unmarkBtn = document.getElementById('draw-unmark-btn');
    unmarkBtn.dataset.wayids = JSON.stringify(wayIds);
    unmarkBtn.hidden = false;
  } else {
    setStatus('Kunde inte markera gator.', 3000);
    cancelDraw();
  }
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
  document.getElementById('draw-finish-btn').disabled = true;
  document.getElementById('draw-confirm-btn').hidden = true;
  document.getElementById('draw-unmark-btn').hidden = true;
  document.getElementById('draw-unmark-btn').dataset.wayids = '';
  const lr = document.getElementById('draw-leaflet-row');
  if (lr) lr.style.display = 'none';
}

async function drawUnmark() {
  const btn = document.getElementById('draw-unmark-btn');
  const wayIds = JSON.parse(btn.dataset.wayids || '[]');
  if (!wayIds.length) return;

  btn.disabled = true;
  btn.textContent = 'Avmarkerar…';

  const res = await fetch(`/api/rounds/${currentRoundId}/completions/bulk`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ wayIds, volunteerName: userName }),
  });

  if (res.ok) {
    const { deleted } = await res.json();
    wayIds.forEach(id => {
      completions.delete(id);
      layerByWayId.get(id)?.setStyle(streetStyle(id));
    });
    updateProgress();
    setStatus(`${deleted} gator avmarkerade.`, 4000);
  } else {
    setStatus('Kunde inte avmarkera gator.', 3000);
    btn.disabled = false;
    btn.textContent = 'Avmarkera hela området';
    return;
  }
  cancelDraw();
  await refreshCompletions();
}

// ─── Completions API ──────────────────────────────────────────────────────────
async function markStreet(wayId, leafletName = '') {
  const res = await fetch(`/api/rounds/${currentRoundId}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wayId, volunteerName: userName, leafletName: leafletName || undefined }),
  });
  if (!res.ok) {
    setStatus('Kunde inte spara markering — kontrollera anslutningen.', 4000);
    return;
  }
  completions.set(wayId, { volunteer_name: userName, marked_at: new Date().toISOString(), source: 'manual', leaflet_name: leafletName || null });
  layerByWayId.get(wayId)?.setStyle(streetStyle(wayId));
  updateProgress();
}

async function unmarkStreet(wayId, volunteerName = userName) {
  const res = await fetch(
    `/api/rounds/${currentRoundId}/completions/${wayId}?volunteer=${encodeURIComponent(volunteerName)}`,
    { method: 'DELETE', headers: authHeaders() }
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
  const active = rounds.find(r => r.is_active);
  const autoSelect = active ?? (rounds.length === 1 ? rounds[0] : null);
  if (autoSelect) {
    select.value = String(autoSelect.id);
    await selectRound(autoSelect.id);
  }
}

function addRoundOption({ id, name, is_active }) {
  const opt = document.createElement('option');
  opt.value = String(id);
  opt.textContent = is_active ? `${name} ✓` : name;
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

document.getElementById('delete-round-btn').addEventListener('click', async () => {
  if (!currentRoundId) { setStatus('Välj en omgång att ta bort.', 3000); return; }
  const select = document.getElementById('round-select');
  const name = select.options[select.selectedIndex]?.text ?? currentRoundId;
  if (!confirm(`Ta bort omgången "${name}" och alla dess markeringar?`)) return;
  const res = await fetch(`/api/rounds/${currentRoundId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${authToken}` },
  });
  if (!res.ok) { const { error } = await res.json().catch(() => ({})); setStatus(error ?? 'Kunde inte ta bort', 4000); return; }
  select.options[select.selectedIndex].remove();
  currentRoundId = null;
  completions.clear();
  volunteerColors.clear();
  updateProgress();
  setStatus(`Omgången "${name}" borttagen.`, 4000);
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

  // Competition: poäng = hushåll × (1 + km × faktor), manual only (no postal)
  const scores = new Map();
  const scoreDetails = new Map(); // name → { hushall, meters }
  completions.forEach((c, wayId) => {
    if (c.source === 'postal') return;
    const hushall = householdsByWayId.get(String(wayId)) ?? 0;
    if (hushall === 0) return;
    const km = (lengthByWayId.get(wayId) ?? 0) / 1000;
    const pts = hushall * (1 + km * SCORE_KM_FACTOR);
    scores.set(c.volunteer_name, (scores.get(c.volunteer_name) ?? 0) + pts);
    const d = scoreDetails.get(c.volunteer_name) ?? { hushall: 0, meters: 0 };
    d.hushall += hushall;
    d.meters += lengthByWayId.get(wayId) ?? 0;
    scoreDetails.set(c.volunteer_name, d);
  });
  counts.forEach((_, name) => { if (!scores.has(name)) scores.set(name, 0); });
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  // Legend
  const legend = document.getElementById('volunteer-legend');
  legend.innerHTML = '';
  sorted.forEach(([name, pts], i) => {
    const color = volunteerColors.get(name) ?? '#888';
    const medal = i === 0 && pts > 0 ? ' 👑' : '';
    const d = scoreDetails.get(name);
    const tooltip = d ? `${d.hushall} hushåll · ${(d.meters / 1000).toFixed(1)} km` : 'inga poäng';
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.title = tooltip;
    item.innerHTML =
      `<span class="color-dot" style="background:${color}"></span>` +
      `${name}: ${Math.round(pts)} p${medal}`;
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

// ─── Admin panel ──────────────────────────────────────────────────────────────
document.getElementById('admin-btn').addEventListener('click', () => {
  const panel = document.getElementById('admin-panel');
  if (panel.hidden) {
    loadAdminPanel();
    panel.hidden = false;
  } else {
    panel.hidden = true;
  }
});

async function loadAdminPanel() {
  await Promise.all([loadAdminRounds(), loadAdminUsers()]);
}

async function loadAdminRounds() {
  const list = document.getElementById('admin-round-list');
  list.textContent = 'Laddar…';
  try {
    const res = await fetch('/api/rounds');
    const rounds = await res.json();
    list.innerHTML = '';
    if (!rounds.length) { list.textContent = 'Inga omgångar.'; return; }
    rounds.forEach(r => {
      const row = document.createElement('div');
      row.className = 'admin-user-row';
      const label = document.createElement('span');
      label.textContent = r.is_active ? `${r.name} ✓` : r.name;
      label.style.fontWeight = r.is_active ? 'bold' : '';
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = r.is_active ? 'Avsluta' : 'Aktivera';
      toggleBtn.className = 'admin-del-btn';
      toggleBtn.onclick = async () => {
        await fetch(`/api/rounds/${r.id}/activate`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
          body: JSON.stringify({ activate: !r.is_active }),
        });
        await loadRounds();
        await loadAdminRounds();
      };
      row.appendChild(label);
      row.appendChild(toggleBtn);
      list.appendChild(row);
    });
  } catch { list.textContent = 'Nätverksfel'; }
}

async function loadAdminUsers() {
  const list = document.getElementById('admin-user-list');
  list.textContent = 'Laddar…';
  try {
    const res = await fetch('/api/volunteers');
    if (!res.ok) { list.textContent = 'Fel vid laddning'; return; }
    const names = await res.json();
    list.innerHTML = '';
    if (!names.length) { list.textContent = 'Inga användare registrerade.'; return; }
    names.forEach(name => {
      const row = document.createElement('div');
      row.className = 'admin-user-row';
      const label = document.createElement('span');
      label.textContent = name;
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Ta bort';
      delBtn.className = 'admin-del-btn';
      delBtn.onclick = () => deleteUser(name, row);
      row.appendChild(label);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  } catch { list.textContent = 'Nätverksfel'; }
}

// ─── Start ────────────────────────────────────────────────────────────────────
init();
