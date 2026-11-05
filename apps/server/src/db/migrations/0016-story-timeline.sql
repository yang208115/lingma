ALTER TABLE documents ADD COLUMN story_time TEXT NOT NULL DEFAULT '' CHECK(length(story_time) <= 200);
ALTER TABLE documents ADD COLUMN summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 1000);

CREATE TABLE outline_chapters (
  outline_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY(outline_id, chapter_id),
  FOREIGN KEY(outline_id, project_id) REFERENCES documents(id, project_id),
  FOREIGN KEY(chapter_id, project_id) REFERENCES documents(id, project_id)
) STRICT;
CREATE INDEX outline_chapters_chapter ON outline_chapters(chapter_id, project_id);

INSERT INTO outline_chapters(outline_id, chapter_id, project_id)
SELECT id, chapter_id, project_id FROM documents WHERE kind='chapter_outline' AND chapter_id IS NOT NULL;

CREATE TRIGGER outline_chapters_validate BEFORE INSERT ON outline_chapters
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.outline_id AND project_id=NEW.project_id AND kind='chapter_outline' AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.chapter_id AND project_id=NEW.project_id AND kind='chapter' AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'story events must reference live chapters in their project') END;
END;
