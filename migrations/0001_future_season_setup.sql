PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  playhq_competition_id TEXT NOT NULL,
  competition_name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(season_id, playhq_competition_id)
);

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  competition_id INTEGER REFERENCES competitions(id),
  playhq_grade_id TEXT NOT NULL,
  grade_name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(season_id, playhq_grade_id)
);

CREATE TABLE IF NOT EXISTS season_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(season_id, config_key)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  team_id INTEGER REFERENCES teams(id),
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  item_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_competitions_season ON competitions(season_id);
CREATE INDEX IF NOT EXISTS idx_grades_season ON grades(season_id);
CREATE INDEX IF NOT EXISTS idx_season_config_season ON season_config(season_id);
CREATE INDEX IF NOT EXISTS idx_sync_runs_season ON sync_runs(season_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fixtures_team_date ON fixtures(team_id, game_date, game_time);

INSERT OR IGNORE INTO grades (season_id, playhq_grade_id, grade_name)
SELECT season_id, grade_id, COALESCE(grade_name, 'Unlabelled grade')
FROM teams
WHERE grade_id IS NOT NULL AND grade_id <> '';

UPDATE grades
SET grade_name = (
  SELECT t.grade_name FROM teams t
  WHERE t.season_id = grades.season_id AND t.grade_id = grades.playhq_grade_id
  ORDER BY t.id LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM teams t
  WHERE t.season_id = grades.season_id AND t.grade_id = grades.playhq_grade_id AND t.grade_name IS NOT NULL
);
