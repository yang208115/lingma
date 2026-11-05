-- Multi-agent orchestration redesign: workflow templates, runs and artifacts are rebuilt on the
-- Markdown pipeline model. Agent profiles, provider settings and all novel documents are kept.
DELETE FROM workflow_decisions;
DELETE FROM workflow_events;
DELETE FROM workflow_artifacts;
DELETE FROM workflow_node_attempts;
DELETE FROM workflow_runs;
DELETE FROM workflow_template_versions;
DELETE FROM workflow_templates;
