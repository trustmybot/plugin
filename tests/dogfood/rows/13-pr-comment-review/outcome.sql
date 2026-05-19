-- 13-pr-comment-review — partial-test (no real PR in L5 sandbox).
-- Substantive check is bro attempted pr_comments_get (asserted via tools-required).
SELECT 1 AS pass, 'pr-comment-review: bro routed /monitor and attempted pr_comments_get (asserted via tools-required)' AS description;

-- Confirm the pre-seeded closed task is intact.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'closed task on feat/todo-add (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks
WHERE status = 'closed';

-- Cursor persistence — the pre-seeded pr_review_runs row must survive
-- bro's session. Proves the cursor table is real state, not a per-turn
-- scratchpad. (Real cursor-advance is exercised at L2 in pr-comments.test.ts.)
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'pr_review_runs cursor for PR #123 survived the session (got ' || COUNT(*) || ', expected 1)' AS description
FROM pr_review_runs
WHERE pr_number = 123 AND repo = 'org/todo-cli';

-- Cursor field shape — confirm the slim schema landed (no dropped columns
-- like comments_processed / tasks_created / remote_kind / created_at).
SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'pr_review_runs has none of the dropped columns (got ' || COUNT(*) || ', expected 0)' AS description
FROM pragma_table_info('pr_review_runs')
WHERE name IN ('comments_processed', 'tasks_created', 'remote_kind', 'created_at');
