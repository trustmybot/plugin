import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend } from '../sync/backend.js';
import { buildBotPatterns, isBot } from '../sync/bot_patterns.js';
import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function defaultSpawnFn(cmd, args, opts) {
    const result = spawnSync(cmd, args, opts);
    return {
        status: result.status,
        stdout: result.stdout ? String(result.stdout) : '',
        stderr: result.stderr ? String(result.stderr) : '',
    };
}
function normalizePrState(raw) {
    const lower = raw.toLowerCase();
    if (lower === 'open' || lower === 'opened')
        return 'open';
    if (lower === 'merged')
        return 'merged';
    return 'closed';
}
function fetchGithubComments(prNumber, since, botPatterns, spawnFn) {
    const opts = { timeout: 15000, encoding: 'utf8' };
    const result = spawnFn('gh', ['pr', 'view', String(prNumber), '--json', 'comments,state,reviews'], opts);
    if (result.status !== 0)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        return null;
    }
    const prState = normalizePrState(parsed.state ?? '');
    const rawComments = [];
    for (const c of parsed.comments ?? []) {
        const id = c.id ?? String(c.databaseId ?? '');
        const author = c.author?.login ?? 'unknown';
        const created_at = c.createdAt ?? '';
        if (since && created_at && created_at <= since)
            continue;
        rawComments.push({
            id,
            author,
            author_kind: isBot(author, botPatterns) ? 'bot' : 'human',
            body: c.body ?? '',
            created_at,
            is_resolved: false,
        });
    }
    for (const review of parsed.reviews ?? []) {
        for (const c of review.comments ?? []) {
            const id = c.id ?? String(c.databaseId ?? '');
            const author = c.author?.login ?? 'unknown';
            const created_at = c.createdAt ?? '';
            if (since && created_at && created_at <= since)
                continue;
            const comment = {
                id,
                author,
                author_kind: isBot(author, botPatterns) ? 'bot' : 'human',
                body: c.body ?? '',
                created_at,
                is_resolved: c.isResolved ?? false,
            };
            if (c.path)
                comment.file_path = c.path;
            if (c.line !== undefined)
                comment.line = c.line;
            rawComments.push(comment);
        }
    }
    return { comments: rawComments, pr_state: prState, remote_kind: 'github' };
}
function fetchGitlabComments(prNumber, since, botPatterns, spawnFn) {
    const opts = { timeout: 15000, encoding: 'utf8' };
    const result = spawnFn('glab', ['mr', 'view', String(prNumber), '--comments', '--output', 'json'], opts);
    if (result.status !== 0)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        return null;
    }
    const prState = normalizePrState(parsed.state ?? '');
    const rawComments = [];
    for (const note of parsed.notes ?? []) {
        const id = String(note.id ?? '');
        const author = note.author?.username ?? 'unknown';
        const created_at = note.created_at ?? '';
        if (since && created_at && created_at <= since)
            continue;
        const comment = {
            id,
            author,
            author_kind: isBot(author, botPatterns) ? 'bot' : 'human',
            body: note.body ?? '',
            created_at,
            is_resolved: note.resolved ?? false,
        };
        if (note.position?.new_path)
            comment.file_path = note.position.new_path;
        if (note.position?.new_line !== undefined)
            comment.line = note.position.new_line;
        rawComments.push(comment);
    }
    return { comments: rawComments, pr_state: prState, remote_kind: 'gitlab' };
}
function resolveComments(backend, prNumber, since, botPatterns, spawnFn) {
    if (backend === 'off')
        return 'off';
    if (backend === 'gh') {
        return fetchGithubComments(prNumber, since, botPatterns, spawnFn);
    }
    if (backend === 'glab') {
        return fetchGitlabComments(prNumber, since, botPatterns, spawnFn);
    }
    if (backend === 'both') {
        return (fetchGithubComments(prNumber, since, botPatterns, spawnFn) ??
            fetchGitlabComments(prNumber, since, botPatterns, spawnFn));
    }
    return (fetchGithubComments(prNumber, since, botPatterns, spawnFn) ??
        fetchGitlabComments(prNumber, since, botPatterns, spawnFn));
}
export function prCommentsTools(db, _spawnFn) {
    const spawn = _spawnFn ?? defaultSpawnFn;
    const definitions = [
        {
            name: 'pr_comments_get',
            description: 'Fetch PR/MR comments from GitHub or GitLab. Returns structured comment list with bot/human classification, file/line metadata, and PR state.',
            inputSchema: {
                type: 'object',
                properties: {
                    pr_number: {
                        type: 'number',
                        description: 'PR or MR number to fetch comments for.',
                    },
                    repo: {
                        type: 'string',
                        description: 'Optional repo slug (owner/repo). Defaults to current git remote.',
                    },
                    since: {
                        type: 'string',
                        description: 'ISO 8601 timestamp. Only return comments created after this time. When omitted, the server reads the cursor from pr_review_runs.last_fetched_at so the next fetch returns only comments newer than the last one.',
                    },
                },
                required: ['pr_number'],
            },
        },
        {
            name: 'pr_review_runs_list',
            description: 'List incremental-polling cursors for /monitor. Returns one row per (pr_number, repo) with last_fetched_at + last_comment_id. Read-only diagnostic surface for the cursor wired by pr_comments_get.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    pr_number: {
                        type: 'number',
                        description: 'Optional filter — only return rows for this PR number.',
                    },
                    limit: { type: 'number', description: 'Optional — max rows to return. When provided, response includes next_cursor.' },
                    cursor: { type: 'string', description: 'Opaque cursor from a previous response.' },
                },
            },
        },
    ];
    const handlers = {
        pr_comments_get: requireRoles('pr_comments_get', ['bro'], async (args) => {
            const prNumber = Number(args['pr_number']);
            if (!Number.isInteger(prNumber) || prNumber <= 0) {
                return err('pr_number must be a positive integer');
            }
            const repo = typeof args['repo'] === 'string' ? args['repo'] : '';
            // Wire incremental polling: prefer the explicit `since` arg, otherwise
            // read the cursor from pr_review_runs and pass `last_fetched_at` as the
            // since-filter on the next backend fetch.
            let since = typeof args['since'] === 'string' ? args['since'] : undefined;
            if (since === undefined) {
                const cursor = db.get(`SELECT last_fetched_at FROM pr_review_runs WHERE pr_number = ? AND repo = ?`, [prNumber, repo]);
                if (cursor?.last_fetched_at)
                    since = cursor.last_fetched_at;
            }
            const configRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
            const configValue = configRow ? JSON.parse(configRow.value_json) : 'auto';
            let backend;
            if (configValue === 'off') {
                const ghAvail = spawn('gh', ['auth', 'status'], { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' }).status === 0;
                if (ghAvail) {
                    backend = 'gh';
                }
                else {
                    const glabAvail = spawn('glab', ['auth', 'status'], { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' }).status === 0;
                    if (!glabAvail) {
                        return err('Neither gh nor glab is installed/available; cannot fetch PR comments');
                    }
                    backend = 'glab';
                }
            }
            else {
                backend = resolveBackend(configValue);
            }
            const configBots = db.get(`SELECT value_json FROM plugin_config WHERE key = 'pr_review_bots'`);
            let botsOverride = '';
            if (configBots) {
                try {
                    const parsed = JSON.parse(configBots.value_json);
                    if (typeof parsed === 'string')
                        botsOverride = parsed;
                }
                catch {
                    // malformed config row — fall through to defaults
                }
            }
            const botPatterns = buildBotPatterns(botsOverride);
            const fetchResult = resolveComments(backend, prNumber, since, botPatterns, spawn);
            if (fetchResult === 'off') {
                return err('Failed to fetch PR comments — check gh/glab auth and PR number');
            }
            if (!fetchResult) {
                return err('Failed to fetch PR comments — check gh/glab auth and PR number');
            }
            const now = nowISO();
            const lastCommentId = fetchResult.comments.length > 0
                ? (fetchResult.comments[fetchResult.comments.length - 1]?.id ?? null)
                : null;
            // Upsert the cursor: a re-fetch of the same (pr_number, repo) should
            // overwrite last_fetched_at + last_comment_id rather than insert a
            // duplicate row. Idempotency comes from idx_pr_review_runs_pr (UNIQUE).
            db.run(`INSERT INTO pr_review_runs
          (pr_number, repo, last_fetched_at, last_comment_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pr_number, repo) DO UPDATE SET
           last_fetched_at = excluded.last_fetched_at,
           last_comment_id = excluded.last_comment_id`, [prNumber, repo, now, lastCommentId]);
            return ok(fetchResult);
        }),
        pr_review_runs_list: requireRoles('pr_review_runs_list', ['bro'], async (args) => {
            const prFilter = args['pr_number'];
            const filterPrNumber = prFilter === undefined || prFilter === null ? null : Number(prFilter);
            if (filterPrNumber !== null && (!Number.isInteger(filterPrNumber) || filterPrNumber <= 0)) {
                return err('pr_number must be a positive integer when provided');
            }
            const limitArg = args['limit'];
            const cursorArg = args['cursor'];
            if (limitArg === undefined || limitArg === null) {
                const rows = filterPrNumber === null
                    ? db.all('SELECT id, pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs ORDER BY pr_number, repo')
                    : db.all('SELECT id, pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs WHERE pr_number = ? ORDER BY repo', [filterPrNumber]);
                return ok({ rows, count: rows.length });
            }
            const limit = Math.min(Math.max(1, limitArg), 500);
            let cursorFilter = '';
            let cursorParams = [];
            if (cursorArg) {
                try {
                    const decoded = JSON.parse(Buffer.from(cursorArg, 'base64').toString('utf8'));
                    if (typeof decoded.id === 'number') {
                        cursorFilter = 'AND id > ?';
                        cursorParams = [decoded.id];
                    }
                }
                catch {
                    // ignore invalid cursor
                }
            }
            const whereBase = filterPrNumber !== null ? 'WHERE pr_number = ? ' : 'WHERE 1=1 ';
            const baseParams = filterPrNumber !== null ? [filterPrNumber] : [];
            const sql = 'SELECT id, pr_number, repo, last_fetched_at, last_comment_id FROM pr_review_runs ' +
                whereBase +
                cursorFilter +
                ' ORDER BY id ASC LIMIT ?';
            const fetchedRows = db.all(sql, [...baseParams, ...cursorParams, limit + 1]);
            const hasMore = fetchedRows.length > limit;
            const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
            const last = rows[rows.length - 1];
            const next_cursor = hasMore && last
                ? Buffer.from(JSON.stringify({ id: last.id })).toString('base64')
                : undefined;
            return ok({ rows, count: rows.length, next_cursor });
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=pr_comments.js.map