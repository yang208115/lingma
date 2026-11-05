-- migration: rebuild-tables
CREATE TABLE documents_expanded (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  volume_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chapter','master_outline','chapter_outline','character','story_premise','worldbuilding','core_conflict','timeline_event','foreshadow','narrative_style')),
  chapter_id TEXT,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  current_version_id TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(id, project_id),
  CHECK((kind = 'chapter_outline' AND chapter_id IS NOT NULL) OR (kind <> 'chapter_outline' AND chapter_id IS NULL)),
  FOREIGN KEY(volume_id, project_id) REFERENCES volumes(id, project_id),
  FOREIGN KEY(chapter_id, project_id) REFERENCES documents(id, project_id),
  FOREIGN KEY(current_version_id, id) REFERENCES document_versions(id, document_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

INSERT INTO documents_expanded SELECT * FROM documents;
DROP TABLE documents;
ALTER TABLE documents_expanded RENAME TO documents;
CREATE INDEX documents_project_kind_order ON documents(project_id, kind, sort_order, id);
CREATE INDEX documents_volume ON documents(volume_id, project_id);
CREATE INDEX documents_chapter ON documents(chapter_id, project_id);


CREATE TRIGGER documents_chapter_insert BEFORE INSERT ON documents WHEN NEW.chapter_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id = NEW.chapter_id AND project_id = NEW.project_id AND kind = 'chapter'
  ) THEN RAISE(ABORT, 'chapter outline must reference a chapter in its project') END;
END;
CREATE TRIGGER documents_chapter_update BEFORE UPDATE OF chapter_id, project_id ON documents WHEN NEW.chapter_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id = NEW.chapter_id AND project_id = NEW.project_id AND kind = 'chapter'
  ) THEN RAISE(ABORT, 'chapter outline must reference a chapter in its project') END;
END;
CREATE TRIGGER documents_identity_immutable BEFORE UPDATE OF id, project_id, kind ON documents
WHEN NEW.id <> OLD.id OR NEW.project_id <> OLD.project_id OR NEW.kind <> OLD.kind
BEGIN SELECT RAISE(ABORT, 'document identity and kind are immutable'); END;


CREATE TABLE element_confirmations (
  document_id TEXT PRIMARY KEY REFERENCES documents(id),
  confirmed_version_id TEXT NOT NULL,
  FOREIGN KEY(confirmed_version_id,document_id) REFERENCES document_versions(id,document_id)
) STRICT;
INSERT INTO element_confirmations SELECT id,current_version_id FROM documents WHERE kind IN ('character','master_outline');
CREATE TABLE element_generation_jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed','cancelled','interrupted')),
  stage INTEGER NOT NULL DEFAULT 0, call_count INTEGER NOT NULL DEFAULT 0, run_id TEXT REFERENCES runs(id),
  error TEXT, last_event_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX element_active_project ON element_generation_jobs(project_id) WHERE status IN ('queued','running');
CREATE TABLE element_generation_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES element_generation_jobs(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  stage INTEGER NOT NULL, repair INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE element_candidates (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES element_generation_jobs(id), temp_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), original_json TEXT NOT NULL CHECK(json_valid(original_json)),
  base_version_id TEXT REFERENCES document_versions(id), revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  accepted_document_id TEXT REFERENCES documents(id), accepted_version_id TEXT REFERENCES document_versions(id),
  UNIQUE(job_id,temp_id)
) STRICT;
CREATE TABLE element_generation_events (
  job_id TEXT NOT NULL REFERENCES element_generation_jobs(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at TEXT NOT NULL, PRIMARY KEY(job_id,seq)
) STRICT;
CREATE INDEX element_jobs_project ON element_generation_jobs(project_id,created_at,id);
