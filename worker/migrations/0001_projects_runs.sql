-- Projects, their members and their runs: the app's records, which used to be in Firestore.
-- A run's events stay in its Durable Object; this table is what the project's run list shows.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL,
  -- researching | completed | archived
  status TEXT NOT NULL DEFAULT 'researching',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Members by email (lower case). The owner is always a member.
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, email)
);
CREATE INDEX project_members_email ON project_members(email);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  review_mode TEXT NOT NULL,
  -- JSON array of strings
  domains TEXT NOT NULL DEFAULT '[]',
  -- starting | running | paused | awaiting_review | completed | failed
  status TEXT NOT NULL,
  message TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runs_project_created ON runs(project_id, created_at DESC);
