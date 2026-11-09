-- Chatbot support: derived/searchable data kept in sync by triggers.
-- Applied by scripts/migrate.js after schema.sql (idempotent).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- '181-190' -> 185.5, '185' -> 185, anything else -> NULL
CREATE OR REPLACE FUNCTION height_mid(txt TEXT) RETURNS NUMERIC AS $$
DECLARE m TEXT[];
BEGIN
  IF txt IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(txt, '^\s*(\d+)\s*-\s*(\d+)\s*$');
  IF m IS NOT NULL THEN RETURN (m[1]::numeric + m[2]::numeric) / 2; END IF;
  m := regexp_match(txt, '^\s*(\d+)\s*$');
  IF m IS NOT NULL THEN RETURN m[1]::numeric; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE players ADD COLUMN IF NOT EXISTS father_height_mid NUMERIC(5,1);
ALTER TABLE players ADD COLUMN IF NOT EXISTS mother_height_mid NUMERIC(5,1);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS height_now_mid NUMERIC(5,1);

CREATE OR REPLACE FUNCTION players_derive() RETURNS trigger AS $$
BEGIN
  NEW.father_height_mid := height_mid(NEW.father_height);
  NEW.mother_height_mid := height_mid(NEW.mother_height);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_players_derive ON players;
CREATE TRIGGER trg_players_derive BEFORE INSERT OR UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION players_derive();

CREATE OR REPLACE FUNCTION reports_derive() RETURNS trigger AS $$
BEGIN
  NEW.height_now_mid := height_mid(NEW.height_now);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_reports_derive ON reports;
CREATE TRIGGER trg_reports_derive BEFORE INSERT OR UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION reports_derive();

-- One row per (report, category, tag) split out of the comma-separated text columns
CREATE TABLE IF NOT EXISTS report_tags (
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (report_id, category, tag)
);
CREATE INDEX IF NOT EXISTS idx_report_tags_lookup ON report_tags(category, tag);
CREATE INDEX IF NOT EXISTS idx_report_tags_player ON report_tags(player_id);

CREATE OR REPLACE FUNCTION sync_report_tags() RETURNS trigger AS $$
BEGIN
  DELETE FROM report_tags WHERE report_id = NEW.id;
  INSERT INTO report_tags(report_id, player_id, category, tag)
  SELECT DISTINCT NEW.id, NEW.player_id, c.category, btrim(t)
  FROM (VALUES ('physical', NEW.physical), ('mental', NEW.mental), ('technical', NEW.technical),
               ('tactical', NEW.tactical), ('deadball', NEW.deadball)) AS c(category, txt),
       LATERAL unnest(string_to_array(c.txt, ',')) AS t
  WHERE btrim(t) <> '' AND btrim(t) NOT ILIKE 'Please add further details%';
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_reports_tags ON reports;
CREATE TRIGGER trg_reports_tags AFTER INSERT OR UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION sync_report_tags();

-- Geo cache: geocoded places and driving minutes between places
CREATE TABLE IF NOT EXISTS places (
  name        TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drive_time (
  from_place  TEXT NOT NULL,
  to_place    TEXT NOT NULL,
  minutes     NUMERIC(6,1) NOT NULL,
  source      TEXT NOT NULL,            -- 'osrm' (real routing) or 'estimate' (straight line x 1.3 @ 70 km/h)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_place, to_place)
);

-- player_latest (one row per player, latest report) is a maintained TABLE defined in chat_v2_schema.sql.
