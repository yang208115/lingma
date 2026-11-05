-- Legacy timeline entries retain their IDs, versions, and citations in the shared event list.
DROP TRIGGER outline_chapters_validate;
CREATE TRIGGER outline_chapters_validate BEFORE INSERT ON outline_chapters
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.outline_id AND project_id=NEW.project_id
      AND kind IN ('chapter_outline','timeline_event') AND deleted_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM documents WHERE id=NEW.chapter_id AND project_id=NEW.project_id
      AND kind='chapter' AND deleted_at IS NULL
  ) THEN RAISE(ABORT, 'story events must reference live chapters in their project') END;
END;

INSERT OR IGNORE INTO outline_chapters(outline_id,chapter_id,project_id)
SELECT d.id,c.id,d.project_id FROM documents d
JOIN document_versions v ON v.id=d.current_version_id
JOIN json_each(v.metadata_json,'$.element.links') link
JOIN documents c ON c.id=json_extract(link.value,'$.targetId')
  AND c.project_id=d.project_id AND c.kind='chapter' AND c.deleted_at IS NULL
WHERE d.kind='timeline_event' AND d.deleted_at IS NULL;
