-- 09-roundtable: tmb_roundtable spawns 2-4 consultants. Each writes
-- discussion_append(kind='analysis'). Skill writes ledger summary.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtable_summary-ledger-event (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM ledger
WHERE event_type = 'roundtable_summary';

SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'two-or-more-analysis-discussions (got ' || COUNT(*) || ', expected ≥ 2)' AS description
FROM discussions
WHERE kind = 'analysis';
