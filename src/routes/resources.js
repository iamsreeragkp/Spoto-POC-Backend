const pool = require('../db/pool');
const { crudRouter, HttpError, wrap, parseId } = require('../utils/crud');

// ---------- scouts ----------
const scouts = crudRouter({
  table: 'scouts',
  columns: ['name'],
  required: ['name'],
  select: `SELECT t.*, (SELECT COUNT(*)::int FROM reports r WHERE r.scout_id = t.id) AS report_count FROM scouts t`,
  filters: { name: { sql: 't.name', op: 'ilike' } },
  search: ['t.name'],
  sort: { name: 't.name', id: 't.id', reportCount: 'report_count' },
  defaultSort: 't.name ASC',
});

// ---------- teams ----------
const teams = crudRouter({
  table: 'teams',
  columns: ['name'],
  required: ['name'],
  select: `SELECT t.*, (SELECT COUNT(*)::int FROM players p WHERE p.team_id = t.id) AS player_count FROM teams t`,
  filters: { name: { sql: 't.name', op: 'ilike' } },
  search: ['t.name'],
  sort: { name: 't.name', id: 't.id', playerCount: 'player_count' },
  defaultSort: 't.name ASC',
});

// ---------- players ----------
const players = crudRouter({
  table: 'players',
  columns: ['name', 'gender', 'date_of_birth', 'year_of_birth', 'age_group', 'jersey_number', 'location', 'position',
    'secondary_position', 'strong_foot', 'team_id', 'mother_height', 'father_height', 'notes'],
  required: ['name'],
  select: `SELECT t.*, tm.name AS team_name,
             (SELECT COUNT(*)::int FROM reports r WHERE r.player_id = t.id) AS report_count,
             (SELECT ROUND(AVG(r.overall_score), 2) FROM reports r WHERE r.player_id = t.id) AS avg_overall_score,
             (SELECT ROUND(AVG(r.overall_potential_score), 2) FROM reports r WHERE r.player_id = t.id) AS avg_potential_score
           FROM players t LEFT JOIN teams tm ON tm.id = t.team_id`,
  filters: {
    name: { sql: 't.name', op: 'ilike' },
    gender: { sql: 't.gender' },
    ageGroup: { sql: 't.age_group' },
    position: { sql: 't.position', op: 'ilike' },
    secondaryPosition: { sql: 't.secondary_position', op: 'ilike' },
    strongFoot: { sql: 't.strong_foot' },
    location: { sql: 't.location', op: 'ilike' },
    teamId: { sql: 't.team_id' },
    team: { sql: 'tm.name', op: 'ilike' },
    jerseyNumber: { sql: 't.jersey_number' },
  },
  search: ['t.name', 't.position', 't.location', 'tm.name'],
  sort: {
    id: 't.id', name: 't.name', ageGroup: 't.age_group', position: 't.position', team: 'tm.name',
    location: 't.location', jerseyNumber: 't.jersey_number', reportCount: 'report_count', avgOverallScore: 'avg_overall_score',
  },
  defaultSort: 't.id ASC',
});

// sub-resources of a player / team / scout
players.get('/:id/reports', wrap(async (req, res) => {
  const { rows } = await pool.query(`${reportSelect} WHERE t.player_id = $1 ORDER BY t.report_date DESC, t.id DESC`, [parseId(req.params.id)]);
  res.json({ data: rows });
}));

// ---------- matches ----------
const matches = crudRouter({
  table: 'matches',
  columns: ['event', 'match_date', 'match_time', 'location', 'age_group', 'game_format', 'home_team_id', 'away_team_id'],
  required: ['event'],
  select: `SELECT t.*, to_char(t.match_date, 'YYYY-MM-DD') AS match_date, ht.name AS home_team_name, at.name AS away_team_name,
             (SELECT COUNT(*)::int FROM reports r WHERE r.match_id = t.id) AS report_count
           FROM matches t LEFT JOIN teams ht ON ht.id = t.home_team_id LEFT JOIN teams at ON at.id = t.away_team_id`,
  filters: {
    event: { sql: 't.event', op: 'ilike' },
    gameFormat: { sql: 't.game_format' },
    homeTeamId: { sql: 't.home_team_id' },
    awayTeamId: { sql: 't.away_team_id' },
    team: { sql: "(ht.name || ' ' || COALESCE(at.name, ''))", op: 'ilike' },
    dateFrom: { sql: 't.match_date', op: 'gte' },
    dateTo: { sql: 't.match_date', op: 'lte' },
  },
  search: ['t.event', 'ht.name', 'at.name', 't.location'],
  sort: { id: 't.id', date: 't.match_date', event: 't.event', reportCount: 'report_count' },
  defaultSort: 't.match_date DESC NULLS LAST, t.id DESC',
});

