-- Durable commit ledger survives expiration or loss of import preview files.
CREATE TABLE import_commits (
  import_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX import_commits_project ON import_commits(project_id, created_at);
