-- migration: rebuild-tables
DROP TRIGGER outline_chapters_validate;
CREATE TABLE documents_chapter_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  volume_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chapter','master_outline','chapter_outline','chapter_plan','character','story_premise','worldbuilding','core_conflict','timeline_event','foreshadow','narrative_style')),
  chapter_id TEXT,
  parent_outline_id TEXT,
  story_time TEXT NOT NULL DEFAULT '' CHECK(length(story_time) <= 200),
  summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 1000),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0),
  current_version_id TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(id, project_id),
  CHECK(kind IN ('chapter_outline','chapter_plan') OR chapter_id IS NULL),
  CHECK(kind = 'chapter_plan' OR parent_outline_id IS NULL),
  FOREIGN KEY(parent_outline_id, project_id) REFERENCES documents(id, project_id),
  FOREIGN KEY(volume_id, project_id) REFERENCES volumes(id, project_id),
  FOREIGN KEY(chapter_id, project_id) REFERENCES documents(id, project_id),
  FOREIGN KEY(current_version_id, id) REFERENCES document_versions(id, document_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

INSERT INTO documents_chapter_plans(id,project_id,volume_id,kind,chapter_id,title,sort_order,current_version_id,deleted_at,story_time,summary)
SELECT id,project_id,volume_id,kind,chapter_id,title,sort_order,current_version_id,deleted_at,story_time,summary FROM documents;
DROP TABLE documents;
ALTER TABLE documents_chapter_plans RENAME TO documents;
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

CREATE INDEX documents_parent_outline ON documents(parent_outline_id,project_id);
CREATE TRIGGER outline_chapters_validate BEFORE INSERT ON outline_chapters
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.outline_id AND project_id=NEW.project_id
      AND kind IN ('chapter_outline','timeline_event','chapter_plan') AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.chapter_id AND project_id=NEW.project_id
      AND kind='chapter' AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'writing plans must reference live chapters in their project') END;
END;
CREATE TRIGGER documents_plan_parent_insert BEFORE INSERT ON documents WHEN NEW.parent_outline_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.parent_outline_id AND project_id=NEW.project_id
      AND kind IN ('chapter_outline','timeline_event','master_outline') AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'chapter plans must reference a live outline in their project') END;
END;
CREATE TRIGGER documents_plan_parent_update BEFORE UPDATE OF parent_outline_id ON documents WHEN NEW.parent_outline_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.parent_outline_id AND project_id=NEW.project_id
      AND kind IN ('chapter_outline','timeline_event','master_outline') AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'chapter plans must reference a live outline in their project') END;
END;
