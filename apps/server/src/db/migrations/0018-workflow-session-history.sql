CREATE INDEX workflow_session_history ON workflow_runs(
  json_extract(state_json,'$.snapshot.input.sessionId'), created_at DESC, id DESC
);
