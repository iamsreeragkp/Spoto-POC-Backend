// Appends assessment or feedback reports from an Excel export to the database (never deletes anything).
//   node scripts/import-reports.js <file.xlsx> --type assessment|feedback [--dry-run]
// Layouts (first sheet):
//   assessment: Player Name, Team, Age Group, Gender, Position, Jersey No, Scout, Report Date, Recommendation, Home Team,
//               Away Team, Date of Match, Time of Match, Location, Event, Format, Age Group Of Match, Competition Level,
//               Overall/Technical/Tactical/Physical Score + Comment
//   feedback:   Player Name, Team, Age Group, Gender, Position, Jersey No, Coach, Report Date, Start Date, End Date,
//               Overall/Physical/Technical/Psychological/Behavioral/Tactical Score + Comment
// A report that is already in the database (same player, author, date, type and overall comment) is skipped, so the
// import can be re-run safely. Players, teams, scouts/coaches and matches are created when missing.
const path = require('path');
const XLSX = require('xlsx');

const str = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).replace(/\r\n/g, '\n').trim());
const int = (v) => (str(v) === null || isNaN(Number(v)) ? null : Math.round(Number(v)));
/** 3.5 stays 3.5; empty or not a number -> null; outside 0-10 -> null (the database only accepts 0-10) */
const score = (v) => {
  if (str(v) === null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 10) / 10 : null;
};
/** 'dd/mm/yyyy' (as in the exports), 'yyyy-mm-dd' or an Excel serial number -> 'YYYY-MM-DD'; anything else -> null */
function date(v) {
  if (str(v) === null) return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** '16:13' -> '16:13:00' */
const time = (v) => {
  if (typeof v === 'number') {
    const sec = Math.round((v % 1) * 86400);
    return `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:00`;
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(str(v) || '');
  return m ? `${m[1].padStart(2, '0')}:${m[2]}:00` : null;
};

// Same spelling as the existing data ("Left centre-back", "Right-back"); other positions are kept as written
const POSITIONS = {
  'left center back': 'Left centre-back', 'left centre back': 'Left centre-back', 'left centre-back': 'Left centre-back',
  'right center back': 'Right centre-back', 'right centre back': 'Right centre-back', 'right centre-back': 'Right centre-back',
  'center back': 'Centre-back', 'centre back': 'Centre-back',
  'left back': 'Left-back', 'right back': 'Right-back', 'left winger': 'Left winger', 'right winger': 'Right winger',
  goalkeeper: 'Goalkeeper',
};
const position = (v) => { const s = str(v); return s ? (POSITIONS[s.toLowerCase().replace(/\s+/g, ' ')] || s) : null; };
const gender = (v) => { const s = str(v); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null; };

/** One spreadsheet row -> { player, author, match, report } (no database access; unit-tested) */
function mapRow(r, type) {
  const player = {
    name: str(r['Player Name']), team: str(r.Team), age_group_label: str(r['Age Group']), gender: gender(r.Gender),
    position: position(r.Position), jersey_number: int(r['Jersey No']),
  };
  const report = {
    report_type: type, report_date: date(r['Report Date']),
    overall_score: score(r['Overall Score']), overall_comment: str(r['Overall Comment']),
    score_physical: score(r['Physical Score']), physical_comment: str(r['Physical Comment']),
    score_technical: score(r['Technical Score']), technical_comment: str(r['Technical Comment']),
    score_tactical: score(r['Tactical Score']), tactical_comment: str(r['Tactical Comment']),
  };
  let match = null;
  if (type === 'assessment') {
    Object.assign(report, { recommendation: str(r.Recommendation), competition_level: str(r['Competition Level']) });
    const home = str(r['Home Team']), away = str(r['Away Team']);
    if (home || away || str(r.Event)) {
      match = {
        event: str(r.Event) || [home, away].filter(Boolean).join(' vs ') || 'Match', match_date: date(r['Date of Match']),
        match_time: time(r['Time of Match']), location: str(r.Location), age_group: str(r['Age Group Of Match']),
        game_format: str(r.Format), home, away,
      };
    }
  } else {
    Object.assign(report, {
      period_start: date(r['Start Date']), period_end: date(r['End Date']),
      score_mental: score(r['Psychological Score']), mental_comment: str(r['Psychological Comment']),
      score_behavioral: score(r['Behavioral Score']), behavioral_comment: str(r['Behavioral Comment']),
    });
  }
  return { player, author: str(type === 'assessment' ? r.Scout : r.Coach), match, report };
}

async function importFile(pool, file, type, { dryRun = false } = {}) {
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  const client = await pool.connect();
  const stats = { rows: rows.length, added: 0, skipped: 0, players: 0 };
  try {
    await client.query('BEGIN');
    const named = async (table, name) => {
      if (!name) return null;
      const { rows: x } = await client.query(
        `INSERT INTO ${table}(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
      return x[0].id;
    };
    for (const r of rows) {
      const { player, author, match, report } = mapRow(r, type);
      if (!player.name) { stats.skipped++; continue; }
      const teamId = await named('teams', player.team);
      const authorId = await named('scouts', author);
      let { rows: p } = await client.query('SELECT id FROM players WHERE name = $1', [player.name]);
      if (!p.length) {
        p = (await client.query(
          `INSERT INTO players(name, gender, age_group_label, jersey_number, position, team_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [player.name, player.gender, player.age_group_label, player.jersey_number, player.position, teamId])).rows;
        stats.players++;
      } else {
        // fill only what is missing on an existing player
        await client.query(
          `UPDATE players SET gender = coalesce(gender, $2), age_group_label = coalesce(age_group_label, $3), jersey_number = coalesce(jersey_number, $4),
             position = coalesce(position, $5), team_id = coalesce(team_id, $6) WHERE id = $1`,
          [p[0].id, player.gender, player.age_group_label, player.jersey_number, player.position, teamId]);
      }
      const playerId = p[0].id;
      const dup = await client.query(
        `SELECT 1 FROM reports WHERE player_id = $1 AND scout_id IS NOT DISTINCT FROM $2 AND report_date IS NOT DISTINCT FROM $3
           AND report_type = $4 AND overall_comment IS NOT DISTINCT FROM $5 AND technical_comment IS NOT DISTINCT FROM $6 LIMIT 1`,
        [playerId, authorId, report.report_date, type, report.overall_comment, report.technical_comment]);
      if (dup.rowCount) { stats.skipped++; continue; }
      let matchId = null;
      if (match) {
        const homeId = await named('teams', match.home), awayId = await named('teams', match.away);
        const found = await client.query(
          `SELECT id FROM matches WHERE event = $1 AND match_date IS NOT DISTINCT FROM $2 AND home_team_id IS NOT DISTINCT FROM $3
             AND away_team_id IS NOT DISTINCT FROM $4 LIMIT 1`, [match.event, match.match_date, homeId, awayId]);
        matchId = found.rowCount ? found.rows[0].id : (await client.query(
          `INSERT INTO matches(event, match_date, match_time, location, age_group, game_format, home_team_id, away_team_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [match.event, match.match_date, match.match_time, match.location, match.age_group, match.game_format, homeId, awayId])).rows[0].id;
      }
      const cols = { player_id: playerId, scout_id: authorId, match_id: matchId, ...report };
      const keys = Object.keys(cols);
      await client.query(`INSERT INTO reports(${keys.join(', ')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => cols[k]));
      stats.added++;
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return stats;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const file = process.argv[2];
  const ti = process.argv.indexOf('--type');
  const type = ti > -1 ? process.argv[ti + 1] : null;
  if (!file || !['assessment', 'feedback'].includes(type)) {
    console.error('Usage: node scripts/import-reports.js <file.xlsx> --type assessment|feedback [--dry-run]');
    process.exit(1);
  }
  const pool = require('../src/db/pool');
  importFile(pool, file, type, { dryRun: process.argv.includes('--dry-run') })
    .then((s) => console.log(`${path.basename(file)} (${type}): ${s.rows} rows, ${s.added} reports added, ${s.skipped} skipped, ${s.players} new players${process.argv.includes('--dry-run') ? ' (dry run, nothing saved)' : ''}`))
    .catch((e) => { console.error('Import failed:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { mapRow, importFile, date, score, position, gender };
