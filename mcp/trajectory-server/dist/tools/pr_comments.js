import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend } from '../sync/backend.js';
import { buildBotPatterns, isBot } from '../sync/bot_patterns.js';
import { spawnSync } from 'node:child_process';
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
                        description: 'ISO 8601 timestamp. Only return comments created after this time.',
                    },
                },
                required: ['pr_number'],
            },
        },
    ];
    const handlers = {
        pr_comments_get: requireRoles('pr_comments_get', ['bro'], async (args) => {
            const prNumber = Number(args['pr_number']);
            if (!Number.isInteger(prNumber) || prNumber <= 0) {
                return err('pr_number must be a positive integer');
            }
            const since = typeof args['since'] === 'string' ? args['since'] : undefined;
            const configRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
            const configValue = configRow ? JSON.parse(configRow.value_json) : 'auto';
            const backend = resolveBackend(configValue);
            const configBots = db.get(`SELECT value_json FROM plugin_config WHERE key = 'pr_review_bots'`);
            const botsOverride = configBots ? JSON.parse(configBots.value_json) : '';
            const botPatterns = buildBotPatterns(botsOverride);
            const fetchResult = resolveComments(backend, prNumber, since, botPatterns, spawn);
            if (fetchResult === 'off') {
                return err('Remote sync is disabled (issue_sync=off)');
            }
            if (!fetchResult) {
                return err('Failed to fetch PR comments — check gh/glab auth and PR number');
            }
            const repo = typeof args['repo'] === 'string' ? args['repo'] : '';
            const now = nowISO();
            const lastCommentId = fetchResult.comments.length > 0
                ? (fetchResult.comments[fetchResult.comments.length - 1]?.id ?? null)
                : null;
            db.run(`INSERT INTO pr_review_runs
          (pr_number, repo, remote_kind, last_fetched_at, last_comment_id,
           comments_processed, tasks_created)
         VALUES (?, ?, ?, ?, ?, ?, 0)`, [prNumber, repo, fetchResult.remote_kind, now, lastCommentId, fetchResult.comments.length]);
            return ok(fetchResult);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=pr_comments.js.map