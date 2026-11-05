ALTER TABLE skills ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX skills_project_id ON skills(project_id, id);
ALTER TABLE skill_import_jobs ADD COLUMN project_id TEXT REFERENCES projects(id);
CREATE INDEX skill_jobs_project_recent ON skill_import_jobs(project_id, created_at DESC, id);
