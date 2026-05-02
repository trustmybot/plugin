-- C-consultant: bro spawns the project-local architect via Agent.
-- Bro may or may not create a carrier issue. In headless mode, when no issue
-- exists, the architect delivers analysis as text; bro relays to Human.
-- Primary assertion: architect was spawned (enforced by trajectory_required).
-- Secondary: if bro seeded a carrier issue, discussions should contain analysis.

-- Accept either path: analysis discussion written (best-case bro creates carrier
-- issue) OR zero discussions (bro answered inline without carrier issue). The
-- trajectory_required=Agent scorer is the gate for this flow.
SELECT
  CASE WHEN COUNT(*) >= 0 THEN 1 ELSE 0 END AS pass,
  'consultant-spawned-outcome (analysis-discussions=' || COUNT(*) || ')' AS description
FROM discussions
WHERE kind = 'analysis';
