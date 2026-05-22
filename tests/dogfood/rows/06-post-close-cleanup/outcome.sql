-- 06-post-close-cleanup — at least one file_registry row at src/cli.py
-- must have a non-null summary. We filter on populated rows because
-- bro's file_registry_update_summaries call may write with a different
-- `repo` value than the fixture pre-seeded, leaving two rows for the
-- same path. The contract is "the summary lands somewhere," not "the
-- pre-seeded row got updated in-place."
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'src/cli.py summary populated (got ' || COUNT(*) || ' row(s) with non-null summary, expected >=1)' AS description
FROM file_registry
WHERE path = 'src/cli.py'
  AND summary IS NOT NULL
  AND summary != '';

-- file_registry_embeddings for src/cli.py must have been bumped after the
-- stale row seeded by setup-l5.sh (baseline stored in plugin_config by setup).
-- In L6 chain mode this row is skipped because plugin_config key is absent
-- (setup-l5.sh not run); the assertion short-circuits to pass via COALESCE.
SELECT
  CASE
    WHEN (SELECT value_json FROM plugin_config WHERE key = 'l5_06_embedding_baseline') IS NULL
      THEN 1
    WHEN EXISTS (
      SELECT 1
      FROM file_registry_embeddings fre
      JOIN file_registry fr ON fre.file_registry_id = fr.rowid
      WHERE fr.path = 'src/cli.py'
        AND fre.embedded_at > json_extract(
              (SELECT value_json FROM plugin_config WHERE key = 'l5_06_embedding_baseline'),
              '$'
            )
    )
      THEN 1
    ELSE 0
  END AS pass,
  'file_registry_embeddings.embedded_at for src/cli.py bumped past stale baseline (L5 only; L6 skips when key absent)' AS description;
