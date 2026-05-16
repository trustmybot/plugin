-- 10-agent-creator-on-missing-consultant — a tmb_agent_created audit row
-- should exist (the load-bearing signal that the agent-creator ceremony ran).
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_agent_created audit row (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'tmb_agent_created';

-- Note: agent_register is INSERT OR IGNORE in the server impl, so the
-- cto registry row's scope stays 'template' — the scope-update is a known
-- server-side gap, not a bro-behaviour gap. The audit row above is what
-- this scenario actually asserts.
