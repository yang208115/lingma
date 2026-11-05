ALTER TABLE sessions ADD COLUMN updated_at TEXT;
ALTER TABLE sessions ADD COLUMN deleted_at TEXT;
UPDATE sessions SET updated_at = MAX(
  created_at,
  COALESCE((SELECT MAX(COALESCE(finished_at, created_at)) FROM runs WHERE session_id=sessions.id), created_at)
);
CREATE INDEX sessions_history ON sessions(project_id, deleted_at, updated_at DESC, id DESC);
CREATE INDEX messages_session ON messages(session_id);
CREATE INDEX runs_session_history ON runs(session_id, created_at DESC, id DESC);
CREATE TRIGGER session_activity_created AFTER INSERT ON runs WHEN NEW.session_id IS NOT NULL BEGIN
  UPDATE sessions SET updated_at=MAX(COALESCE(updated_at,created_at),NEW.created_at) WHERE id=NEW.session_id;
END;
CREATE TRIGGER session_activity_finished AFTER UPDATE OF finished_at ON runs WHEN NEW.session_id IS NOT NULL AND NEW.finished_at IS NOT NULL BEGIN
  UPDATE sessions SET updated_at=MAX(COALESCE(updated_at,created_at),NEW.finished_at) WHERE id=NEW.session_id;
END;
