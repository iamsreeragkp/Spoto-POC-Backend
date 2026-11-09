require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db/pool');
const { HttpError } = require('./utils/crud');
const { scouts, teams, players, matches, reports, stats } = require('./routes/resources');
const chat = require('./routes/chat');
const { clearCaches } = require('./chat/service');
const { accessKey, required: authRequired } = require('./middleware/access');

const app = express();
// CORS_ORIGIN = comma-separated list of allowed frontend origins (default: any)
const origins = (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'up', auth_required: authRequired() });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'down', message: e.message });
  }
});

app.use('/api', accessKey);

// Any successful write invalidates the chatbot's result cache so answers never go stale
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !req.originalUrl.startsWith('/api/chat')) res.on('finish', () => { if (res.statusCode < 400) clearCaches(); });
  next();
});

app.use('/api/chat', chat);
app.use('/api/players', players);
app.use('/api/reports', reports);
app.use('/api/matches', matches);
app.use('/api/teams', teams);
app.use('/api/scouts', scouts);
app.use('/api/stats', stats);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Maps Postgres errors to sensible HTTP responses
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  const pg = {
    '23505': [409, 'Duplicate value violates a unique constraint'],
    '23503': [409, 'Referenced record does not exist, or record is still referenced'],
    '23502': [400, 'A required field is null'],
    '23514': [400, 'Value violates a check constraint (scores must be 0-10)'],
    '22P02': [400, 'Invalid value format'],
    '22007': [400, 'Invalid date/time format'],
    '22008': [400, 'Invalid date/time value'],
    '22003': [400, 'Numeric value out of range'],
  }[err.code];
  if (pg) return res.status(pg[0]).json({ error: pg[1], details: err.detail || err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
  require('./chat/embedder').startWorker(); // fills embeddings for new report text in the background
  // warm the chatbot's vocabulary cache so the first question doesn't pay for it
  require('./chat/vocabulary').getVocabulary().catch((e) => console.error('vocabulary warm-up failed:', e.message));
}

module.exports = app;
