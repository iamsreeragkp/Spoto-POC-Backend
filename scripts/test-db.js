// Prepares the isolated test database (default sporto_poc_test on the same server) – run automatically by `npm test`.
//  - creates it if missing, applies migrations, seeds the Excel data
//  - copies the geo cache (places, drive_time) from the main database so distance tests need no network
//  - embeds all text with the offline mock embedding provider
// The main database is only read (geo cache).
const { execFileSync } = require('child_process');
const path = require('path');
require('dotenv').config();
const { Client } = require('pg');
const { testUrls } = require('../tests/helpers/urls');

(async () => {
  const { mainUrl, testUrl, dbName, adminUrl } = testUrls();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
    console.log(`created database ${dbName}`);
  }
  await admin.end();

  const env = { ...process.env, DATABASE_URL: testUrl, EMBEDDING_PROVIDER: 'mock', LLM_PROVIDER: 'mock' };
  const run = (script, args = []) => execFileSync(process.execPath, [path.join(__dirname, script), ...args], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  run('migrate.js');
  run('seed.js');
  run('fill-gaps.js');

  // geo cache from the main DB (read only)
  const main = new Client({ connectionString: mainUrl });
  const test = new Client({ connectionString: testUrl });
  await Promise.all([main.connect(), test.connect()]);
  const places = (await main.query('SELECT name, lat, lng FROM places')).rows;
  const drive = (await main.query('SELECT from_place, to_place, minutes, source FROM drive_time')).rows;
  await test.query('TRUNCATE places, drive_time');
  for (const p of places) await test.query('INSERT INTO places(name, lat, lng) VALUES ($1,$2,$3)', [p.name, p.lat, p.lng]);
  for (const d of drive) {
    await test.query('INSERT INTO drive_time(from_place, to_place, minutes, source) VALUES ($1,$2,$3,$4)', [d.from_place, d.to_place, d.minutes, d.source]);
  }
  await test.query('TRUNCATE chat_conversations CASCADE');
  await Promise.all([main.end(), test.end()]);

  run('embed.js');
  console.log(`test database ${dbName} ready (${places.length} places, ${drive.length} drive times copied)`);
})().catch((e) => {
  console.error('test DB setup failed:', e.message);
  process.exit(1);
});
