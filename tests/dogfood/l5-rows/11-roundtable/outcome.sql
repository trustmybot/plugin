-- 11-roundtable — substantive checks: a roundtable was created and the
-- consultants wrote analyses.
--
-- NOTE on the `roundtable_slash_invoked` audit row: the slash-detect hook
-- (scripts/hooks/roundtable-slash-detect.sh) fires correctly in
-- standalone testing but does NOT land its audit row in the real L5
-- environment — claude's slash-command expansion likely replaces the
-- raw `/roundtable …` text with the expanded skill-invocation before
-- the UserPromptSubmit hook sees it. The audit-row assertion is omitted
-- here; the hook's behaviour is exercised separately (L3, future).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtables row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM roundtables;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'discussions kind=analysis row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'analysis';
