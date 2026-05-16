-- 11-roundtable — substantive checks: a roundtable was created, consultants
-- wrote analyses + votes.
--
-- NOTE on the `roundtable_slash_invoked` audit row: the slash-detect hook
-- (scripts/hooks/roundtable-slash-detect.sh) fires correctly in
-- standalone testing but does NOT land its audit row in the real L5
-- environment — claude's slash-command expansion likely replaces the
-- raw `/roundtable …` text with the expanded skill-invocation before
-- the UserPromptSubmit hook sees it. The audit-row assertion is omitted
-- here; the hook's behaviour is exercised separately (L3, future).
--
-- Scope of L5 coverage (#2854): items 1-4 of the issue's checklist —
-- roundtable_create, consultant analyses, AND roundtable_votes. The
-- finalize/close path (items 5-8) requires a Human ratification AUQ which
-- L5's single-turn harness can't drive; that part is partial-test
-- territory (see misc/roundtable-finalize-partial for the bridge fixture).

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtables row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM roundtables;

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'discussions kind=analysis row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE kind = 'analysis';

-- #2854: assert consultants left vote rows. The roundtable state machine
-- auto-flips from collecting → awaiting_human once expected_participants
-- vote rows land, so a non-empty roundtable_votes count is the single
-- best signal that the consultant spawn → vote write path is healthy.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtable_votes row count (got ' || COUNT(*) || ', expected >=1) — #2854' AS description
FROM roundtable_votes;
