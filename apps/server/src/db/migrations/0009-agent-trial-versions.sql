-- Published workflow nodes retain a version FK; unpublished role trials freeze a draft in context_json.
ALTER TABLE workflow_node_attempts RENAME TO workflow_node_attempts_legacy;
CREATE TABLE workflow_node_attempts (
 run_id TEXT PRIMARY KEY REFERENCES runs(id), workflow_id TEXT REFERENCES workflow_runs(id),
 node_key TEXT NOT NULL, context_json TEXT NOT NULL,
 agent_version_id TEXT REFERENCES agent_profile_versions(id)
) STRICT;
INSERT INTO workflow_node_attempts SELECT * FROM workflow_node_attempts_legacy;
DROP TABLE workflow_node_attempts_legacy;
CREATE INDEX workflow_attempt_parent ON workflow_node_attempts(workflow_id);
