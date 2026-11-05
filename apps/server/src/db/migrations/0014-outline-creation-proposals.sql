CREATE TABLE outline_creation_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  turn_index INTEGER NOT NULL CHECK(turn_index >= 0),
  tool_execution_id TEXT NOT NULL UNIQUE REFERENCES tool_executions(id),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staged','pending','accepted','rejected','abandoned')),
  accepted_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(accepted_json)),
  created_at TEXT NOT NULL,
  UNIQUE(run_id, payload_hash)
) STRICT;
CREATE INDEX outline_creation_proposals_run ON outline_creation_proposals(run_id, status);
