// Fills fields that are empty in the Excel sheet with generated sample data (POC only):
//   players.date_of_birth / year_of_birth  (consistent with the player's age_group birth year)
//   matches.location                        (home team's player city if known, else a Danish city)
// Only touches NULL values, so it is safe to re-run.
const pool = require('../src/db/pool');

const CITIES = ['Aarhus', 'Aalborg', 'Odense', 'Copenhagen', 'Esbjerg', 'Randers', 'Kolding', 'Horsens', 'Vejle',
  'Roskilde', 'Herning', 'Silkeborg', 'Næstved', 'Fredericia', 'Viborg', 'Holstebro', 'Slagelse', 'Hillerød'];

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deterministic per-player day offset (0-364) so results are stable between runs.
    const dob = await client.query(`
      UPDATE players
      SET date_of_birth = make_date(age_group, 1, 1) + (abs(hashtext(name)) % 365),
          updated_at = now()
      WHERE date_of_birth IS NULL AND age_group IS NOT NULL`);
    await client.query(`
      UPDATE players SET year_of_birth = EXTRACT(YEAR FROM date_of_birth)::int, updated_at = now()
      WHERE year_of_birth IS NULL AND date_of_birth IS NOT NULL`);

    const home = await client.query(`
      UPDATE matches m
      SET location = sub.location, updated_at = now()
      FROM (SELECT team_id, MIN(location) AS location FROM players WHERE location IS NOT NULL GROUP BY team_id) sub
      WHERE m.location IS NULL AND sub.team_id = m.home_team_id`);
    const rest = await client.query(`
      UPDATE matches
      SET location = (ARRAY[${CITIES.map((c) => `'${c}'`).join(',')}])[1 + abs(hashtext(id::text)) % ${CITIES.length}],
          updated_at = now()
      WHERE location IS NULL`);

    // Age group is encoded in the event name, e.g. 'Match - U12 (Top division)' -> 'U12'
    const age = await client.query(`
      UPDATE matches SET age_group = substring(event from '\\mU[0-9]{1,2}\\M'), updated_at = now()
      WHERE age_group IS NULL AND substring(event from '\\mU[0-9]{1,2}\\M') IS NOT NULL`);

    // Still unknown: infer from the reported player's birth year and the football season (starts in July),
    // e.g. born 2012, match in 2024-05 -> season 2023 -> U12. Matches the event-name label for ~94% of known matches.
    const inferred = await client.query(`
      UPDATE matches m SET age_group = 'U' || sub.u, updated_at = now()
      FROM (
        SELECT r.match_id, MIN((CASE WHEN extract(month FROM mm.match_date) >= 7 THEN extract(year FROM mm.match_date)
                                     ELSE extract(year FROM mm.match_date) - 1 END)::int - p.age_group + 1) AS u
        FROM reports r JOIN players p ON p.id = r.player_id JOIN matches mm ON mm.id = r.match_id
        WHERE mm.age_group IS NULL AND mm.match_date IS NOT NULL AND p.age_group IS NOT NULL
        GROUP BY r.match_id
      ) sub
      WHERE m.id = sub.match_id AND sub.u BETWEEN 8 AND 19`);

    await client.query('COMMIT');
    console.log(`Filled ${age.rowCount} match age groups from event names, ${inferred.rowCount} inferred. Filled DOB/year for ${dob.rowCount} players; match location: ${home.rowCount} from home-team city, ${rest.rowCount} generated.`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('fill-gaps failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
