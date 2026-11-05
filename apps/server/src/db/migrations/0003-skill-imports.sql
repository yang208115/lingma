CREATE TABLE skill_import_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('local','git')),
  skill_id TEXT REFERENCES skills(id),
  base_version_id TEXT REFERENCES skill_versions(id),
  status TEXT NOT NULL CHECK(status IN ('queued','fetching','publishing','completed','failed','interrupted')),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  version_id TEXT REFERENCES skill_versions(id),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX skill_jobs_recent ON skill_import_jobs(created_at DESC, id);
