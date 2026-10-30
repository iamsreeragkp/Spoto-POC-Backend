// Loads data/Reports_Players_Test_English.xlsx into the database (idempotent: truncates first).
const path = require('path');
const XLSX = require('xlsx');
const pool = require('../src/db/pool');

const FILE = process.argv[2] || path.join(__dirname, '../data/Reports_Players_Test_English.xlsx');

const str = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).replace(/\r\n/g, '\n').trim());
const int = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Math.round(Number(v)));

// Excel serial date -> 'YYYY-MM-DD'
const date = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};

// Excel day fraction -> 'HH:MM:SS'
const time = (v) => {
  if (typeof v !== 'number') return str(v);
  const s = Math.round((v % 1) * 86400);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

(async () => {
  const client = await pool.connect();
  try {
    const wb = XLSX.readFile(FILE);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    console.log(`Read ${rows.length} rows from ${path.basename(FILE)}`);

    await client.query('BEGIN');
    await client.query('TRUNCATE reports, matches, players, teams, scouts RESTART IDENTITY CASCADE');

    const cache = { teams: new Map(), scouts: new Map(), players: new Map(), matches: new Map() };
    const upsertNamed = async (table, name) => {
      name = str(name);
      if (!name) return null;
      if (cache[table].has(name)) return cache[table].get(name);
      const { rows } = await client.query(
        `INSERT INTO ${table}(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
      cache[table].set(name, rows[0].id);
      return rows[0].id;
    };

    let reports = 0;
    for (const r of rows) {
      if (!str(r.name)) continue;
      const teamId = await upsertNamed('teams', r.team);
      const homeId = await upsertNamed('teams', r.homeTeam);
      const awayId = await upsertNamed('teams', r.awayTeam);
      const scoutId = await upsertNamed('scouts', r.scoutName);

      const pname = str(r.name);
      let playerId = cache.players.get(pname);
      if (!playerId) {
        const { rows: p } = await client.query(
          `INSERT INTO players(name, gender, date_of_birth, year_of_birth, age_group, jersey_number, location,
             position, secondary_position, strong_foot, team_id, mother_height, father_height, notes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
          [pname, str(r.gender), date(r.dateOfBirth), int(r.yearOfBirth), int(r.PlayerAgeGroup), int(r.jerseyNumber),
           str(r.playerLocation), str(r.playerPosition), str(r['Secondary Position']), str(r['Strong Foot']), teamId,
           str(r["Mother's Height"]), str(r["Father's Height"]), str(r.notes)]);
        playerId = p[0].id;
        cache.players.set(pname, playerId);
      }

      const mDate = date(r.date), mTime = time(r.time), event = str(r.event);
      const mKey = [event, mDate, mTime, homeId, awayId].join('|');
      let matchId = cache.matches.get(mKey);
      if (!matchId && event) {
        const { rows: m } = await client.query(
          `INSERT INTO matches(event, match_date, match_time, location, age_group, game_format, home_team_id, away_team_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [event, mDate, mTime, str(r.matchLocation), str(r.matchAgeGroup), str(r.gameFormat), homeId, awayId]);
        matchId = m[0].id;
        cache.matches.set(mKey, matchId);
      }

      await client.query(
        `INSERT INTO reports(player_id, match_id, scout_id, report_date, stage_of_growth, height_now,
           physical, mental, technical, tactical, deadball, x_factor,
           score_physical, score_mental, score_technical, score_tactical, score_deadball, score_x_factor,
           overall_score, overall_potential_score, overall_comment, recommendation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [playerId, matchId || null, scoutId, date(r.reportDate), str(r['Stage of Growth']), str(r['Height Now']),
         str(r.Physical), str(r.Mental), str(r.Technical), str(r.Tactical), str(r.Deadball), str(r['X-factor']),
         int(r['Score Physical']), int(r['Score Mental']), int(r['Score Technical']), int(r['Score Tactical']),
         int(r['Score Deadball']), int(r['Score X-factor']),
         int(r.overallScore), int(r.overallPotentialScore), str(r.overallComment), str(r.recommendation)]);
      reports++;
    }

    await client.query('COMMIT');
    console.log(`Seeded: ${cache.players.size} players, ${cache.teams.size} teams, ${cache.scouts.size} scouts, ${cache.matches.size} matches, ${reports} reports.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
