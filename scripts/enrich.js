// Backfills derived chatbot data and prewarms the geo cache.
//  - re-fires the derive/tag triggers for existing rows (heights, report_tags)
//  - geocodes every player location and precomputes drive times from reference places
// Usage: node scripts/enrich.js [ReferencePlace ...]   (default reference: Ikast)
const pool = require('../src/db/pool');
const geo = require('../src/chat/geo');

(async () => {
  try {
    await pool.query('UPDATE players SET name = name');
    await pool.query('UPDATE reports SET id = id');
    const c = await pool.query(`SELECT (SELECT COUNT(*) FROM report_tags) AS tags,
      (SELECT COUNT(*) FROM players WHERE father_height_mid IS NOT NULL) AS fathers,
      (SELECT COUNT(*) FROM players WHERE mother_height_mid IS NOT NULL) AS mothers`);
    console.log('Derived data:', c.rows[0]);

    const refs = process.argv.slice(2).length ? process.argv.slice(2) : ['Ikast'];
    const { rows } = await pool.query('SELECT DISTINCT location FROM players WHERE location IS NOT NULL ORDER BY 1');
    for (const { location } of rows) {
      const had = await pool.query('SELECT 1 FROM places WHERE name = $1', [location]);
      if (had.rowCount) continue;
      const p = await geo.ensurePlace(location);
      console.log(p ? `geocoded ${location}` : `could not geocode ${location}`);
      await new Promise((r) => setTimeout(r, 1100)); // Nominatim: max 1 request/second
    }
    for (const ref of refs) {
      const r = await geo.locationsWithin(ref, 60);
      console.log(r ? `${ref}: ${r.locations.length} locations within 60 min (source: ${r.source})` : `${ref}: could not resolve`);
    }
  } catch (e) {
    console.error('enrich failed:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
