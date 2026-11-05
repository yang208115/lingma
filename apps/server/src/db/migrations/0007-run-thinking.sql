ALTER TABLE run_turns ADD COLUMN thinking TEXT NOT NULL DEFAULT '';

-- Recover visible thinking already saved in the SDK transcript of earlier runs.
UPDATE run_turns
SET thinking = COALESCE((
  SELECT group_concat(json_extract(block.value, '$.thinking'), '')
  FROM json_each(run_turns.response_json, '$.transcriptMessage.protocol.message.content') AS block
  WHERE json_extract(block.value, '$.type') = 'thinking'
    AND json_type(block.value, '$.thinking') = 'text'
    AND COALESCE(json_extract(block.value, '$.redacted'), 0) = 0
), '')
WHERE response_json IS NOT NULL;
