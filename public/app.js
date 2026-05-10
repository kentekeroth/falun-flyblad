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
  await Promise.all([loadRounds(), loadStreets()]);
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

    L.geoJSON(geojson, {
      style: f => streetStyle(f.properties.id),
      onEachFeature(feature, layer) {
        layerByWayId.set(feature.properties.id, layer);
        if (feature.properties.name) {
          layer.bindTooltip(feature.properties.name, {
            sticky: true,
            className: 'street-tip',
          });
        }
        layer.on('click', e => handleStreetClick(e, feature));
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
  const color = volunteerColors.get(comp.volunteer_name) ?? '#888';
  return { color, weight: 6, opacity: 1, interactive: true };
}

function refreshStreetStyles() {
  layerByWayId.forEach((layer, wayId) => layer.setStyle(streetStyle(wayId)));
}

async function handleStreetClick(e, feature) {
  L.DomEvent.stopPropagation(e);
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
  const unmarkBtn = comp.volunteer_name === userName
    ? `<br><button class="popup-unmark-btn" onclick="popupUnmark('${wayId}')">Avmarkera</button>`
    : '';

  L.popup()
    .setLatLng(e.latlng)
    .setContent(
      `<b>${streetName}</b><br>` +
      `Markerad av <b>${comp.volunteer_name}</b><br>` +
      `${formatted}` +
      unmarkBtn
    )
    .openOn(map);
}

async function popupUnmark(wayId) {
  map.closePopup();
  await unmarkStreet(wayId);
}

// ─── Completions API ──────────────────────────────────────────────────────────
async function markStreet(wayId) {
  const res = await fetch(`/api/rounds/${currentRoundId}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wayId, volunteerName: userName }),
  });
  if (!res.ok) return;
  completions.set(wayId, { volunteer_name: userName, marked_at: new Date().toISOString() });
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

  document.getElementById('progress-text').textContent =
    total > 0
      ? `${pct}% av Falun klart — ${done} av ${total} gator utdelade`
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
