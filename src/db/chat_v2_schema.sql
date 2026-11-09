-- Chatbot phase 2: scale (1M+ reports), full-text search, vector search, conversation memory, read-only role.
-- Applied by scripts/migrate.js after chat_schema.sql. Idempotent.

CREATE EXTENSION IF NOT EXISTS vector;

-- Phase-1 trigram indexes on report text are replaced by the full-text index below
DROP INDEX IF EXISTS idx_reports_xfactor_trgm;
DROP INDEX IF EXISTS idx_reports_comment_trgm;
DROP INDEX IF EXISTS idx_reports_technical_trgm;

-- =====================================================================================================
-- 1. Full-text search over report text: one unweighted vector per field (x-factor, comment, tags), each with
--    its own GIN index, so field-specific searches are exact index matches (no costly re-check of rows).
-- =====================================================================================================
DROP INDEX IF EXISTS idx_reports_search_tsv;
-- one ALTER = one table rewrite
ALTER TABLE reports
  DROP COLUMN IF EXISTS search_tsv,
  ADD COLUMN IF NOT EXISTS tsv_x tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(x_factor, ''))) STORED,
  ADD COLUMN IF NOT EXISTS tsv_c tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(overall_comment, ''))) STORED,
  ADD COLUMN IF NOT EXISTS tsv_t tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig,
    coalesce(physical, '') || ' , ' || coalesce(mental, '') || ' , ' || coalesce(technical, '') || ' , ' ||
    coalesce(tactical, '') || ' , ' || coalesce(deadball, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_reports_tsv_x ON reports USING gin (tsv_x);
CREATE INDEX IF NOT EXISTS idx_reports_tsv_c ON reports USING gin (tsv_c);
CREATE INDEX IF NOT EXISTS idx_reports_tsv_t ON reports USING gin (tsv_t);

-- tsvector aggregate (concatenation) used to build one vector over all of a player's reports
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'tsvector_agg') THEN
    CREATE AGGREGATE tsvector_agg(tsvector) (SFUNC = tsvector_concat, STYPE = tsvector, INITCOND = '');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_reports_player_date ON reports (player_id, report_date DESC NULLS LAST, id DESC);
-- Covering index for report-level statistics ("reports per scout / per month", "average score given in 2025"):
-- index-only scans instead of reading the wide reports table.
CREATE INDEX IF NOT EXISTS idx_reports_facts ON reports (report_date)
  INCLUDE (scout_id, player_id, overall_score, overall_potential_score, stage_of_growth, recommendation);

-- =====================================================================================================
-- 2. player_latest: one row per player with their latest report + history stats.
--    Was a DISTINCT ON view (recomputed on every query = too slow at 1M reports); now a table kept in
--    sync by triggers. player_latest_source is the single definition used for both refresh paths.
-- =====================================================================================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'player_latest') THEN
    DROP VIEW player_latest;
  END IF;
END $$;

-- source views are dropped/recreated every migration (only functions and the DO block below use them)
DROP VIEW IF EXISTS player_latest_source, player_text_source;
CREATE VIEW player_latest_source AS
SELECT DISTINCT ON (p.id)
  p.id AS player_id, p.name AS player_name, p.gender, p.date_of_birth, p.year_of_birth, p.age_group,
  p.jersey_number, p.location, p.position, p.secondary_position, p.strong_foot,
  p.team_id, tm.name AS team_name, p.mother_height_mid, p.father_height_mid,
  r.id AS report_id, r.report_date,
  extract(year FROM r.report_date)::int AS report_year, to_char(r.report_date, 'YYYY-MM') AS report_month,
  r.stage_of_growth, r.height_now, r.height_now_mid, r.x_factor,
  r.score_physical, r.score_mental, r.score_technical, r.score_tactical, r.score_deadball, r.score_x_factor,
  r.overall_score, r.overall_potential_score, r.recommendation, r.scout_id, s.name AS scout_name,
  coalesce(st.report_count, 0) AS report_count, st.first_report_date, st.first_overall_score,
  CASE WHEN st.report_count > 1 THEN r.overall_score - st.first_overall_score END AS score_change
