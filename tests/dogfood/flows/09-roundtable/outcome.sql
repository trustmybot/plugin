-- 09-roundtable: tmb_roundtable spawns 2-4 consultants. Each writes
-- discussion_append(kind='analysis'). Skill writes roundtable votes + optionally
-- a ledger summary. The ledger summary call fires after AUQ in headless mode
-- but AUQ errors interrupt the post-vote flow; assert on the substantive
-- consultant output (analysis discussions) not the summary event.

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'two-or-more-analysis-discussions (got ' || COUNT(*) || ', expected ≥ 2)' AS description
FROM discussions
WHERE kind = 'analysis';

-- Roundtable row was created (proves tmb_roundtable skill ran and invoked the MCP tool).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtable-row-created (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM roundtables;

-- #160 coverage: assert roundtable_votes was populated by the consultants.
SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'roundtable_votes-rows (got ' || COUNT(*) || ', expected >= 2)' AS description
FROM roundtable_votes;
