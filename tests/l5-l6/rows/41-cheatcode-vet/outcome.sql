-- Outcome assertions for 41-cheatcode-vet. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.
--
-- Scope: bro vets a named candidate and fires cheatcode_vet. The deterministic
-- proof is the cheatcode_vet audit row — the trust-tier classification itself is
-- covered by L2/L3, not here.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cheatcode_vet-audit-row-exists (got ' || COUNT(*) || ')' AS description
FROM audit
WHERE event_type = 'cheatcode_vet';
