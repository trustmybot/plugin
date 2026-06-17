-- Step 12 (issue resume) needs an in-progress task to pick up. Step 04's
-- prompt is intentionally simple (single ceremony — make todo CLI), so no
-- chain step organically leaves a pending task by step 12 (all earlier
-- atomic-closed). Mirror what step 12's setup-l5.sh seeds so L5 isolation
-- and L6 chain present bro with the same input shape: one in-flight
-- "count subcommand" task in pending status with a planning_complete audit.

INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Add count subcommand to todo CLI',
        'Queued as a follow-on task. Planned but not dispatched.',
        'open', datetime('now'), datetime('now'));

INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, created_at, updated_at)
SELECT id, 'feat/add-count-subcommand', 'dev', 'Add count subcommand',
       '## Description
Add a `count` subcommand to src/cli.py that prints the number of todo items in the JSON store.

## Success Criteria
- `python -m src.cli count` prints an integer
- All existing tests still pass
', 'See spec.', 'pending',
       datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
ORDER BY id DESC LIMIT 1;

INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary,
                   content_json, created_at)
SELECT id, 'feat/add-count-subcommand', 'bro', 'planning_complete',
       'Pre-seeded planning_complete for resume scenario.',
       '{}', datetime('now')
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
ORDER BY id DESC LIMIT 1;