FROM players p
LEFT JOIN teams tm ON tm.id = p.team_id
LEFT JOIN reports r ON r.player_id = p.id
LEFT JOIN scouts s ON s.id = r.scout_id
LEFT JOIN (
  SELECT player_id, count(*)::int AS report_count, min(report_date) AS first_report_date,
         (array_agg(overall_score ORDER BY report_date ASC NULLS LAST, id ASC) FILTER (WHERE overall_score IS NOT NULL))[1] AS first_overall_score
  FROM reports GROUP BY player_id
) st ON st.player_id = p.id
ORDER BY p.id, r.report_date DESC NULLS LAST, r.id DESC;

-- Full-text vectors per player, kept in a separate table so player_latest stays narrow (and cached):
-- tsv_* = the latest report, tsv_all_* = all of the player's reports together.
CREATE VIEW player_text_source AS
SELECT p.id AS player_id, lr.tsv_x, lr.tsv_c, lr.tsv_t, st.tsv_all_x, st.tsv_all_c, st.tsv_all_t
FROM players p
LEFT JOIN LATERAL (
  SELECT r.tsv_x, r.tsv_c, r.tsv_t FROM reports r WHERE r.player_id = p.id
  ORDER BY r.report_date DESC NULLS LAST, r.id DESC LIMIT 1
) lr ON true
LEFT JOIN (
  SELECT player_id, tsvector_agg(tsv_x) AS tsv_all_x, tsvector_agg(tsv_c) AS tsv_all_c, tsvector_agg(tsv_t) AS tsv_all_t
  FROM reports GROUP BY player_id
) st ON st.player_id = p.id;

-- (Re)create each table when it is missing or its columns no longer match its source view
DO $$
DECLARE want TEXT; have TEXT; t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['player_latest', 'player_text'] LOOP
    SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) INTO want
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t || '_source';
    SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) INTO have
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t;
    IF have IS DISTINCT FROM want THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', t);
      EXECUTE format('CREATE TABLE %I AS SELECT * FROM %I WITH NO DATA', t, t || '_source');
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (player_id)', t);
      EXECUTE format('INSERT INTO %I SELECT * FROM %I', t, t || '_source');
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pl_report      ON player_latest (report_id);
CREATE INDEX IF NOT EXISTS idx_pl_position           ON player_latest (position);
CREATE INDEX IF NOT EXISTS idx_pl_age_group          ON player_latest (age_group);
CREATE INDEX IF NOT EXISTS idx_pl_location           ON player_latest (location);
CREATE INDEX IF NOT EXISTS idx_pl_team               ON player_latest (team_id);
CREATE INDEX IF NOT EXISTS idx_pl_scout              ON player_latest (scout_id);
CREATE INDEX IF NOT EXISTS idx_pl_score              ON player_latest (overall_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_pl_name_lower         ON player_latest (lower(player_name));
CREATE INDEX IF NOT EXISTS idx_pt_tsv_x              ON player_text USING gin (tsv_x);
CREATE INDEX IF NOT EXISTS idx_pt_tsv_c              ON player_text USING gin (tsv_c);
CREATE INDEX IF NOT EXISTS idx_pt_tsv_t              ON player_text USING gin (tsv_t);
CREATE INDEX IF NOT EXISTS idx_pt_tsv_all_x          ON player_text USING gin (tsv_all_x);
CREATE INDEX IF NOT EXISTS idx_pt_tsv_all_c          ON player_text USING gin (tsv_all_c);
CREATE INDEX IF NOT EXISTS idx_pt_tsv_all_t          ON player_text USING gin (tsv_all_t);
-- Expression indexes on lower(col): the builder compares text with lower(col) = lower($1); these indexes give the
-- planner statistics for those expressions (otherwise it badly misestimates row counts) and allow index lookups.
CREATE INDEX IF NOT EXISTS idx_pl_lower_position     ON player_latest (lower(position));
CREATE INDEX IF NOT EXISTS idx_pl_lower_stage        ON player_latest (lower(stage_of_growth));
CREATE INDEX IF NOT EXISTS idx_pl_lower_foot         ON player_latest (lower(strong_foot));
CREATE INDEX IF NOT EXISTS idx_pl_lower_reco         ON player_latest (lower(recommendation));
CREATE INDEX IF NOT EXISTS idx_pl_lower_location     ON player_latest (lower(location));
CREATE INDEX IF NOT EXISTS idx_pl_lower_team         ON player_latest (lower(team_name));
CREATE INDEX IF NOT EXISTS idx_pl_lower_scout        ON player_latest (lower(scout_name));
CREATE INDEX IF NOT EXISTS idx_pl_lower_gender       ON player_latest (lower(gender));

-- Covering index: tag lookups ("players with Pace/speed") become index-only scans
CREATE INDEX IF NOT EXISTS idx_report_tags_cover ON report_tags (category, tag) INCLUDE (report_id, player_id);
DROP INDEX IF EXISTS idx_report_tags_lookup;

CREATE OR REPLACE FUNCTION refresh_player_latest(pid INTEGER) RETURNS void AS $$
BEGIN
  DELETE FROM player_latest WHERE player_id = pid;
  INSERT INTO player_latest SELECT * FROM player_latest_source WHERE player_id = pid;
  DELETE FROM player_text WHERE player_id = pid;
  INSERT INTO player_text SELECT * FROM player_text_source WHERE player_id = pid;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION rebuild_player_latest() RETURNS void AS $$
BEGIN
  TRUNCATE player_latest, player_text;
  INSERT INTO player_latest SELECT * FROM player_latest_source;
  INSERT INTO player_text SELECT * FROM player_text_source;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_reports_player_latest() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM refresh_player_latest(NEW.player_id); END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.player_id IS DISTINCT FROM NEW.player_id) THEN
    PERFORM refresh_player_latest(OLD.player_id);
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_reports_latest ON reports;
CREATE TRIGGER trg_reports_latest AFTER INSERT OR UPDATE OR DELETE ON reports
  FOR EACH ROW EXECUTE FUNCTION trg_reports_player_latest();

