-- 94-arch-bootstrap: small project (≤200 commits) triggers tmb_lazy-regen-check
-- → tmb_refresh-architecture(scope='initial') silently on first code-touching ask.
-- architecture_regen writes regen_state rows and updates file_registry with
-- source files, but does NOT register arch doc paths in file_registry itself.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'regen_state-bootstrap-row (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM regen_state;

-- file_registry is populated by the regen scan (source files in the repo).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'file_registry-populated-by-bootstrap (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM file_registry;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-created-for-original-ask (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM tasks;
