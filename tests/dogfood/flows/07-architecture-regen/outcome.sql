-- 07-architecture-regen: tmb_refresh-architecture wraps architecture_regen.
-- The MCP tool writes regen_state + file_registry rows for arch paths.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'regen_state-row-present-after-refresh (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM regen_state;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'file_registry-has-arch-doc-row (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM file_registry
WHERE path LIKE 'docs/%architecture%';
