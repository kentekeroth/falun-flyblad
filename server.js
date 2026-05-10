const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STREETS_CACHE = path.join(DATA_DIR, 'streets.geojson');
const POSTAL_CENTROIDS_CACHE = path.join(DATA_DIR, 'postal_centroids.geojson');
const HIGHWAY_FILTER = 'residential|primary|secondary|tertiary|unclassified|living_street';
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6'];

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});
let dbReady = false;
let dbError = null;

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rounds (
      id BIGINT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS volunteers (
      round_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      PRIMARY KEY (round_id, name)
    );
    CREATE TABLE IF NOT EXISTS completions (
      round_id BIGINT NOT NULL,
      way_id TEXT NOT NULL,
      volunteer_name TEXT NOT NULL,
      marked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      PRIMARY KEY (round_id, way_id)
    );
  `);
  console.log('Databas initialiserad');
}

// ─── Street data (Overpass + disk cache) ──────────────────────────────────────

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
  // OSM relation 300963 = Falu kommun
  const query = `[out:json][timeout:180];area(3600300963)->.kommun;way["highway"~"^(${HIGHWAY_FILTER})$"](area.kommun);out geom;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'FalunFlyblad/1.0',
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(200_000),
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

app.delete('/api/streets/cache', (_req, res) => {
  if (fs.existsSync(STREETS_CACHE)) fs.unlinkSync(STREETS_CACHE);
  streetsCache = null;
  res.json({ ok: true });
});

// ─── Postal codes ─────────────────────────────────────────────────────────────

app.get('/api/postalcodes', async (_req, res) => {
  try { res.json(await getPostalCentroids()); }
  catch (err) { res.status(503).json({ error: err.message }); }
});

// ─── Rounds ───────────────────────────────────────────────────────────────────

app.get('/api/rounds', async (_req, res) => {
  const { rows } = await db.query('SELECT id, name, created_at FROM rounds ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/rounds', async (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Namn krävs' });
  const id = Date.now();
  const created_at = new Date().toISOString();
  try {
    await db.query('INSERT INTO rounds (id, name, created_at) VALUES ($1, $2, $3)', [id, name, created_at]);
    res.json({ id, name, created_at });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'En omgång med det namnet finns redan' });
    throw err;
  }
});

// ─── Volunteers ───────────────────────────────────────────────────────────────

app.post('/api/rounds/:id/join', async (req, res) => {
  const roundId = Number(req.params.id);
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Namn krävs' });

  const { rows: existing } = await db.query(
    'SELECT round_id, name, color FROM volunteers WHERE round_id = $1 AND name = $2',
    [roundId, name]
  );
  if (existing.length) return res.json(existing[0]);

  const { rows: taken } = await db.query('SELECT color FROM volunteers WHERE round_id = $1', [roundId]);
  const takenColors = taken.map(v => v.color);
  const color = COLORS.find(c => !takenColors.includes(c)) ?? COLORS[takenColors.length % COLORS.length];

  await db.query('INSERT INTO volunteers (round_id, name, color) VALUES ($1, $2, $3)', [roundId, name, color]);
  res.json({ round_id: roundId, name, color });
});

// ─── Completions ──────────────────────────────────────────────────────────────

app.get('/api/rounds/:id/completions', async (req, res) => {
  const roundId = Number(req.params.id);
  const [{ rows: completions }, { rows: volunteers }] = await Promise.all([
    db.query('SELECT way_id, volunteer_name, marked_at, source FROM completions WHERE round_id = $1', [roundId]),
    db.query('SELECT name, color FROM volunteers WHERE round_id = $1', [roundId]),
  ]);
  let totalStreets = 0;
  try { totalStreets = (await getStreets()).features.length; } catch {}
  res.json({ completions, volunteers, totalStreets });
});

app.post('/api/rounds/:id/completions', async (req, res) => {
  const roundId = Number(req.params.id);
  const { wayId, volunteerName } = req.body ?? {};
  if (!wayId || !volunteerName) return res.status(400).json({ error: 'wayId och volunteerName krävs' });
  await db.query(
    `INSERT INTO completions (round_id, way_id, volunteer_name, marked_at, source)
     VALUES ($1, $2, $3, $4, 'manual')
     ON CONFLICT (round_id, way_id) DO UPDATE SET volunteer_name = $3, marked_at = $4, source = 'manual'`,
    [roundId, String(wayId), volunteerName, new Date().toISOString()]
  );
  res.json({ ok: true });
});

app.delete('/api/rounds/:id/completions/:wayId', async (req, res) => {
  const roundId = Number(req.params.id);
  const wayId = req.params.wayId;
  const volunteerName = req.query.volunteer;
  if (!volunteerName) return res.status(400).json({ error: 'volunteer query-param krävs' });
  const { rowCount } = await db.query(
    'DELETE FROM completions WHERE round_id = $1 AND way_id = $2 AND volunteer_name = $3',
    [roundId, wayId, volunteerName]
  );
  res.json({ ok: true, deleted: rowCount > 0 });
});

app.post('/api/rounds/:id/completions/bulk', async (req, res) => {
  const roundId = Number(req.params.id);
  const { wayIds, volunteerName, source = 'postal' } = req.body ?? {};
  if (!Array.isArray(wayIds) || !wayIds.length || !volunteerName) {
    return res.status(400).json({ error: 'wayIds (array) och volunteerName krävs' });
  }
  const { rowCount } = await db.query(
    `INSERT INTO completions (round_id, way_id, volunteer_name, marked_at, source)
     SELECT $1, unnest($2::text[]), $3, $4, $5
     ON CONFLICT DO NOTHING`,
    [roundId, wayIds.map(String), volunteerName, new Date().toISOString(), source]
  );
  res.json({ ok: true, added: rowCount });
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({
  ok: true,
  db: dbReady,
  dbError,
  hasDbUrl: !!process.env.DATABASE_URL,
}));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => console.log(`Flyblad-koordinator körs på port ${PORT}`));

initDB()
  .then(() => { dbReady = true; console.log('DB klar'); })
  .catch(err => {
    const msg = err.message || err.errors?.[0]?.message || err.toString();
    console.error('DB init failed:', msg);
    dbError = msg;
  });