CREATE OR REPLACE FUNCTION trg_players_player_latest() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM player_latest WHERE player_id = OLD.id; DELETE FROM player_text WHERE player_id = OLD.id;
  ELSE PERFORM refresh_player_latest(NEW.id); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_players_latest ON players;
CREATE TRIGGER trg_players_latest AFTER INSERT OR UPDATE OR DELETE ON players
  FOR EACH ROW EXECUTE FUNCTION trg_players_player_latest();

CREATE OR REPLACE FUNCTION trg_names_player_latest() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'teams' THEN UPDATE player_latest SET team_name = NEW.name WHERE team_id = NEW.id;
  ELSE UPDATE player_latest SET scout_name = NEW.name WHERE scout_id = NEW.id; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_teams_latest ON teams;
CREATE TRIGGER trg_teams_latest AFTER UPDATE OF name ON teams FOR EACH ROW EXECUTE FUNCTION trg_names_player_latest();
DROP TRIGGER IF EXISTS trg_scouts_latest ON scouts;
CREATE TRIGGER trg_scouts_latest AFTER UPDATE OF name ON scouts FOR EACH ROW EXECUTE FUNCTION trg_names_player_latest();

CREATE OR REPLACE FUNCTION trg_truncate_player_latest() RETURNS trigger AS $$
BEGIN TRUNCATE player_latest, player_text; RETURN NULL; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_players_truncate ON players;
CREATE TRIGGER trg_players_truncate AFTER TRUNCATE ON players FOR EACH STATEMENT EXECUTE FUNCTION trg_truncate_player_latest();

-- Report-level facts (one row per report) for "how many reports per scout / per month" style questions
CREATE OR REPLACE VIEW report_facts AS
SELECT r.id AS report_id, r.player_id, p.name AS player_name, p.gender, p.date_of_birth, p.year_of_birth, p.age_group,
  p.jersey_number, p.location, p.position, p.secondary_position, p.strong_foot,
  p.team_id, tm.name AS team_name, p.mother_height_mid, p.father_height_mid,
  r.report_date, extract(year FROM r.report_date)::int AS report_year, to_char(r.report_date, 'YYYY-MM') AS report_month,
  r.stage_of_growth, r.height_now_mid, r.x_factor,
  r.score_physical, r.score_mental, r.score_technical, r.score_tactical, r.score_deadball, r.score_x_factor,
  r.overall_score, r.overall_potential_score, r.recommendation, r.scout_id, s.name AS scout_name,
  r.tsv_x, r.tsv_c, r.tsv_t
FROM reports r
LEFT JOIN players p ON p.id = r.player_id   -- player_id is NOT NULL + FK, so LEFT = INNER; LEFT lets Postgres drop the join when unused
LEFT JOIN teams tm ON tm.id = p.team_id
LEFT JOIN scouts s ON s.id = r.scout_id;