// ---------- reports ----------
// Explicit columns: reports also holds internal full-text vectors (tsv_*) for the chatbot, which the API must not return
const reportSelect = `SELECT t.id, t.player_id, t.match_id, t.scout_id, to_char(t.report_date, 'YYYY-MM-DD') AS report_date,
    t.stage_of_growth, t.height_now, t.height_now_mid, t.physical, t.mental, t.technical, t.tactical, t.deadball, t.x_factor,
    t.score_physical, t.score_mental, t.score_technical, t.score_tactical, t.score_deadball, t.score_x_factor,
    t.overall_score, t.overall_potential_score, t.overall_comment, t.recommendation, t.created_at, t.updated_at,
    p.name AS player_name, p.age_group AS player_age_group, p.position AS player_position,
    s.name AS scout_name, m.event, to_char(m.match_date, 'YYYY-MM-DD') AS match_date,
    ht.name AS home_team, at.name AS away_team
  FROM reports t
  JOIN players p ON p.id = t.player_id
  LEFT JOIN scouts s ON s.id = t.scout_id
  LEFT JOIN matches m ON m.id = t.match_id
  LEFT JOIN teams ht ON ht.id = m.home_team_id
  LEFT JOIN teams at ON at.id = m.away_team_id`;

const reports = crudRouter({
  table: 'reports',
  columns: ['player_id', 'match_id', 'scout_id', 'report_date', 'stage_of_growth', 'height_now', 'physical', 'mental',
    'technical', 'tactical', 'deadball', 'x_factor', 'score_physical', 'score_mental', 'score_technical', 'score_tactical',
    'score_deadball', 'score_x_factor', 'overall_score', 'overall_potential_score', 'overall_comment', 'recommendation'],
  required: ['player_id'],
  select: reportSelect,
  filters: {
    playerId: { sql: 't.player_id' },
    player: { sql: 'p.name', op: 'ilike' },
    scoutId: { sql: 't.scout_id' },
    scout: { sql: 's.name', op: 'ilike' },
    matchId: { sql: 't.match_id' },
    recommendation: { sql: 't.recommendation', op: 'ilike' },
    stageOfGrowth: { sql: 't.stage_of_growth' },
    position: { sql: 'p.position', op: 'ilike' },
    ageGroup: { sql: 'p.age_group' },
    overallScore: { sql: 't.overall_score' },
    minOverallScore: { sql: 't.overall_score', op: 'gte' },
    maxOverallScore: { sql: 't.overall_score', op: 'lte' },
    minPotentialScore: { sql: 't.overall_potential_score', op: 'gte' },
    dateFrom: { sql: 't.report_date', op: 'gte' },
    dateTo: { sql: 't.report_date', op: 'lte' },
  },
  search: ['p.name', 's.name', 't.overall_comment', 't.recommendation', 'm.event', 't.physical', 't.mental', 't.technical', 't.tactical', 't.x_factor'],
  sort: {
    id: 't.id', date: 't.report_date', player: 'p.name', scout: 's.name',
    overallScore: 't.overall_score', potentialScore: 't.overall_potential_score',
  },
  defaultSort: 't.report_date DESC NULLS LAST, t.id DESC',
});

scouts.get('/:id/reports', wrap(async (req, res) => {
  const { rows } = await pool.query(`${reportSelect} WHERE t.scout_id = $1 ORDER BY t.report_date DESC, t.id DESC`, [parseId(req.params.id)]);
  res.json({ data: rows });
}));

teams.get('/:id/players', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM players WHERE team_id = $1 ORDER BY name', [parseId(req.params.id)]);
  res.json({ data: rows });
}));

matches.get('/:id/reports', wrap(async (req, res) => {
  const { rows } = await pool.query(`${reportSelect} WHERE t.match_id = $1 ORDER BY t.id`, [parseId(req.params.id)]);
  res.json({ data: rows });
}));

// Extra: GET /api/players/:id returns the player; GET /api/players/:id/reports returns its reports.
// Summary stats, handy for the later chatbot stage.
const stats = require('express').Router();
stats.get('/', wrap(async (req, res) => {
  const q = async (sql) => (await pool.query(sql)).rows;
  const [counts] = await q(`SELECT (SELECT COUNT(*)::int FROM players) AS players, (SELECT COUNT(*)::int FROM reports) AS reports,
    (SELECT COUNT(*)::int FROM matches) AS matches, (SELECT COUNT(*)::int FROM teams) AS teams, (SELECT COUNT(*)::int FROM scouts) AS scouts`);
  res.json({
    data: {
      counts,
      byRecommendation: await q('SELECT recommendation, COUNT(*)::int AS count FROM reports GROUP BY 1 ORDER BY 2 DESC'),
      byOverallScore: await q('SELECT overall_score, COUNT(*)::int AS count FROM reports GROUP BY 1 ORDER BY 1'),
      byPosition: await q('SELECT position, COUNT(*)::int AS count FROM players GROUP BY 1 ORDER BY 2 DESC'),
      byScout: await q('SELECT s.name AS scout, COUNT(*)::int AS reports FROM reports r JOIN scouts s ON s.id = r.scout_id GROUP BY 1 ORDER BY 2 DESC'),
    },
  });
}));

module.exports = { scouts, teams, players, matches, reports, stats, HttpError };
