-- 18-spec-shape-gate — a task adding the "priority" column carries the
-- Writer:/Populated: contract that require-task-spec.sh checks at swe spawn,
-- and bro met it instead of waiving the gate.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'priority task exists (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks
WHERE LOWER(title) LIKE '%priority%' OR LOWER(branch_id) LIKE '%priority%'
   OR LOWER(spec_body) LIKE '%priority%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'priority task spec_body has Writer: and Populated: lines (got ' || COUNT(*) || ', expected >=1)' AS description
FROM tasks
WHERE (LOWER(title) LIKE '%priority%' OR LOWER(branch_id) LIKE '%priority%'
       OR LOWER(spec_body) LIKE '%priority%')
  AND spec_body LIKE '%Writer:%'
  AND spec_body LIKE '%Populated:%';

SELECT
  CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS pass,
  'spec_shape_gate_waived audit rows (got ' || COUNT(*) || ', expected =0)' AS description
FROM audit
WHERE event_type = 'spec_shape_gate_waived';

-- record-swe-spawn.sh inserts the swe agent_runs row only after every spawn
-- gate, require-task-spec.sh included, allowed the spawn.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'swe spawn went through on the priority task (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agent_runs r
JOIN tasks t ON t.id = r.task_id
WHERE r.agent_type = 'swe'
  AND (LOWER(t.title) LIKE '%priority%' OR LOWER(t.branch_id) LIKE '%priority%'
       OR LOWER(t.spec_body) LIKE '%priority%');