-- Set-based version of sync_report_tags() for bulk loads (triggers disabled)
CREATE OR REPLACE FUNCTION rebuild_report_tags(min_id INTEGER DEFAULT 0, max_id INTEGER DEFAULT 2147483647) RETURNS void AS $$
  DELETE FROM report_tags WHERE report_id BETWEEN min_id AND max_id;
  INSERT INTO report_tags(report_id, player_id, category, tag)
  SELECT DISTINCT r.id, r.player_id, c.category, btrim(t)
  FROM reports r,
       LATERAL (VALUES ('physical', r.physical), ('mental', r.mental), ('technical', r.technical),
                       ('tactical', r.tactical), ('deadball', r.deadball)) AS c(category, txt),
       LATERAL unnest(string_to_array(c.txt, ',')) AS t
  WHERE r.id BETWEEN min_id AND max_id AND btrim(t) <> '' AND btrim(t) NOT ILIKE 'Please add further details%';
$$ LANGUAGE sql;

-- =====================================================================================================
-- 3. Vector search. Report text is split into sentence chunks; identical sentences are stored (and
--    embedded) once in text_chunks. Tag values are embedded too (kind = 'tag'), matched via report_tags.
--    Embeddings are filled asynchronously by the worker in src/chat/embedder.js.
-- =====================================================================================================
CREATE OR REPLACE FUNCTION chunk_hash(kind TEXT, category TEXT, content TEXT) RETURNS uuid AS $$
  SELECT md5(kind || '|' || coalesce(category, '') || '|' || lower(regexp_replace(btrim(content), '\s+', ' ', 'g')))::uuid;
$$ LANGUAGE sql IMMUTABLE;

-- Sentence splitter: on . ! ? followed by whitespace, and on line breaks. Keeps pieces with a letter.
CREATE OR REPLACE FUNCTION split_chunks(txt TEXT) RETURNS TABLE(ord INTEGER, chunk TEXT) AS $$
  SELECT (row_number() OVER (ORDER BY n))::int, left(c, 800)
  FROM (SELECT btrim(s) AS c, n FROM regexp_split_to_table(coalesce(txt, ''), '(?<=[.!?])\s+|\n+') WITH ORDINALITY AS x(s, n)) y
  WHERE length(c) >= 3 AND c ~ '[[:alpha:]]';
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS text_chunks (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('text', 'tag')),
  category      TEXT,                     -- tag category for kind = 'tag'
  content       TEXT NOT NULL,
  content_hash  UUID NOT NULL UNIQUE,
  embedding     halfvec(512),
  model         TEXT,
  embedded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_text_chunks_pending ON text_chunks (id) WHERE embedding IS NULL;
CREATE INDEX IF NOT EXISTS idx_text_chunks_hnsw ON text_chunks USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS report_chunks (
  report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL,
  field      TEXT NOT NULL,               -- 'x_factor' | 'comment'
  ord        INTEGER NOT NULL,
  chunk_id   BIGINT NOT NULL REFERENCES text_chunks(id),
  PRIMARY KEY (report_id, field, ord)
);
CREATE INDEX IF NOT EXISTS idx_report_chunks_chunk ON report_chunks (chunk_id, player_id);
CREATE INDEX IF NOT EXISTS idx_report_chunks_player ON report_chunks (player_id);

CREATE OR REPLACE FUNCTION sync_report_chunks() RETURNS trigger AS $$
BEGIN
  DELETE FROM report_chunks WHERE report_id = NEW.id;
  CREATE TEMP TABLE IF NOT EXISTS _chunk_src (field TEXT, ord INT, chunk TEXT, h UUID) ON COMMIT DELETE ROWS;
  DELETE FROM _chunk_src;
  INSERT INTO _chunk_src
    SELECT f.field, s.ord, s.chunk, chunk_hash('text', NULL, s.chunk)
    FROM (VALUES ('x_factor', NEW.x_factor), ('comment', NEW.overall_comment)) AS f(field, txt), LATERAL split_chunks(f.txt) s;
  INSERT INTO text_chunks(kind, content, content_hash)
    SELECT DISTINCT ON (h) 'text', chunk, h FROM _chunk_src ORDER BY h ON CONFLICT (content_hash) DO NOTHING;
  INSERT INTO report_chunks(report_id, player_id, field, ord, chunk_id)
    SELECT NEW.id, NEW.player_id, s.field, s.ord, tc.id FROM _chunk_src s JOIN text_chunks tc ON tc.content_hash = s.h;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_reports_chunks ON reports;
