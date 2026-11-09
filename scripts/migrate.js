const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

const FILES = ['schema.sql', 'chat_schema.sql', 'chat_v2_schema.sql'];

/** Applies all schema files in order (each is idempotent). */
async function migrate(db = pool) {
  for (const f of FILES) {
    const pre = process.env.CHAT_READER_PASSWORD
      ? `SELECT set_config('app.chat_reader_password', '${process.env.CHAT_READER_PASSWORD.replace(/'/g, "''")}', false);
` : '';
    await db.query(pre + fs.readFileSync(path.join(__dirname, '../src/db', f), 'utf8'));
  }
  // The schema creates chat_reader with a development password; hosted databases must set their own.
  if (process.env.CHAT_READER_PASSWORD) {
    const { rows } = await db.query("SELECT format('ALTER ROLE chat_reader PASSWORD %L', $1::text) AS q", [process.env.CHAT_READER_PASSWORD]);
    await db.query(rows[0].q);
  }
}

if (require.main === module) {
  (async () => {
    try {
      await migrate();
      console.log('Schema applied.');
    } catch (e) {
      console.error('Migration failed:', e.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}

module.exports = { migrate };
