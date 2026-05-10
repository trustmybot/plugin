-- 01-onboard-then-task-on-feature-branch — minimum DB-state assertions.
-- Cumulative coherence (table-shape) lives in outcome-coherence.json so flow
-- authors don't have to spell it out per scenario; this file holds the
-- scenario-specific assertions that go beyond shape.

-- Task must exist on a feature branch (not on the base branch directly).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'task on feature branch (got ' || COUNT(*) || ', expected ≥1) — bro must pre-create branch_id, not commit to main' AS description
FROM tasks
WHERE branch_id NOT IN ('main', 'master', 'dev', 'develop')
  AND branch_id LIKE '%/%';
