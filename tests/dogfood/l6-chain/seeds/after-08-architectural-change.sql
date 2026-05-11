-- Between-row seed: leftover Q+A audit rows on the architectural-change
-- issue. Kept for narrative continuity (the deliberation that produced
-- the decision row in row 8). Has no gating effect — the universal
-- decision gate just needs a kind='decision' row, which row 8 itself
-- produced. The scope-ambiguity gate is per-issue; later rows seed
-- their own issues.

INSERT INTO discussions (issue_id, author, kind, body, created_at)
SELECT id, 'bro', 'question', 'Q: keep the interface in src/cli.py for now or move it under src/storage/?', datetime('now')
FROM issues WHERE status IN ('open', 'closed') ORDER BY id DESC LIMIT 1;

INSERT INTO discussions (issue_id, author, kind, body, created_at)
SELECT id, 'user', 'answer', 'A: keep it in src/cli.py for the interface and JSON impl; split out only when the SQLite impl lands.', datetime('now')
FROM issues WHERE status IN ('open', 'closed') ORDER BY id DESC LIMIT 1;
