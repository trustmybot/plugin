-- 06-push-gate: pre-seed = 1 task in needs_validation. Bro runs tmb_push-gate,
-- which spawns pr-reviewer subagent that issues validation_record.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-validation_attempts-row (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM validation_attempts;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'pr-reviewer-attempt-on-task-1 (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM validation_attempts
WHERE task_id = 1;
