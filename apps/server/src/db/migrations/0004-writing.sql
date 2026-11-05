CREATE TABLE provider_configs (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE provider_checks (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES provider_configs(id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  chapter_id TEXT, title TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(id,project_id), FOREIGN KEY(chapter_id,project_id) REFERENCES documents(id,project_id)
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), session_id TEXT,
  purpose TEXT NOT NULL CHECK(purpose IN ('write','rewrite','review','skill_test')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','completed','limited','failed','cancelled','interrupted')),
  stop_reason TEXT, retry_of_run_id TEXT REFERENCES runs(id),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  context_hash TEXT NOT NULL, checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
  output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq>=0),
  event_floor INTEGER NOT NULL DEFAULT 1 CHECK(event_floor>0),
  cancel_requested_at TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  CHECK(purpose NOT IN ('write','rewrite') OR project_id IS NOT NULL),
  FOREIGN KEY(session_id,project_id) REFERENCES sessions(id,project_id)
) STRICT;
CREATE UNIQUE INDEX runs_project_writer ON runs(project_id)
WHERE purpose IN ('write','rewrite') AND status IN ('queued','running','cancelling');
CREATE INDEX runs_queue ON runs(status,created_at,id);
CREATE INDEX runs_project ON runs(project_id,created_at,id);
CREATE UNIQUE INDEX runs_session_active ON runs(session_id) WHERE session_id IS NOT NULL AND status IN ('queued','running','cancelling');
CREATE TABLE run_documents (
  run_id TEXT NOT NULL REFERENCES runs(id), document_id TEXT NOT NULL, version_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read','propose')), selected INTEGER NOT NULL CHECK(selected IN (0,1)),
  ordinal INTEGER NOT NULL, PRIMARY KEY(run_id,document_id),
  FOREIGN KEY(version_id,document_id) REFERENCES document_versions(id,document_id)
) STRICT;
CREATE TABLE run_context_entries (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), turn_index INTEGER NOT NULL,
  citation_id TEXT NOT NULL, entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  UNIQUE(run_id,citation_id)
) STRICT;
CREATE TABLE run_turns (
  run_id TEXT NOT NULL REFERENCES runs(id), turn_index INTEGER NOT NULL, status TEXT NOT NULL,
  request_json TEXT CHECK(request_json IS NULL OR json_valid(request_json)), partial_text TEXT NOT NULL DEFAULT '',
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  PRIMARY KEY(run_id,turn_index)
) STRICT;
CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, turn_index INTEGER NOT NULL, call_id TEXT NOT NULL,
  name TEXT NOT NULL, args_json TEXT CHECK(args_json IS NULL OR json_valid(args_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  UNIQUE(run_id,turn_index,call_id),
  FOREIGN KEY(run_id,turn_index) REFERENCES run_turns(run_id,turn_index)
) STRICT;
CREATE TABLE proposals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), turn_index INTEGER NOT NULL,
  tool_execution_id TEXT UNIQUE REFERENCES tool_executions(id),
  target_document_id TEXT NOT NULL, base_version_id TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), proposed_content TEXT NOT NULL,
  reason TEXT NOT NULL, citations_json TEXT NOT NULL CHECK(json_valid(citations_json)),
  status TEXT NOT NULL CHECK(status IN ('staged','pending','accepted','rejected','stale','abandoned')),
  accepted_version_id TEXT, origin TEXT NOT NULL CHECK(origin IN ('tool','candidate')), created_at TEXT NOT NULL,
  FOREIGN KEY(base_version_id,target_document_id) REFERENCES document_versions(id,document_id),
  FOREIGN KEY(accepted_version_id,target_document_id) REFERENCES document_versions(id,document_id)
) STRICT;
CREATE UNIQUE INDEX proposals_candidate ON proposals(run_id) WHERE origin='candidate';
CREATE INDEX proposals_target ON proposals(target_document_id,status);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(run_id,role)
) STRICT;
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL CHECK(seq>0), type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,seq)
) STRICT;
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(scope,key)
) STRICT;
