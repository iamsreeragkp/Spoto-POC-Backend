require('dotenv').config();
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (no JS Date / timezone shift)
types.setTypeParser(1082, (v) => v);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sporto_poc',
});

// serverless Postgres (Neon) closes idle connections; the pool reconnects on demand
pool.on('error', (e) => console.warn('[pool] idle client error:', e.message));

module.exports = pool;
