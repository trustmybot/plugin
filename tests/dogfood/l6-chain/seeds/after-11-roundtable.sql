-- Between-row seed: post-AUQ ratification for row 11's roundtable. Injects
-- the Human's ratify=true vote so the roundtable can close on schedule.

INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at)
SELECT id, 'human', 'ratify', 'L6 chain bridge: row 11 ratification (test mode AUQ suppressed)', datetime('now')
FROM roundtables ORDER BY id DESC LIMIT 1;
