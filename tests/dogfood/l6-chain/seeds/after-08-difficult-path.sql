-- Between-row seed: post-AUQ Q+A for row 8's difficult-path planning loop.
-- Injects kind='question' + kind='answer' rows on the most-recent open issue
-- so row 9 can proceed with the difficult-path artefacts in place.

INSERT INTO discussions (issue_id, author, kind, body, created_at)
SELECT id, 'bro', 'question', 'Q: which storage backend should the TODO CLI migrate to?', datetime('now')
FROM issues WHERE status = 'open' ORDER BY id DESC LIMIT 1;

INSERT INTO discussions (issue_id, author, kind, body, created_at)
SELECT id, 'user', 'answer', 'A: SQLite — single-file, dependency-free, supports concurrent reads.', datetime('now')
FROM issues WHERE status = 'open' ORDER BY id DESC LIMIT 1;
