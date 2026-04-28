-- Outcome assertions for 04-agent-creator. Each row returns (pass, description).
-- The scorer requires every row's pass column to be 1.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'at-least-one-tmb_agent_created-ledger-event (got ' || COUNT(*) || ')' AS description
FROM ledger
WHERE event_type = 'tmb_agent_created';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'ledger-event-has-architect-name (got ' || COUNT(*) || ')' AS description
FROM ledger
WHERE event_type = 'tmb_agent_created'
  AND content_json LIKE '%"name":"architect"%';

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'ledger-event-has-template-copy-mode (got ' || COUNT(*) || ')' AS description
FROM ledger
WHERE event_type = 'tmb_agent_created'
  AND content_json LIKE '%"mode":"template-copy"%';
