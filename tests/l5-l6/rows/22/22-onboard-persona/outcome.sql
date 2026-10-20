-- 22-onboard-persona — /tmb:onboard completes on a cold project and leaves
-- the project CLAUDE.md untouched (GH 1496). The file is read through the
-- sqlite3 shell's readfile(), resolved next to the DB under scoring:
-- <project>/.claude/tmb/trajectory.db -> <project>/CLAUDE.md and the seed
-- snapshot <project>/.claude/tmb/_l5_claude_md_seed.md.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'onboarded marker (got ' || COUNT(*) || ', expected =1) — onboarding completed' AS description
FROM plugin_config WHERE key = 'onboarded' AND value_json = 'true';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'persona_block_written audit rows (got ' || COUNT(*) || ', expected =0)' AS description
FROM audit WHERE event_type = 'persona_block_written';

WITH paths AS (
  SELECT
    replace(file, '/.claude/tmb/trajectory.db', '/CLAUDE.md') AS claude_md,
    replace(file, '/trajectory.db', '/_l5_claude_md_seed.md') AS seed
  FROM pragma_database_list WHERE name = 'main'
)
SELECT
  CASE WHEN instr(CAST(readfile(claude_md) AS TEXT), 'tmb:persona') = 0 THEN 1 ELSE 0 END AS pass,
  'project CLAUDE.md readable and holds no tmb:persona block' AS description
FROM paths;

WITH paths AS (
  SELECT
    replace(file, '/.claude/tmb/trajectory.db', '/CLAUDE.md') AS claude_md,
    replace(file, '/trajectory.db', '/_l5_claude_md_seed.md') AS seed
  FROM pragma_database_list WHERE name = 'main'
)
SELECT
  CASE WHEN readfile(seed) IS NOT NULL AND readfile(claude_md) = readfile(seed) THEN 1 ELSE 0 END AS pass,
  'project CLAUDE.md equals the setup-l5.sh seed byte for byte' AS description
FROM paths;
