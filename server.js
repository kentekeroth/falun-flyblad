const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STREETS_CACHE = path.join(DATA_DIR, 'streets.geojson');
const POSTAL_CENTROIDS_CACHE = path.join(DATA_DIR, 'postal_centroids.geojson');

const HIGHWAY_FILTER = 'residential|primary|secondary|tertiary|unclassified|living_street';

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6'];

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Persistent state (JSON file) ─────────────────────────────────────────────

// Shape: { rounds: [...], volunteers: [...], completions: [...] }
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { rounds: [], volunteers: [], completions: [] };
  }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

let state = loadState();

// ─── Street data (Overpass API + disk cache) ──────────────────────────────────

let streetsCache = null;
let postalCentroidsCache = null;

async function getStreets() {
  if (streetsCache) return streetsCache;
  if (fs.existsSync(STREETS_CACHE)) {
    streetsCache = JSON.parse(fs.readFileSync(STREETS_CACHE, 'utf8'));
    console.log(`Streets loaded from cache (${streetsCache.features.length} ways)`);
    return streetsCache;
  }
  console.log('Fetching streets from Overpass API…');
  // OSM relation 300963 = Falu kommun; area ID = relation ID + 3600000000
  const query = `[out:json][timeout:180];area(3600300963)->.kommun;way["highway"~"^(${HIGHWAY_FILTER})$"](area.kommun);out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'FalunFlyblad/1.0',
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(100_000),
  });
  if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
  const data = await res.json();

  const geojson = {
    type: 'FeatureCollection',
    features: data.elements
      .filter(e => e.geometry?.length > 1)
      .map(way => ({
        type: 'Feature',
        id: String(way.id),
        properties: {
          id: String(way.id),
          name: way.tags?.name ?? null,
          highway: way.tags?.highway ?? 'unknown',
        },
        geometry: {
          type: 'LineString',
          coordinates: way.geometry.map(p => [p.lon, p.lat]),
        },
      })),
  };

  fs.writeFileSync(STREETS_CACHE, JSON.stringify(geojson));
  streetsCache = geojson;
  console.log(`Streets fetched and cached (${geojson.features.length} ways)`);
  return geojson;
}

// ─── Postal code centroid data ────────────────────────────────────────────────

async function getPostalCentroids() {
  if (postalCentroidsCache) return postalCentroidsCache;
  if (fs.existsSync(POSTAL_CENTROIDS_CACHE)) {
    postalCentroidsCache = JSON.parse(fs.readFileSync(POSTAL_CENTROIDS_CACHE, 'utf8'));
    console.log(`Postal centroids loaded from cache (${postalCentroidsCache.features.length} codes)`);
    return postalCentroidsCache;
  }
  console.log('Fetching postal code address nodes from Overpass…');
  const query = `[out:json][timeout:60];area(3600300963)->.falun;node["addr:postcode"](area.falun);out;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'FalunFlyblad/1.0' },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(70_000),
  });
  if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
  const data = await res.json();

  const buckets = {};
  for (const node of data.elements) {
    const raw = node.tags?.['addr:postcode'];
    if (!raw) continue;
    const code = raw.replace(/\s+/g, '');
    if (!buckets[code]) buckets[code] = { latSum: 0, lonSum: 0, count: 0 };
    buckets[code].latSum += node.lat;
    buckets[code].lonSum += node.lon;
    buckets[code].count++;
  }

  const features = Object.entries(buckets)
    .filter(([, v]) => v.count >= 2)
    .map(([code, v]) => ({
      type: 'Feature',
      properties: { postalCode: code },
      geometry: { type: 'Point', coordinates: [v.lonSum / v.count, v.latSum / v.count] },
    }));

  postalCentroidsCache = { type: 'FeatureCollection', features };
  fs.writeFileSync(POSTAL_CENTROIDS_CACHE, JSON.stringify(postalCentroidsCache));
  console.log(`Postal centroids cached (${features.length} codes)`);
  return postalCentroidsCache;
}

// ─── Express setup ────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Streets ──────────────────────────────────────────────────────────────────

app.get('/api/streets', async (_req, res) => {
  try {
    res.json(await getStreets());
  } catch (err) {
    console.error('Streets error:', err.message);
    res.status(503).json({ error: 'Kunde inte hämta gatadata: ' + err.message });
  }
});