CREATE TRIGGER trg_reports_chunks AFTER INSERT OR UPDATE OF x_factor, overall_comment, player_id ON reports
  FOR EACH ROW EXECUTE FUNCTION sync_report_chunks();

CREATE OR REPLACE FUNCTION rebuild_report_chunks(min_id INTEGER DEFAULT 0, max_id INTEGER DEFAULT 2147483647) RETURNS void AS $$
BEGIN
  DELETE FROM report_chunks WHERE report_id BETWEEN min_id AND max_id;
  DROP TABLE IF EXISTS _bulk_chunk_src;
  CREATE TEMP TABLE _bulk_chunk_src AS
    SELECT r.id AS report_id, r.player_id, f.field, s.ord, s.chunk, chunk_hash('text', NULL, s.chunk) AS h
    FROM reports r,
         LATERAL (VALUES ('x_factor', r.x_factor), ('comment', r.overall_comment)) AS f(field, txt),
         LATERAL split_chunks(f.txt) s
    WHERE r.id BETWEEN min_id AND max_id;
  INSERT INTO text_chunks(kind, content, content_hash)
    SELECT DISTINCT ON (h) 'text', chunk, h FROM _bulk_chunk_src ORDER BY h ON CONFLICT (content_hash) DO NOTHING;
  INSERT INTO report_chunks(report_id, player_id, field, ord, chunk_id)
    SELECT s.report_id, s.player_id, s.field, s.ord, tc.id FROM _bulk_chunk_src s JOIN text_chunks tc ON tc.content_hash = s.h;
  DROP TABLE _bulk_chunk_src;
END $$ LANGUAGE plpgsql;

-- Tag vocabulary as embeddable chunks
CREATE OR REPLACE FUNCTION sync_tag_chunk() RETURNS trigger AS $$
BEGIN
  INSERT INTO text_chunks(kind, category, content, content_hash)
  VALUES ('tag', NEW.category, NEW.tag, chunk_hash('tag', NEW.category, NEW.tag)) ON CONFLICT (content_hash) DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_report_tags_chunk ON report_tags;
CREATE TRIGGER trg_report_tags_chunk AFTER INSERT ON report_tags FOR EACH ROW EXECUTE FUNCTION sync_tag_chunk();

CREATE OR REPLACE FUNCTION rebuild_tag_chunks() RETURNS void AS $$
  INSERT INTO text_chunks(kind, category, content, content_hash)
  SELECT 'tag', category, tag, chunk_hash('tag', category, tag) FROM (SELECT DISTINCT category, tag FROM report_tags) t
  ON CONFLICT (content_hash) DO NOTHING;
$$ LANGUAGE sql;

-- Backfill chunks for existing data on first migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM report_chunks) AND EXISTS (SELECT 1 FROM reports) THEN PERFORM rebuild_report_chunks(); END IF;
  PERFORM rebuild_tag_chunks();
END $$;

-- =====================================================================================================
-- 4. Conversation memory
-- =====================================================================================================
CREATE TABLE IF NOT EXISTS chat_conversations (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  question         TEXT NOT NULL,
  route            TEXT NOT NULL,
  intent           TEXT,
  spec             JSONB,
  answer           TEXT,
  result_count     INTEGER,
  player_ids       INTEGER[],
  player_names     TEXT[],
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, id DESC);

-- =====================================================================================================
-- 5. Read-only role for every chatbot query (belt and braces on top of the spec whitelist)
-- =====================================================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chat_reader') THEN
    -- migrate.js passes CHAT_READER_PASSWORD via app.chat_reader_password (hosted DBs reject weak passwords)
    EXECUTE format('CREATE ROLE chat_reader LOGIN PASSWORD %L', coalesce(nullif(current_setting('app.chat_reader_password', true), ''), 'chat_reader'));
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO chat_reader', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO chat_reader;
GRANT SELECT ON players, teams, scouts, matches, reports, report_tags, player_latest, player_text, report_facts,
  text_chunks, report_chunks, places, drive_time TO chat_reader;
ALTER ROLE chat_reader SET default_transaction_read_only = on;
ALTER ROLE chat_reader SET statement_timeout = '8s';
