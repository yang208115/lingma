CREATE TABLE agent_prompt_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  prompt TEXT NOT NULL CHECK(length(trim(prompt)) BETWEEN 1 AND 32000),
  revision INTEGER NOT NULL CHECK(revision > 0),
  updated_at TEXT NOT NULL
) STRICT;
