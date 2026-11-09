// Generates synthetic players + reports for scale testing (POC only). Real rows are never touched.
//   node scripts/synth.js --players 300000 --reports 1000000
//   node scripts/synth.js --clean            (removes all synthetic rows)
// Synthetic players are named "Player S-0000001" and have notes = 'synthetic'. Each synthetic report copies tags,
// scores (±1) and x-factor from random real reports and builds its comment from 2-5 random real scout sentences,
// so keyword and meaning search behave realistically and no new sentences need embedding.
// Triggers are bypassed (session_replication_role = replica) and derived tables are rebuilt set-based.
const pool = require('../src/db/pool');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : def;
};
const BATCH = 100000;

async function clean(c) {
  console.log('Removing synthetic rows...');
  await c.query(`CREATE TEMP TABLE syn_p AS SELECT id FROM players WHERE notes = 'synthetic'`);
  await c.query(`CREATE TEMP TABLE syn_r AS SELECT r.id FROM reports r JOIN syn_p ON syn_p.id = r.player_id`);
  await c.query('DELETE FROM report_chunks WHERE report_id IN (SELECT id FROM syn_r)');
  await c.query('DELETE FROM report_tags WHERE report_id IN (SELECT id FROM syn_r)');
  await c.query('DELETE FROM reports WHERE id IN (SELECT id FROM syn_r)');
  await c.query('DELETE FROM player_latest WHERE player_id IN (SELECT id FROM syn_p)');
  await c.query('DELETE FROM player_text WHERE player_id IN (SELECT id FROM syn_p)');
  const r = await c.query('DELETE FROM players WHERE id IN (SELECT id FROM syn_p)');
  await c.query('DROP TABLE syn_p, syn_r');
  await c.query(`DELETE FROM text_chunks t WHERE kind = 'text' AND NOT EXISTS (SELECT 1 FROM report_chunks rc WHERE rc.chunk_id = t.id)`);
  console.log(`  removed ${r.rowCount} synthetic players and their reports`);
}

