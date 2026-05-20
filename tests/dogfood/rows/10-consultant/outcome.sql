-- Phase 1: tmb_agent-creator template-copy ceremony completed for cto
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'tmb_agent_created audit row for cto (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'tmb_agent_created'
  AND content_json LIKE '%cto%';

-- Phase 1: cto registered in agents table
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cto registered as project-local consultant (got ' || COUNT(*) || ', expected >=1)' AS description
FROM agents
WHERE name = 'cto' AND scope = 'project-local';

-- Phase 2: cto produced analysis via discussion_append
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'cto analysis discussion (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE author = 'cto' AND kind = 'analysis';
