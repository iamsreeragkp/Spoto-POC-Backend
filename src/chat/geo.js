// Geocoding + driving-time lookups, cached in Postgres (tables: places, drive_time).
// Player locations are prewarmed by scripts/enrich.js, so the hot path is a single indexed query.
const pool = require('../db/pool');

const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const OSRM_URL = process.env.OSRM_URL || 'https://router.project-osrm.org';
const UA = process.env.GEO_USER_AGENT || 'sporto-poc-backend/1.0';
const TIMEOUT = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

const canon = (s) => String(s).trim().replace(/\s+/g, ' ');

/** Returns {name, lat, lng} for a place, geocoding (Nominatim) + caching on first use. null if not found. */
async function ensurePlace(rawName) {
  const name = canon(rawName);
  const hit = await pool.query('SELECT name, lat, lng FROM places WHERE lower(name) = lower($1)', [name]);
  if (hit.rows[0]) return hit.rows[0];

  const url = `${NOMINATIM_URL}/search?format=json&limit=1&countrycodes=dk&q=${encodeURIComponent(name + ', Denmark')}`;
  let results;
  try { results = await fetchJson(url); } catch (e) { console.warn(`geocode failed for "${name}": ${e.message}`); return null; }
  if (!results.length) return null;
  const place = { name, lat: Number(results[0].lat), lng: Number(results[0].lon) };
  await pool.query('INSERT INTO places(name, lat, lng) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING', [place.name, place.lat, place.lng]);
  return place;
}

const haversineKm = (a, b) => {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Computes + caches drive minutes from `from` to every distinct player location. */
async function ensureDriveTimes(from) {
  const origin = await ensurePlace(from);
  if (!origin) return null;

  const { rows: locs } = await pool.query('SELECT DISTINCT location FROM players WHERE location IS NOT NULL');
  const { rows: have } = await pool.query('SELECT to_place FROM drive_time WHERE lower(from_place) = lower($1)', [origin.name]);
  const done = new Set(have.map((r) => r.to_place));
  const missing = locs.map((r) => r.location).filter((l) => !done.has(l));
  if (!missing.length) return origin;

  const dests = [];
  for (const l of missing) {
    const hit = await pool.query('SELECT name, lat, lng FROM places WHERE name = $1', [l]);
    if (hit.rows[0]) { dests.push(hit.rows[0]); continue; }
    const p = await ensurePlace(l); // slow path (Nominatim 1 req/s) – normally prewarmed by enrich.js
    if (p) dests.push({ ...p, name: l }); // keep the player's own spelling as the key
    await sleep(1100);
  }
  if (!dests.length) return origin;

  let minutes = null, source = 'osrm';
  try {
    const coords = [origin, ...dests].map((p) => `${p.lng},${p.lat}`).join(';');
    const r = await fetchJson(`${OSRM_URL}/table/v1/driving/${coords}?sources=0&annotations=duration`);
    if (r.code === 'Ok') minutes = r.durations[0].slice(1).map((s) => (s == null ? null : s / 60));
  } catch (e) { console.warn(`OSRM failed (${e.message}); using straight-line estimate`); }

  if (!minutes) {
    source = 'estimate';
    minutes = dests.map((d) => (haversineKm(origin, d) * 1.3 / 70) * 60);
  }
  for (let i = 0; i < dests.length; i++) {
    if (minutes[i] == null) continue;
    await pool.query(
      `INSERT INTO drive_time(from_place, to_place, minutes, source) VALUES($1,$2,$3,$4)
       ON CONFLICT(from_place, to_place) DO UPDATE SET minutes = EXCLUDED.minutes, source = EXCLUDED.source`,
      [origin.name, dests[i].name, minutes[i].toFixed(1), source]);
  }
  return origin;
}

/**
 * Locations within `maxMinutes` driving of `place`.
 * Returns { place, locations: [{location, minutes}], source } or null if the place can't be resolved.
 */
async function locationsWithin(place, maxMinutes) {
  const origin = await ensureDriveTimes(place);
  if (!origin) return null;
  const { rows } = await pool.query(
    `SELECT to_place AS location, minutes::float AS minutes, source FROM drive_time
     WHERE lower(from_place) = lower($1) AND minutes <= $2 ORDER BY minutes`, [origin.name, maxMinutes]);
  return { place: origin.name, locations: rows, source: rows[0]?.source || null };
}

module.exports = { ensurePlace, ensureDriveTimes, locationsWithin };