(async () => {
  const c = await pool.connect();
  const t0 = Date.now();
  const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  try {
    await c.query("SET session_replication_role = replica"); // bypass row triggers for bulk work
    await c.query("SET statement_timeout = 0");
    await clean(c);
    if (arg('clean')) { await c.query('ANALYZE'); return; }

    const nPlayers = Number(arg('players', 300000));
    const nReports = Number(arg('reports', 1000000));
    if (nReports < nPlayers) throw new Error('--reports must be >= --players');

    await c.query(`CREATE TEMP TABLE tpl_p AS SELECT row_number() OVER (ORDER BY id) AS rn, * FROM players WHERE notes IS DISTINCT FROM 'synthetic'`);
    await c.query(`CREATE TEMP TABLE tpl_r AS SELECT row_number() OVER (ORDER BY r.id) AS rn, r.* FROM reports r
      JOIN players p ON p.id = r.player_id WHERE p.notes IS DISTINCT FROM 'synthetic'`);
    const { rows: [{ np, nr }] } = await c.query('SELECT (SELECT count(*) FROM tpl_p)::int AS np, (SELECT count(*) FROM tpl_r)::int AS nr');
    if (!np || !nr) throw new Error('Need real players and reports to copy from (run npm run db:setup first)');
    await c.query(`CREATE TEMP TABLE tpl_s AS SELECT row_number() OVER () AS rn, chunk FROM (
      SELECT DISTINCT s.chunk FROM tpl_r r, LATERAL split_chunks(r.overall_comment) s) x`);
    const { rows: [{ ns }] } = await c.query('SELECT count(*)::int AS ns FROM tpl_s');
    step(`templates: ${np} players, ${nr} reports, ${ns} distinct comment sentences`);

    // ---- players ----
    const { rows: [{ maxp }] } = await c.query('SELECT coalesce(max(id), 0) AS maxp FROM players');
    await c.query(`
      INSERT INTO players(name, gender, date_of_birth, year_of_birth, age_group, jersey_number, location, position, secondary_position,
                          strong_foot, team_id, mother_height, father_height, mother_height_mid, father_height_mid, notes)
      SELECT format('Player S-%s', lpad(g::text, 7, '0')), d.gender, d.date_of_birth, d.year_of_birth, d.age_group, 1 + floor(random() * 30)::int,
             b.location, a.position, a.secondary_position, d.strong_foot, b.team_id,
             h.mother_height, h.father_height, height_mid(h.mother_height), height_mid(h.father_height), 'synthetic'
      FROM (SELECT g, 1 + floor(random() * $2)::int AS pa, 1 + floor(random() * $2)::int AS pb,
                   1 + floor(random() * $2)::int AS ph, 1 + floor(random() * $2)::int AS pd FROM generate_series(1, $1) g) x
      JOIN tpl_p a ON a.rn = x.pa JOIN tpl_p b ON b.rn = x.pb JOIN tpl_p h ON h.rn = x.ph JOIN tpl_p d ON d.rn = x.pd`, [nPlayers, np]);
    const { rows: [{ minSp, maxSp }] } = await c.query(
      `SELECT min(id) AS "minSp", max(id) AS "maxSp" FROM players WHERE notes = 'synthetic' AND id > $1`, [maxp]);
    step(`inserted ${nPlayers} players (ids ${minSp}-${maxSp})`);

    // ---- reports, in batches ----
    for (let done = 0; done < nReports; done += BATCH) {
      const n = Math.min(BATCH, nReports - done);
      const { rows: [{ maxr }] } = await c.query('SELECT coalesce(max(id), 0) AS maxr FROM reports');
      await c.query(`
        INSERT INTO reports(player_id, match_id, scout_id, report_date, stage_of_growth, height_now, height_now_mid,
          physical, mental, technical, tactical, deadball, x_factor,
          score_physical, score_mental, score_technical, score_tactical, score_deadball, score_x_factor,
          overall_score, overall_potential_score, overall_comment, recommendation)
        SELECT x.player_id, s.match_id, k.scout_id, date '2022-01-01' + floor(random() * 1765)::int, s.stage_of_growth, s.height_now, height_mid(s.height_now),
          t1.physical, t2.mental, t3.technical, t4.tactical, t5.deadball, xf.x_factor,
          s.score_physical, s.score_mental, s.score_technical, s.score_tactical, s.score_deadball, s.score_x_factor,
          CASE WHEN s.overall_score IS NULL THEN NULL ELSE greatest(1, least(6, s.overall_score + floor(random() * 3)::int - 1)) END,
          CASE WHEN s.overall_potential_score IS NULL THEN NULL ELSE greatest(1, least(6, s.overall_potential_score + floor(random() * 3)::int - 1)) END,
          (SELECT string_agg(sa.sarr[1 + floor(random() * $4)::int + 0 * i], chr(10)) FROM generate_series(1, x.nsent) AS i),
          s.recommendation
        FROM (SELECT g,
                CASE WHEN $1 + g <= $6 THEN $5 + $1 + g - 1 ELSE $5 + floor(random() * $6)::int END AS player_id,
                2 + floor(random() * 4)::int AS nsent,
                1 + floor(random() * $3)::int AS ps, 1 + floor(random() * $3)::int AS pk, 1 + floor(random() * $3)::int AS p1,
                1 + floor(random() * $3)::int AS p2, 1 + floor(random() * $3)::int AS p3, 1 + floor(random() * $3)::int AS p4,
                1 + floor(random() * $3)::int AS p5, 1 + floor(random() * $3)::int AS px
              FROM generate_series(1, $2) g) x
        JOIN tpl_r s ON s.rn = x.ps JOIN tpl_r k ON k.rn = x.pk JOIN tpl_r t1 ON t1.rn = x.p1 JOIN tpl_r t2 ON t2.rn = x.p2
        JOIN tpl_r t3 ON t3.rn = x.p3 JOIN tpl_r t4 ON t4.rn = x.p4 JOIN tpl_r t5 ON t5.rn = x.p5 JOIN tpl_r xf ON xf.rn = x.px
        CROSS JOIN (SELECT array_agg(chunk ORDER BY rn) AS sarr FROM tpl_s) sa`,
      [done, n, nr, ns, minSp, nPlayers]);
      const { rows: [{ hi }] } = await c.query('SELECT max(id) AS hi FROM reports');
      await c.query('SELECT rebuild_report_tags($1, $2)', [maxr + 1, hi]);
      await c.query('SELECT rebuild_report_chunks($1, $2)', [maxr + 1, hi]);
      step(`reports ${done + n}/${nReports} (+tags, +chunks)`);
    }

    await c.query('SELECT rebuild_tag_chunks()');
    step('rebuilding player_latest + player_text...');
    await c.query('SELECT rebuild_player_latest()');
    step('analyzing...');
    await c.query('ANALYZE');
    const { rows: [s] } = await c.query(`SELECT (SELECT count(*) FROM players) AS players, (SELECT count(*) FROM reports) AS reports,
      (SELECT count(*) FROM report_tags) AS report_tags, (SELECT count(*) FROM report_chunks) AS report_chunks,
      (SELECT count(*) FROM text_chunks) AS text_chunks, (SELECT count(*) FROM text_chunks WHERE embedding IS NULL) AS pending_embeddings,
      pg_size_pretty(pg_database_size(current_database())) AS db_size`);
    step(`done: ${JSON.stringify(s)}`);
  } catch (e) {
    console.error('Synth failed:', e.message);
    process.exitCode = 1;
  } finally {
    await c.query('SET session_replication_role = origin').catch(() => {});
    c.release();
    await pool.end();
  }
})();