app.get('/api/postalcodes', async (_req, res) => {
  try { res.json(await getPostalCentroids()); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

app.delete('/api/streets/cache', (_req, res) => {
  if (fs.existsSync(STREETS_CACHE)) fs.unlinkSync(STREETS_CACHE);
  streetsCache = null;
  res.json({ ok: true });
});

// ─── Rounds ───────────────────────────────────────────────────────────────────

app.get('/api/rounds', (_req, res) => {
  res.json([...state.rounds].sort((a, b) => b.created_at.localeCompare(a.created_at)));
});

app.post('/api/rounds', (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Namn krävs' });
  if (state.rounds.some(r => r.name === name)) {
    return res.status(409).json({ error: 'En omgång med det namnet finns redan' });
  }
  const round = { id: Date.now(), name, created_at: new Date().toISOString() };
  state.rounds.push(round);
  saveState(state);
  res.json(round);
});

// ─── Volunteers ───────────────────────────────────────────────────────────────

app.post('/api/rounds/:id/join', (req, res) => {
  const roundId = Number(req.params.id);
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Namn krävs' });

  const existing = state.volunteers.find(v => v.round_id === roundId && v.name === name);
  if (existing) return res.json(existing);

  const taken = state.volunteers.filter(v => v.round_id === roundId).map(v => v.color);
  const color = COLORS.find(c => !taken.includes(c)) ?? COLORS[taken.length % COLORS.length];

  const volunteer = { round_id: roundId, name, color };
  state.volunteers.push(volunteer);
  saveState(state);
  res.json(volunteer);
});

// ─── Completions ──────────────────────────────────────────────────────────────

app.get('/api/rounds/:id/completions', async (req, res) => {
  const roundId = Number(req.params.id);
  const completions = state.completions
    .filter(c => c.round_id === roundId)
    .map(({ way_id, volunteer_name, marked_at, source }) => ({ way_id, volunteer_name, marked_at, source: source ?? 'manual' }));
  const volunteers = state.volunteers
    .filter(v => v.round_id === roundId)
    .map(({ name, color }) => ({ name, color }));

  let totalStreets = 0;
  try { totalStreets = (await getStreets()).features.length; } catch {}

  res.json({ completions, volunteers, totalStreets });
});

app.post('/api/rounds/:id/completions', (req, res) => {
  const roundId = Number(req.params.id);
  const { wayId, volunteerName } = req.body ?? {};
  if (!wayId || !volunteerName) return res.status(400).json({ error: 'wayId och volunteerName krävs' });

  const idx = state.completions.findIndex(c => c.round_id === roundId && c.way_id === String(wayId));
  const entry = { round_id: roundId, way_id: String(wayId), volunteer_name: volunteerName, marked_at: new Date().toISOString() };
  if (idx >= 0) {
    state.completions[idx] = entry;
  } else {
    state.completions.push(entry);
  }
  saveState(state);
  res.json({ ok: true });
});

app.delete('/api/rounds/:id/completions/:wayId', (req, res) => {
  const roundId = Number(req.params.id);
  const wayId = req.params.wayId;
  const volunteerName = req.query.volunteer;
  if (!volunteerName) return res.status(400).json({ error: 'volunteer query-param krävs' });

  const before = state.completions.length;
  state.completions = state.completions.filter(
    c => !(c.round_id === roundId && c.way_id === wayId && c.volunteer_name === volunteerName)
  );
  if (state.completions.length < before) saveState(state);
  res.json({ ok: true, deleted: state.completions.length < before });
});

app.post('/api/rounds/:id/completions/bulk', (req, res) => {
  const roundId = Number(req.params.id);
  const { wayIds, volunteerName, source = 'postal' } = req.body ?? {};
  if (!Array.isArray(wayIds) || !wayIds.length || !volunteerName) {
    return res.status(400).json({ error: 'wayIds (array) och volunteerName krävs' });
  }
  const now = new Date().toISOString();
  let added = 0;
  for (const wayId of wayIds) {
    const exists = state.completions.some(c => c.round_id === roundId && c.way_id === String(wayId));
    if (!exists) {
      state.completions.push({ round_id: roundId, way_id: String(wayId), volunteer_name: volunteerName, marked_at: now, source });
      added++;
    }
  }
  if (added > 0) saveState(state);
  res.json({ ok: true, added });
});

app.listen(PORT, () => console.log(`Flyblad-koordinator körs på port ${PORT}`));
