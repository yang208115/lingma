CREATE TABLE agent_profiles (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
 builtin INTEGER NOT NULL DEFAULT 0, draft_json TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE agent_profile_versions (
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
 version_no INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(profile_id, version_no)
) STRICT;
CREATE TABLE workflow_templates (
 id TEXT PRIMARY KEY, revision INTEGER NOT NULL, draft_json TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE workflow_template_versions (
 id TEXT PRIMARY KEY, template_id TEXT NOT NULL REFERENCES workflow_templates(id),
 version_no INTEGER NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(template_id, version_no)
) STRICT;
CREATE TABLE workflow_runs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), status TEXT NOT NULL,
 state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX workflow_project_active ON workflow_runs(project_id)
 WHERE status IN ('queued','running','awaiting_input','awaiting_acceptance','paused','interrupted','failed','limited');
CREATE TABLE workflow_node_attempts (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), workflow_id TEXT REFERENCES workflow_runs(id),
 node_key TEXT NOT NULL, context_json TEXT NOT NULL, agent_version_id TEXT NOT NULL REFERENCES agent_profile_versions(id)
) STRICT;
CREATE TABLE workflow_artifacts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), turn_index INTEGER NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('staged','committed','published')),
 UNIQUE(run_id)
) STRICT;
CREATE TABLE workflow_events (
 workflow_id TEXT NOT NULL REFERENCES workflow_runs(id), seq INTEGER NOT NULL,
 event_json TEXT NOT NULL, PRIMARY KEY(workflow_id, seq)
) STRICT;
CREATE TABLE workflow_decisions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflow_runs(id), revision INTEGER NOT NULL,
 decision_json TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE INDEX workflow_attempt_parent ON workflow_node_attempts(workflow_id);
