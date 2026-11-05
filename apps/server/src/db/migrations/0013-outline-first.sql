-- migration: rebuild-tables
CREATE TABLE documents_outline_first (
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
  CHECK(kind = 'chapter_outline' OR chapter_id IS NULL),
  FOREIGN KEY(volume_id, project_id) REFERENCES volumes(id, project_id),
  FOREIGN KEY(chapter_id, project_id) REFERENCES documents(id, project_id),
  FOREIGN KEY(current_version_id, id) REFERENCES document_versions(id, document_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

INSERT INTO documents_outline_first SELECT * FROM documents;
DROP TABLE documents;
ALTER TABLE documents_outline_first RENAME TO documents;
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
