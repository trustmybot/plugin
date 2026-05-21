-- 11-roundtable — substantive checks across the two phases.
--
-- Phase 1: bro ran Branch C from-scratch for data-engineer.
--   (1) audit row tmb_agent_created with mode=from-scratch for data-engineer
--   (2) data-engineer registered in agents at scope=project-local
--
-- Phase 2: roundtable with the templated (cto, pre-seeded) and from-scratch
-- (data-engineer, just created) consultants both participating.
--   (3) roundtables row count >=1
--   (4) discussions kind=analysis >=2 (one from cto, one from data-engineer)
--   (5) roundtable_votes from cto AND data-engineer (>=2 rows, both voters
--       present) — confirms the mixed-template-vs-scratch spawn path.
--
-- Caveats inherited from prior version of this row:
--   - The `roundtable_slash_invoked` audit is NOT asserted here: claude's
--     slash-command expansion replaces the raw text before UserPromptSubmit
--     hooks see it. Hook's behavior is exercised separately (L3, future).
--   - The finalize/close path (ratification AUQ) is partial-test territory.

-- Phase 1 assertion 1: tmb_agent_created audit row exists for data-engineer.
-- Accepts any flavor — explicit audit_log from bro (mode=from-scratch,
-- branch=C, etc.) OR the auto-emit from agent_register (mode=agent_register).
-- Either proves the create ceremony fired for data-engineer; templated
-- agents are already in the registry pre-run so this is a creation signal.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_agent_created audit row for data-engineer (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'tmb_agent_created'
  AND content_json LIKE '%data-engineer%';

-- Phase 1 assertion 2: data-engineer registered as project-local
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'data-engineer registered as project-local consultant (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agents
WHERE name = 'data-engineer' AND scope = 'project-local';

-- Phase 2 assertion 3: roundtable created
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtables row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM roundtables;

-- Phase 2 assertion 4: at least 2 analysis discussions (one per participant)
SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'discussions kind=analysis row count (got ' || COUNT(*) || ', expected >=2 — one per participant)' AS description
FROM discussions
WHERE kind = 'analysis';

-- Phase 2 assertion 5: both participants present in roundtable_votes
SELECT
  CASE WHEN COUNT(DISTINCT participant) >= 2
       AND SUM(CASE WHEN participant = 'cto' THEN 1 ELSE 0 END) >= 1
       AND SUM(CASE WHEN participant = 'data-engineer' THEN 1 ELSE 0 END) >= 1
       THEN 1 ELSE 0 END AS pass,
  'roundtable_votes from cto AND data-engineer (got distinct participants ' || COUNT(DISTINCT participant) || ', need both)' AS description
FROM roundtable_votes;
