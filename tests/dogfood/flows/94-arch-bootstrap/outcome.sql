-- 94-arch-bootstrap: small project (≤200 commits) triggers tmb_lazy-regen-check
-- → tmb_refresh-architecture(scope='initial') silently on first code-touching ask.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'regen_state-bootstrap-row (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM regen_state;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'file_registry-arch-path-present (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM file_registry
WHERE path LIKE 'docs/%architecture%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task-created-for-original-ask (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM tasks;
