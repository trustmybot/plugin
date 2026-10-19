-- 21-move-milestone — bro moves the seeded count-subcommand issue from
-- v0.1.0 to the next milestone (v0.2.0) and relabels it low priority via
-- issue_update, without creating a new issue.

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'count-subcommand issues (got ' || COUNT(*) || ', expected =1 — no new issue)' AS description
FROM issues
WHERE LOWER(objective) LIKE '%count%';

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'count-subcommand issue on milestone v0.2.0 (got ' || COUNT(*) || ', expected =1)' AS description
FROM issues
WHERE objective = 'Add count subcommand to todo CLI' AND milestone = 'v0.2.0';

SELECT
  CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END AS pass,
  'count-subcommand issue labelled Priority: Low and not Priority: Medium (got ' || COUNT(*) || ', expected =1)' AS description
FROM issues
WHERE objective = 'Add count subcommand to todo CLI'
  AND EXISTS (SELECT 1 FROM json_each(issues.labels) WHERE value = 'Priority: Low')
  AND NOT EXISTS (SELECT 1 FROM json_each(issues.labels) WHERE value = 'Priority: Medium');

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue_updated audit rows changing milestone (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'issue_updated'
  AND EXISTS (SELECT 1 FROM json_each(audit.content_json, '$.changed') WHERE value = 'milestone');

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'issue_updated audit rows changing labels (got ' || COUNT(*) || ', expected >=1)' AS description
FROM audit
WHERE event_type = 'issue_updated'
  AND EXISTS (SELECT 1 FROM json_each(audit.content_json, '$.changed') WHERE value = 'labels');
