-- Step 13 asserts a pr_review_runs cursor row exists for PR #123. The
-- L5 setup-l5.sh pre-seeds this; in L6 chain no prior step organically
-- creates it (step 07 pushes a branch but doesnt simulate the PR being
-- opened or comments accumulating). Mirroring the L5 seed here so the
-- chain has the same input shape.

INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id)
VALUES (123, 'org/todo-cli', '2026-05-12T10:00:00Z', 'rc-pre-seed');
