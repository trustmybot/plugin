-- 13-roundtable — bro convenes a roundtable on the todo CLI's storage
-- choice. Participants (cto, data-engineer) are pre-seeded as
-- project-local consultants (in chain: from prior steps; in L5: by
-- setup-l5.sh). Bro spawns both, each writes a kind='analysis'
-- discussion + a roundtable_vote.
--
-- Caveat: the finalize/close path (ratification AUQ) is partial-test territory.

-- The slash-detect hook wrote exactly one roundtable_slash_invoked row and
-- roundtable_create consumed it (no gate waiver)
SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'consumed roundtable_slash_invoked audit rows (got ' || COUNT(*) || ', expected exactly 1)' AS description
FROM audit
WHERE event_type = 'roundtable_slash_invoked'
  AND json_extract(content_json, '$.consumed_by_roundtable_id') IS NOT NULL;

-- A roundtable was created
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'roundtables row count (got ' || COUNT(*) || ', expected >=1)' AS description
FROM roundtables;

-- At least 2 analysis discussions (one per participant)
SELECT
  CASE WHEN COUNT(*) >= 2 THEN 1 ELSE 0 END AS pass,
  'discussions kind=analysis row count (got ' || COUNT(*) || ', expected >=2 — one per participant)' AS description
FROM discussions
WHERE kind = 'analysis';

-- At least 2 distinct participants left a vote row. Role-agnostic so the
-- assertion holds in both modes: L5 setup-l5 pre-seeds cto + data-engineer;
-- L6 chain has whatever consultants prior steps left (cto from step 10 +
-- whoever bro picks as the second participant — typically architect or pm
-- from the always-available templates). The test purpose is "roundtable
-- collected votes from multiple consultants", not "specifically cto + DE".
SELECT
  CASE WHEN COUNT(DISTINCT participant) >= 2 THEN 1 ELSE 0 END AS pass,
  'roundtable_votes from ≥2 distinct participants (got ' || COUNT(DISTINCT participant) || ', expected >=2)' AS description
FROM roundtable_votes;
