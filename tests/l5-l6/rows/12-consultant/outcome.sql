-- 12-consultant — gate on the deterministic consultant-spawn-nudge signal.
--
-- The prompt-intent-hints consultant-spawn class fires the domain-specialist
-- nudge every run and writes a `consultant_spawn_nudged` audit row (the
-- enforcement mechanism). That row is deterministic — it does not depend on
-- whether bro complied with the advisory nudge. Gate on it.
--
-- De-flake of the prior `tmb_agent_created` gate: that signal depends on bro
-- following the nudge (the agent-creator ceremony), which is model behaviour,
-- not the enforcement mechanism — so it flaked. `tmb_agent_created` is now
-- observational only and is NOT a pass criterion, so it is intentionally not a
-- returned assertion row here (the scorer gates on every row this SQL emits;
-- to keep bro's compliance non-gating it must not appear as a row).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'consultant_spawn_nudged audit row (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'consultant_spawn_nudged';
