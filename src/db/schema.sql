-- Sporto POC: football player scouting reports

CREATE TABLE IF NOT EXISTS scouts (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  gender             TEXT,
  date_of_birth      DATE,
  year_of_birth      INTEGER,
  age_group          INTEGER,            -- birth-year cohort, e.g. 2012 (sheet: PlayerAgeGroup)
  jersey_number      INTEGER,
  location           TEXT,               -- city the player is from / plays in
  position           TEXT,
  secondary_position TEXT,
  strong_foot        TEXT,
  team_id            INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  mother_height      TEXT,               -- ranges such as '161-170'
  father_height      TEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matches (
  id            SERIAL PRIMARY KEY,
  event         TEXT NOT NULL,           -- e.g. 'Match - U12 (Top division)'
  match_date    DATE,
  match_time    TIME,
  location      TEXT,
  age_group     TEXT,
  game_format   TEXT,                    -- '8:8', '11:11'
  home_team_id  INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  away_team_id  INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id                       SERIAL PRIMARY KEY,
  player_id                INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id                 INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  scout_id                 INTEGER REFERENCES scouts(id) ON DELETE SET NULL,
  report_date              DATE,
  stage_of_growth          TEXT,
  height_now               TEXT,
  physical                 TEXT,
  mental                   TEXT,
  technical                TEXT,
  tactical                 TEXT,
  deadball                 TEXT,
  x_factor                 TEXT,
  score_physical           SMALLINT CHECK (score_physical  BETWEEN 0 AND 10),
  score_mental             SMALLINT CHECK (score_mental    BETWEEN 0 AND 10),
  score_technical          SMALLINT CHECK (score_technical BETWEEN 0 AND 10),
  score_tactical           SMALLINT CHECK (score_tactical  BETWEEN 0 AND 10),
  score_deadball           SMALLINT CHECK (score_deadball  BETWEEN 0 AND 10),
  score_x_factor           SMALLINT CHECK (score_x_factor  BETWEEN 0 AND 10),
  overall_score            SMALLINT CHECK (overall_score           BETWEEN 0 AND 10),
  overall_potential_score  SMALLINT CHECK (overall_potential_score BETWEEN 0 AND 10),
  overall_comment          TEXT,
  recommendation           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_players_team      ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_position  ON players(position);
CREATE INDEX IF NOT EXISTS idx_matches_home      ON matches(home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away      ON matches(away_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_date      ON matches(match_date);
CREATE INDEX IF NOT EXISTS idx_reports_player    ON reports(player_id);
CREATE INDEX IF NOT EXISTS idx_reports_match     ON reports(match_id);
CREATE INDEX IF NOT EXISTS idx_reports_scout     ON reports(scout_id);
CREATE INDEX IF NOT EXISTS idx_reports_date      ON reports(report_date);
CREATE INDEX IF NOT EXISTS idx_reports_reco      ON reports(recommendation);
