ALTER TABLE projects ADD COLUMN deleted_at TEXT;
CREATE INDEX projects_deleted_id ON projects(deleted_at, id);
