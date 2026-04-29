-- 32-team-config: branching-model change requires Human re-confirmation
-- (tmb_reonboard renders an AskUserQuestion radio). In headless mode AUQ
-- errors and the skill records 'headless_reonboard_blocked'.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'reonboard-event-or-headless-block (got ' || COUNT(*) || ', expected ≥ 1)' AS description
FROM ledger
WHERE event_type IN ('config_changed', 'headless_reonboard_blocked');
