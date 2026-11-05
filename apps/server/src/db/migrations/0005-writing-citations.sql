CREATE TABLE run_context_entries_v5 (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), turn_index INTEGER NOT NULL,
  citation_id TEXT NOT NULL, entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  UNIQUE(run_id,turn_index,citation_id)
) STRICT;
INSERT INTO run_context_entries_v5(id,run_id,turn_index,citation_id,entry_json)
SELECT id,run_id,turn_index,citation_id,entry_json FROM run_context_entries;
DROP TABLE run_context_entries;
ALTER TABLE run_context_entries_v5 RENAME TO run_context_entries;
