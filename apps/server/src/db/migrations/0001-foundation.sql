CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  structure_version INTEGER NOT NULL DEFAULT 1 CHECK(structure_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE volumes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
  UNIQUE(id, project_id)
) STRICT;
CREATE INDEX volumes_project_order ON volumes(project_id, sort_order, id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  volume_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chapter','master_outline','chapter_outline','character')),
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
CREATE INDEX documents_project_kind_order ON documents(project_id, kind, sort_order, id);
CREATE INDEX documents_volume ON documents(volume_id, project_id);
CREATE INDEX documents_chapter ON documents(chapter_id, project_id);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
  source TEXT NOT NULL CHECK(source IN ('manual','import','proposal','restore')),
  created_at TEXT NOT NULL,
  UNIQUE(document_id, version_no),
  UNIQUE(id, document_id)
) STRICT;

CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document versions are immutable'); END;
CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document versions are immutable'); END;
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

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  source_type TEXT NOT NULL CHECK(source_type IN ('local','git')),
  source_ref TEXT,
  source_commit TEXT,
  source_subdir TEXT,
  current_version_id TEXT NOT NULL,
  FOREIGN KEY(current_version_id, id) REFERENCES skill_versions(id, skill_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  entry_content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  source_snapshot_json TEXT NOT NULL CHECK(json_valid(source_snapshot_json)),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  UNIQUE(skill_id, version_no),
  UNIQUE(id, skill_id)
) STRICT;
CREATE TABLE skill_files (
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id),
  relative_path TEXT NOT NULL CHECK(length(relative_path) > 0 AND substr(relative_path, 1, 1) <> '/' AND instr(relative_path, char(92)) = 0 AND instr('/' || relative_path || '/', '/../') = 0 AND instr('/' || relative_path || '/', '/./') = 0 AND instr(relative_path, '//') = 0),
  blob_hash TEXT NOT NULL CHECK(length(blob_hash) = 64 AND blob_hash NOT GLOB '*[^a-f0-9]*'),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  PRIMARY KEY(skill_version_id, relative_path)
) STRICT;
CREATE INDEX skill_files_blob ON skill_files(blob_hash);
CREATE TRIGGER skill_versions_no_update BEFORE UPDATE ON skill_versions
BEGIN SELECT RAISE(ABORT, 'skill versions are immutable'); END;
CREATE TRIGGER skill_versions_no_delete BEFORE DELETE ON skill_versions
BEGIN SELECT RAISE(ABORT, 'skill versions are immutable'); END;
CREATE TRIGGER skill_files_no_update BEFORE UPDATE ON skill_files
BEGIN SELECT RAISE(ABORT, 'skill manifests are immutable'); END;
CREATE TRIGGER skill_files_no_delete BEFORE DELETE ON skill_files
BEGIN SELECT RAISE(ABORT, 'skill manifests are immutable'); END;
