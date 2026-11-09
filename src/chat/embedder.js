// Background embedding worker. Triggers put new sentences/tags into text_chunks with embedding = NULL;
// this fills them in batches. Inserts and updates never wait for the embedding API.
//   startWorker()   – called by server.js (disable with EMBEDDINGS_WORKER=false)
//   embedPending()  – used by the worker, scripts/embed.js and the test setup
const pool = require('../db/pool');
const { embed, modelId, toSql } = require('./embeddings');
const { redactComment } = require('./redact');
const { redactionNames, clearNames } = require('./names');

let lastNamesRefresh = 0;

const BATCH = Number(process.env.EMBEDDING_BATCH_SIZE) || 128;

const embedText = (row, names) =>
  row.kind === 'tag' ? `${row.category} attribute: ${row.content}` : redactComment(row.content, names);

/** Rows embedded with a different model are reset so the vector space stays consistent. */
async function resetStaleModel() {
  const r = await pool.query(
    'UPDATE text_chunks SET embedding = NULL, model = NULL, embedded_at = NULL WHERE embedding IS NOT NULL AND model IS DISTINCT FROM $1',
    [modelId()]);
  if (r.rowCount) console.warn(`[embedder] ${r.rowCount} chunks were embedded with another model; re-embedding with ${modelId()}`);
  return r.rowCount;
}

async function pendingCount() {
  return Number((await pool.query('SELECT COUNT(*) AS n FROM text_chunks WHERE embedding IS NULL')).rows[0].n);
}

/** Embeds all pending chunks (or up to maxBatches batches). Returns the number embedded. */
async function embedPending({ maxBatches = Infinity, onProgress } = {}) {
  // refresh the learned names (at most every 5 min) so names in brand-new sentences are masked before embedding
  if (Date.now() - lastNamesRefresh > 5 * 60 * 1000) { clearNames(); lastNamesRefresh = Date.now(); }
  const names = await redactionNames();
  let done = 0;
  for (let b = 0; b < maxBatches; b++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT id, kind, category, content FROM text_chunks WHERE embedding IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED', [BATCH]);
      if (!rows.length) { await client.query('COMMIT'); break; }
      const vecs = await embed(rows.map((r) => embedText(r, names)));
      await client.query(
        `UPDATE text_chunks t SET embedding = v.e::halfvec, model = $3, embedded_at = now()
         FROM unnest($1::bigint[], $2::text[]) AS v(id, e) WHERE t.id = v.id`,
        [rows.map((r) => r.id), vecs.map(toSql), modelId()]);
      await client.query('COMMIT');
      done += rows.length;
      onProgress && onProgress(done);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return done;
}

/** Removes sentences no report uses any more (after edits/deletes) so they don't show up as search candidates. */
async function pruneOrphans() {
  const r = await pool.query(`DELETE FROM text_chunks t WHERE kind = 'text'
    AND created_at < now() - interval '10 minutes'
    AND NOT EXISTS (SELECT 1 FROM report_chunks rc WHERE rc.chunk_id = t.id)`);
  return r.rowCount;
}

let timer = null;
function startWorker({ intervalMs = Number(process.env.EMBEDDING_INTERVAL_MS) || 5000 } = {}) {
  if (String(process.env.EMBEDDINGS_WORKER ?? 'true').toLowerCase() === 'false') return;
  let running = false, failures = 0, skipUntil = 0, lastPrune = 0;
  const tick = async () => {
    if (running || Date.now() < skipUntil) return;
    running = true;
    try {
      const n = await embedPending({ maxBatches: 20 });
      if (n) console.log(`[embedder] embedded ${n} chunks (${modelId()})`);
      if (Date.now() - lastPrune > 60 * 60 * 1000) {
        lastPrune = Date.now();
        // a concurrent report reusing a sentence makes the delete fail on the foreign key – harmless, retried next hour
        const p = await pruneOrphans().catch((e) => { console.warn(`[embedder] prune skipped: ${e.message}`); return 0; });
        if (p) console.log(`[embedder] pruned ${p} sentences no longer used by any report`);
      }
      failures = 0;
    } catch (e) {
      failures++;
      skipUntil = Date.now() + Math.min(300000, 5000 * 2 ** failures); // exponential backoff, max 5 min
      console.error(`[embedder] failed (${e.code || ''} ${e.message}); retrying later`);
    } finally {
      running = false;
    }
  };
  resetStaleModel().catch((e) => console.error('[embedder] model check failed:', e.message)).finally(() => {
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref();
  });
}
const stopWorker = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { embedPending, pendingCount, resetStaleModel, pruneOrphans, startWorker, stopWorker };
