-- 03-consultant-architect-read — substantive checks live in
-- tools-required.json (`agent_list` + `Agent` must both fire). This SQL
-- placeholder is here so the outcome scorer has at least one assertion.
--
-- KNOWN GAP (filed separately): the architect template says "Persist key
-- points via discussion_append(kind='analysis')" but the wording is
-- permissive, so the architect's analysis isn't always recorded as a
-- discussions row. Tightening the template is tracked in a follow-up
-- issue. Until then, this scenario doesn't assert discussions(kind='analysis').

SELECT 1 AS pass, 'consultant scenario ran (substantive checks: tools-required asserts agent_list + Agent both fire)' AS description;
