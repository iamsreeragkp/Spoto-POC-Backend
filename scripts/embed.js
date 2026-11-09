// Backfills embeddings for every pending text chunk (sentences + tags).
// Usage: node scripts/embed.js            (EMBEDDING_PROVIDER / EMBEDDING_MODEL from .env)
const pool = require('../src/db/pool');
const { embedPending, pendingCount, resetStaleModel } = require('../src/chat/embedder');
const { modelId } = require('../src/chat/embeddings');

(async () => {
  try {
    await resetStaleModel();
    const total = await pendingCount();
    console.log(`Embedding ${total} pending chunks with ${modelId()}...`);
    const t0 = Date.now();
    const n = await embedPending({ onProgress: (d) => process.stdout.write(`\r  ${d}/${total}`) });
    console.log(`\nDone: ${n} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error('\nEmbedding failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
