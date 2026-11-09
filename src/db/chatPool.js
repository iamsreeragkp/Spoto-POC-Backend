// Connection pool used for every chatbot query. Read-only twice over:
//  - CHAT_DATABASE_URL should point at the chat_reader role (SELECT-only grants, see chat_v2_schema.sql)
//  - every connection starts with default_transaction_read_only=on and a statement timeout,
//    so even if it falls back to DATABASE_URL nothing the chatbot runs can write or run away.
require('dotenv').config();
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v); // DATE as 'YYYY-MM-DD'

const timeout = Number(process.env.CHAT_STATEMENT_TIMEOUT_MS) || 8000;
const chatPool = new Pool({
  connectionString: process.env.CHAT_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/sporto_poc',
  max: Number(process.env.CHAT_POOL_SIZE) || 10,
  options: [
    '-c default_transaction_read_only=on',
    `-c statement_timeout=${timeout}`,
    // pgvector: keep scanning the HNSW graph until enough rows pass the filters (pgvector >= 0.8)
    '-c hnsw.iterative_scan=relaxed_order',
    `-c hnsw.ef_search=${Number(process.env.CHAT_HNSW_EF_SEARCH) || 200}`,
  ].join(' '),
});

// serverless Postgres (Neon) closes idle connections; the pool reconnects on demand
chatPool.on('error', (e) => console.warn('[chatPool] idle client error:', e.message));

module.exports = chatPool;
