-- 17-audit-request — bro audits the add -> list round trip with tmb_audit
-- and records its findings as a discussion. The fixture and setup seed no
-- discussions, so any row here was written this run.

SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'audit findings recorded as a discussion naming list (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE LOWER(body) LIKE '%list%';

-- The seeded store holds 12 items and list prints 10; a finding that names
-- either number or the drop shows the audit measured the data.
SELECT
  CASE WHEN COUNT(*) >= 1 THEN 1 ELSE 0 END AS pass,
  'a discussion reports the dropped items (got ' || COUNT(*) || ', expected >=1)' AS description
FROM discussions
WHERE LOWER(body) LIKE '%list%'
  AND (body LIKE '%12%' OR body LIKE '%10%'
       OR LOWER(body) LIKE '%drop%' OR LOWER(body) LIKE '%truncat%'
       OR LOWER(body) LIKE '%missing%');
