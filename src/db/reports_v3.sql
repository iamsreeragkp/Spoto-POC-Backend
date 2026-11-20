-- Report types: assessment reports (one match/date, by a scout) and feedback reports (a period, by a coach),
-- per-category comments, decimal scores (3.5) and age-group labels ("U13/14").
-- Applied by scripts/migrate.js after schema.sql and before the chatbot schema files. Idempotent.

-- One-time follow-up work for later migration files (e.g. rebuild the per-player tables after a search column changed)
CREATE TABLE IF NOT EXISTS schema_flags (name TEXT PRIMARY KEY, set_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Views that read report columns are recreated by chat_v2_schema.sql; dropping them lets the column types change
DROP VIEW IF EXISTS report_facts, player_latest_source, player_text_source;

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS report_type        TEXT NOT NULL DEFAULT 'assessment',
  ADD COLUMN IF NOT EXISTS period_start       DATE,          -- feedback: the period the coach looked at
  ADD COLUMN IF NOT EXISTS period_end         DATE,
  ADD COLUMN IF NOT EXISTS competition_level  TEXT,
  ADD COLUMN IF NOT EXISTS physical_comment   TEXT,
  ADD COLUMN IF NOT EXISTS technical_comment  TEXT,
  ADD COLUMN IF NOT EXISTS tactical_comment   TEXT,
  ADD COLUMN IF NOT EXISTS mental_comment     TEXT,          -- "Psychological" in feedback reports
  ADD COLUMN IF NOT EXISTS behavioral_comment TEXT,
  ADD COLUMN IF NOT EXISTS score_behavioral   NUMERIC(3,1);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_report_type_check') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_report_type_check CHECK (report_type IN ('assessment', 'feedback'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reports_score_behavioral_check') THEN
    ALTER TABLE reports ADD CONSTRAINT reports_score_behavioral_check CHECK (score_behavioral BETWEEN 0 AND 10);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_reports_type ON reports (report_type, report_date DESC NULLS LAST);

-- Decimal scores (the new files contain 3.5); the 0-10 checks stay
DO $$
DECLARE c TEXT;
BEGIN
  FOREACH c IN ARRAY ARRAY['score_physical', 'score_mental', 'score_technical', 'score_tactical', 'score_deadball',
                           'score_x_factor', 'overall_score', 'overall_potential_score'] LOOP
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'reports' AND column_name = c) = 'smallint' THEN
      EXECUTE format('ALTER TABLE reports ALTER COLUMN %I TYPE NUMERIC(3,1)', c);
    END IF;
  END LOOP;
END $$;

-- Age-group label as written in the newer files ("U13/14"); players.age_group (birth year) stays empty for them
ALTER TABLE players ADD COLUMN IF NOT EXISTS age_group_label TEXT;

-- The comment search vector now covers every comment (overall + per category). A generated column cannot be
-- changed in place: drop it when its definition is older; chat_v2_schema.sql adds it back with the new definition.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
             WHERE a.attrelid = 'reports'::regclass AND a.attname = 'tsv_c'
               AND pg_get_expr(d.adbin, d.adrelid) NOT LIKE '%behavioral_comment%') THEN
    ALTER TABLE reports DROP COLUMN tsv_c;
    INSERT INTO schema_flags(name) VALUES ('rebuild_player_latest') ON CONFLICT DO NOTHING;
  END IF;
END $$;
