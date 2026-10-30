const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Schema applied.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
