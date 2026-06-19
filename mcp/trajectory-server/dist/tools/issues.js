import { resolveRepoForSync } from '../utils/repo-paths.js';
import { nowISO } from '../db.js';
import { normalizeAgent, redactIssue, requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend, detectPreferred } from '../sync/backend.js';
import { syncIssueCreate, syncIssueClose, isSyncFailure, repoSlugFromRemoteUrl } from '../sync/issue_sync.js';
import { serverLog } from '../logger.js';
// Mandatory issue tagging (#93/#777): every issue must carry one priority tag
// AND one classification tag. The valid sets are configurable per project via
// plugin_config (issue_classification_labels / issue_priority_labels); when
// unset, a small GENERIC default applies. Validation stays fail-closed — only
// the *contents* of the valid sets are project-specific, not the requirement.
// Generic, project-agnostic default. A project (incl. TMB itself) overrides
// these via config_set issue_classification_labels / issue_priority_labels.
const DEFAULT_CLASSIFICATION_LABELS = [
    'Bug',
    'Feature',
    'Improvement',
    'Docs',
    'Test',
    'Chore',
];
const DEFAULT_PRIORITY_LABELS = [
    'Priority: Urgent',
    'Priority: High',
    'Priority: Medium',
    'Priority: Low',
];
// Read a string[] config key from plugin_config; returns null when unset or
// malformed so the caller can fall back to the generic default.
function readStringArrayConfig(db, key) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = ?`, [key]);
    if (!row)
        return null;
    try {
        const parsed = JSON.parse(row.value_json);
        if (Array.isArray(parsed) &&
            parsed.length > 0 &&
            parsed.every((v) => typeof v === 'string')) {
            return parsed;
        }
    }
    catch {
        // malformed config row — fall through to the generic default
    }
    return null;
}
// Resolve the configured (or generic-default) classification + priority sets
// for the active project. The validator matches a label against the resolved
// sets by exact membership.
function resolveLabelTaxonomy(db) {
    const classification = readStringArrayConfig(db, 'issue_classification_labels') ?? [
        ...DEFAULT_CLASSIFICATION_LABELS,
    ];
    const priorityLabels = readStringArrayConfig(db, 'issue_priority_labels') ?? [
        ...DEFAULT_PRIORITY_LABELS,
    ];
    return { classification, priorityLabels };
}
// Fail closed: reject unless the labels arg satisfies BOTH required categories,
// checked against the project's configured (or generic-default) taxonomy.
// Returns a named error string listing what is missing and the valid options,
// or null when the labels are valid. Extra labels (in neither set) are allowed.
function validateIssueLabels(db, labels) {
    const { classification, priorityLabels } = resolveLabelTaxonomy(db);
    const classificationSet = new Set(classification);
    const prioritySet = new Set(priorityLabels);
    const hasPriority = labels.some((l) => prioritySet.has(l));
    const hasClassification = labels.some((l) => classificationSet.has(l));
    if (hasPriority && hasClassification)
        return null;
    const missing = [];
    if (!hasClassification) {
        missing.push(`a classification label (one of: ${classification.join(', ')})`);
    }
    if (!hasPriority) {
        missing.push(`a priority label (one of: ${priorityLabels.join(', ')})`);
    }
    return `missing_required_labels: issue_create requires ${missing.join(' AND ')}. Got labels: [${labels.join(', ')}]`;
}
// Dedup pre-check (#91/#775): before inserting, compare the new objective
// against every OPEN issue's objective with a deterministic token-set Jaccard
// overlap. A normalized-equal or high-overlap match is treated as a likely
// duplicate so bro can link/override instead of forking a second issue.
const DEDUP_THRESHOLD = 0.6;
// Normalize: lowercase, strip punctuation, collapse whitespace, tokenize.
export function normalizeObjective(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 0);
}
// Token-set Jaccard similarity (|A∩B| / |A∪B|). Deterministic, pure. Two
// empty token sets are treated as identical (similarity 1).
export function objectiveSimilarity(a, b) {
    const setA = new Set(normalizeObjective(a));
    const setB = new Set(normalizeObjective(b));
    if (setA.size === 0 && setB.size === 0)
        return 1;
    let intersection = 0;
    for (const t of setA) {
        if (setB.has(t))
            intersection += 1;
    }
    const union = setA.size + setB.size - intersection;
    if (union === 0)
        return 0;
    return intersection / union;
}
// Sync paths pass labels through to the remote (GitLab / GitHub) via
// syncIssueCreate, but they aren't persisted in the local issues table.
function decodeIssue(row) {
    return { ...row };
}
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function requireArg(args, name) {
    if (args[name] === undefined || args[name] === null) {
        throw new Error(`Missing required arg: ${name}`);
    }
    return args[name];
}
function wrapHandler(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
function resolveIssueSyncContext(db, repoName) {
    const resolved = resolveRepoForSync(db, repoName);
    if (!resolved)
        return null;
    return {
        repoName: resolved.name,
        cwd: resolved.path,
        remoteFor(backend) {
            const provider = backend === 'gh' ? 'github' : 'gitlab';
            const entry = resolved.remotes.find((r) => r.provider === provider);
            if (!entry)
                return null;
            return { url: entry.url, slug: repoSlugFromRemoteUrl(entry.url) };
        },
    };
}
// Fire the remote (GitHub/GitLab) issue-close for whatever remotes the row is
// linked to. The local `issues.status='closed'` UPDATE is the caller's
// responsibility — this is only the remote-sync half. Sync failures are logged,
// never thrown: a remote hiccup must not fail the local close. Shared by
// `issue_close` and `bro_atomic_close` so the composite can't drift the remote
// open while closing locally (#277).
export async function syncIssueCloseRemotes(db, dbPath, issueId, spawnFn) {
    const remoteRow = db.get(`SELECT remote_iid, remote_kind, gh_iid, gl_iid, repo FROM issues WHERE id = ?`, [issueId]);
    // Issue-scoped sync (#155/#146): resolve cwd + per-backend repo slug from the
    // issue's repo. When unresolvable, fall back to no explicit cwd/slug — a
    // best-effort close must not throw (the local close already happened).
    const closeCtx = resolveIssueSyncContext(db, remoteRow?.repo ?? null);
    const closeCwd = closeCtx?.cwd;
    const closeTargets = [];
    if (remoteRow?.gh_iid != null) {
        closeTargets.push({ remote_iid: remoteRow.gh_iid, remote_kind: 'github' });
    }
    else if (remoteRow?.remote_iid != null && remoteRow.remote_kind === 'github') {
        closeTargets.push({ remote_iid: remoteRow.remote_iid, remote_kind: 'github' });
    }
    if (remoteRow?.gl_iid != null) {
        closeTargets.push({ remote_iid: remoteRow.gl_iid, remote_kind: 'gitlab' });
    }
    else if (remoteRow?.remote_iid != null && remoteRow.remote_kind === 'gitlab') {
        closeTargets.push({ remote_iid: remoteRow.remote_iid, remote_kind: 'gitlab' });
    }
    for (const target of closeTargets) {
        const closeSlug = closeCtx?.remoteFor(target.remote_kind === 'github' ? 'gh' : 'glab')?.slug ?? undefined;
        const closeResult = await syncIssueClose({
            remote_iid: target.remote_iid,
            remote_kind: target.remote_kind,
            _cwd: closeCwd,
            _repoSlug: closeSlug,
            _spawnFn: spawnFn,
        });
        if (!closeResult.ok) {
            serverLog({
                event: 'issue_close_sync_failed',
                issueId,
                remote_iid: target.remote_iid,
                remote_kind: target.remote_kind,
                reason: closeResult.reason,
                exit_code: closeResult.exit_code,
                stderr: closeResult.stderr?.slice(0, 1024),
                message: closeResult.message,
            });
        }
    }
}
export function issueTools(db, dbPath = '') {
    const definitions = [
        {
            name: 'issue_create',
            description: 'Create a new issue with an objective and an optional full markdown description.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Caller agent name' },
                    objective: { type: 'string', description: 'Short one-liner summary' },
                    description: { type: 'string', description: 'Full issue description: requirements, context, acceptance criteria. Markdown. Gated from SWE for info isolation.' },
                    labels: { type: 'array', items: { type: 'string' }, description: 'Required. Must include at least one priority label AND at least one classification label, drawn from the project\'s configured taxonomy (plugin_config issue_priority_labels / issue_classification_labels) or the generic default (priority: Priority: Urgent|High|Medium|Low; classification: Bug, Feature, Improvement, Docs, Test, Chore). Extra labels are allowed. Applied to the remote issue.' },
                    milestone: { type: 'string', description: 'Optional milestone name (e.g. "v1.2.0"). Persisted on the issue row and set on the remote issue. Omit for no milestone.' },
                    repo: { type: 'string', description: 'Optional repo name (matches a repos row) this issue belongs to. Drives issue-scoped sync (explicit gh --repo / glab -R from that repo\'s remotes). Defaults to the sole/managed repo when exactly one repos row exists.' },
                    allow_duplicate: { type: 'boolean', description: 'When true, skip the open-issue dedup pre-check and create even if an existing open issue closely matches the objective. Default false: a likely duplicate returns { duplicate: true, duplicate_of } instead of creating.' },
                },
                required: ['agent', 'objective', 'labels'],
            },
        },
        {
            name: 'issue_get',
            description: 'Fetch a single issue by ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string', description: 'The issue string ID' },
                    include_description: { type: 'boolean', description: 'Whether to include the full description (default false). Architect + bro only.' },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_resume',
            description: 'Return an issue with its first actionable pending/failed task.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_close',
            description: 'Close an issue by setting its status to closed.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_get_phase',
            description: 'Return the current workflow phase and task completion counts for an issue.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_list',
            description: 'List issues ordered by updated_at DESC. Returns a thin index (id, objective, status, created_at, updated_at). Optional fields projection via fields=[\'id\',\'status\',\'objective\']; unknown fields return a named error.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    status: {
                        type: 'string',
                        enum: ['open', 'closed'],
                        description: 'Optional status filter. Omit to return all issues.',
                    },
                    limit: { type: 'number', description: 'Max rows. Default 50, max 200.' },
                    offset: { type: 'number', description: 'Row offset. Default 0.' },
                    fields: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional column projection. Allowed: id, objective, status, created_at, updated_at. Unknown fields return a named error. Default: all five columns.',
                    },
                },
                required: ['agent'],
            },
        },
        {
            name: 'issue_update_description',
            description: "Update an issue's description. Used by bro to backfill issues whose descriptions were truncated on import (e.g., from Linear).",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
                    issue_id: { type: 'string', description: 'Issue ID as string' },
                    description: { type: 'string', description: 'Full markdown description (no length cap)' },
                },
                required: ['agent', 'issue_id', 'description'],
            },
        },
        {
            name: 'issue_sync_retry',
            description: 'Manually retry remote sync for an issue where auto-sync failed. Bro only.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
                    issue_id: { type: 'string', description: 'Issue ID as string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_link',
            description: 'Record a remote issue linkage (gh_iid/gl_iid) for a manually-mirrored issue. Bro only. Rejects if the backend iid is already set unless force=true.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
                    issue_id: { type: 'string', description: 'Local issue ID' },
                    backend: { type: 'string', enum: ['github', 'gitlab'], description: 'Remote backend' },
                    iid: { type: 'number', description: 'Remote issue number' },
                    force: { type: 'boolean', description: 'Overwrite existing iid if already set (default false)' },
                },
                required: ['agent', 'issue_id', 'backend', 'iid'],
            },
        },
    ];
    const handlers = {
        issue_create: requireRoles('issue_create', ['bro'], wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            requireArg(args, 'objective');
            const objective = args['objective'];
            const description = args['description'] ?? '';
            // labels: pass-through to remote sync; not persisted locally after #179.
            const labels = args['labels'] ?? [];
            // Mandatory tagging (#93/#777): fail closed before any insert/sync.
            const labelError = validateIssueLabels(db, labels);
            if (labelError !== null) {
                return err(labelError);
            }
            // Dedup pre-check (#91/#775): unless explicitly overridden, refuse to
            // fork a second open issue for objective-equivalent work. Deterministic
            // token-set Jaccard against every OPEN issue; the best match at/above the
            // threshold (or a normalized-equal objective) short-circuits the insert.
            const allowDuplicate = args['allow_duplicate'] ?? false;
            if (!allowDuplicate) {
                const openIssues = db.all(`SELECT id, objective FROM issues WHERE status = 'open'`);
                let best = null;
                for (const candidate of openIssues) {
                    const similarity = objectiveSimilarity(objective, candidate.objective);
                    if (best === null || similarity > best.similarity) {
                        best = { id: candidate.id, objective: candidate.objective, similarity };
                    }
                }
                if (best !== null && best.similarity >= DEDUP_THRESHOLD) {
                    return ok({
                        duplicate: true,
                        duplicate_of: best.id,
                        matched_objective: best.objective,
                        similarity: best.similarity,
                    });
                }
            }
            // milestone: optional; persisted locally AND passed to remote sync (#83/#763).
            const milestone = args['milestone'] ?? null;
            // repo (#155): explicit arg, else the sole/managed repo when exactly one
            // repos row exists. Null for an ambiguous multi-repo install with no
            // selector — the FK is nullable so the insert still succeeds.
            const explicitRepo = args['repo'] ?? null;
            const issueRepo = explicitRepo ?? resolveRepoForSync(db, null)?.name ?? null;
            // _spawnFn: test-only injection point; not in inputSchema
            const spawnFn = args['_spawnFn'] ?? undefined;
            const now = nowISO();
            db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo)
         VALUES (?, ?, 'open', ?, ?, ?, ?)`, [objective, description, now, now, milestone, issueRepo]);
            const rowId = db.get(`SELECT id FROM issues WHERE rowid = last_insert_rowid()`);
            if (!rowId) {
                throw new Error('issue_create: failed to retrieve inserted row');
            }
            const issueId = rowId.id;
            const syncConfigRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
            const syncConfig = syncConfigRow
                ? JSON.parse(syncConfigRow.value_json)
                : 'off';
            // #2871 — collect any sync diagnostic that the caller (bro) should
            // see inline. The trajectory log alone is invisible to the agent.
            let syncDiagnostic;
            if (syncConfig !== 'off') {
                const backend = resolveBackend(syncConfig, !!spawnFn);
                if (backend === null) {
                    serverLog({ event: 'issue_sync_skip', reason: 'no_remote_configured', issueId });
                }
                else if (backend !== 'off') {
                    // Issue-scoped sync (#155/#146): resolve cwd + per-backend remote
                    // from the issue's repo. Unresolvable repo while sync is on → named
                    // error rather than a silent process.cwd() sync.
                    const syncCtx = resolveIssueSyncContext(db, issueRepo);
                    if (syncCtx === null) {
                        serverLog({ event: 'issue_sync_skip', reason: 'unresolvable_repo', issueId, repo: issueRepo, backend });
                        syncDiagnostic = {
                            sync_failed: true,
                            reason: 'unresolvable_repo',
                            repo: issueRepo,
                            backend,
                            hint: issueRepo
                                ? `issue repo "${issueRepo}" has no matching repos row — run /scan or pass a valid repo.`
                                : 'multiple repos registered and no issue repo selected — pass repo= on issue_create.',
                        };
                        const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
                        const issue = decodeIssue(row);
                        const redacted = redactIssue(issue, agent, { include_description: true });
                        const payload = { ...redacted };
                        payload._sync = syncDiagnostic;
                        return ok(payload);
                    }
                    const syncCwd = syncCtx.cwd;
                    if (backend === 'both') {
                        const ghRemote = syncCtx.remoteFor('gh');
                        const glRemote = syncCtx.remoteFor('glab');
                        const ghRemoteUrl = ghRemote?.url ?? null;
                        const glRemoteUrl = glRemote?.url ?? null;
                        const ghBlank = !ghRemoteUrl;
                        const glBlank = !glRemoteUrl;
                        if (ghBlank && glBlank) {
                            serverLog({ event: 'issue_sync_skip', reason: 'blank_remote_url', issueId, backend });
                            syncDiagnostic = {
                                sync_skipped: true,
                                reason: 'blank_remote_url',
                                backend,
                                hint: 'Configure remote URLs via /onboard before syncing issues.',
                            };
                        }
                        else {
                            const [ghResult, glResult] = await Promise.all([
                                !ghBlank
                                    ? syncIssueCreate({
                                        issueId,
                                        title: objective,
                                        body: description,
                                        labels,
                                        milestone: milestone ?? undefined,
                                        _backend: 'gh',
                                        _spawnFn: spawnFn,
                                        _cwd: syncCwd,
                                        _remoteUrl: ghRemoteUrl ?? undefined,
                                        _repoSlug: ghRemote?.slug ?? undefined,
                                    })
                                    : Promise.resolve({ ok: false, reason: 'no_backend', backend: 'gh', message: 'blank remote URL for gh' }),
                                !glBlank
                                    ? syncIssueCreate({
                                        issueId,
                                        title: objective,
                                        body: description,
                                        labels,
                                        milestone: milestone ?? undefined,
                                        _backend: 'glab',
                                        _spawnFn: spawnFn,
                                        _cwd: syncCwd,
                                        _remoteUrl: glRemoteUrl ?? undefined,
                                        _repoSlug: glRemote?.slug ?? undefined,
                                    })
                                    : Promise.resolve({ ok: false, reason: 'no_backend', backend: 'glab', message: 'blank remote URL for glab' }),
                            ]);
                            const ghIid = !isSyncFailure(ghResult) && ghResult.remote_kind === 'github'
                                ? ghResult.remote_iid : null;
                            const glIid = !isSyncFailure(glResult) && glResult.remote_kind === 'gitlab'
                                ? glResult.remote_iid : null;
                            const firstSuccess = !isSyncFailure(ghResult) ? ghResult
                                : !isSyncFailure(glResult) ? glResult : null;
                            if (firstSuccess !== null) {
                                db.run(`UPDATE issues SET remote_iid = ?, remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`, [firstSuccess.remote_iid, firstSuccess.remote_kind, ghIid, glIid, now, issueId]);
                            }
                            else {
                                const failures = [];
                                if (isSyncFailure(ghResult)) {
                                    serverLog({ event: 'issue_sync_failed', issueId, backend: 'gh', reason: ghResult.reason, exit_code: ghResult.exit_code, stderr: ghResult.stderr?.slice(0, 1024), message: ghResult.message });
                                    failures.push('gh');
                                }
                                if (isSyncFailure(glResult)) {
                                    serverLog({ event: 'issue_sync_failed', issueId, backend: 'glab', reason: glResult.reason, exit_code: glResult.exit_code, stderr: glResult.stderr?.slice(0, 1024), message: glResult.message });
                                    failures.push('glab');
                                }
                                syncDiagnostic = {
                                    sync_failed: true,
                                    reason: 'both_remotes_failed',
                                    backends: failures,
                                    hint: 'Try `issue_sync_retry` or run the underlying gh/glab command manually to debug.',
                                };
                            }
                            if (ghIid !== null || glIid !== null) {
                                const partial = [];
                                if (isSyncFailure(ghResult))
                                    partial.push('gh');
                                if (isSyncFailure(glResult))
                                    partial.push('glab');
                                if (partial.length > 0) {
                                    syncDiagnostic = {
                                        sync_partial: true,
                                        failed_backends: partial,
                                        gh_iid: ghIid,
                                        gl_iid: glIid,
                                        hint: 'Try `issue_sync_retry` to retry the failed remote.',
                                    };
                                }
                            }
                        }
                    }
                    else {
                        const remote = syncCtx.remoteFor(backend);
                        const remoteUrl = remote?.url ?? null;
                        if (!remoteUrl) {
                            serverLog({ event: 'issue_sync_skip', reason: 'blank_remote_url', issueId, backend });
                            syncDiagnostic = {
                                sync_skipped: true,
                                reason: 'blank_remote_url',
                                backend,
                                hint: 'Configure remote URLs via /onboard before syncing issues.',
                            };
                        }
                        else {
                            const syncResult = await syncIssueCreate({
                                issueId,
                                title: objective,
                                body: description,
                                labels,
                                milestone: milestone ?? undefined,
                                _backend: backend,
                                _spawnFn: spawnFn,
                                _cwd: syncCwd,
                                _remoteUrl: remoteUrl ?? undefined,
                                _repoSlug: remote?.slug ?? undefined,
                            });
                            if (!isSyncFailure(syncResult)) {
                                const ghIid = syncResult.remote_kind === 'github' ? syncResult.remote_iid : null;
                                const glIid = syncResult.remote_kind === 'gitlab' ? syncResult.remote_iid : null;
                                db.run(`UPDATE issues SET remote_iid = ?, remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`, [syncResult.remote_iid, syncResult.remote_kind, ghIid, glIid, now, issueId]);
                            }
                            else {
                                serverLog({
                                    event: 'issue_sync_failed',
                                    issueId,
                                    backend,
                                    reason: syncResult.reason,
                                    exit_code: syncResult.exit_code,
                                    stderr: syncResult.stderr?.slice(0, 1024),
                                    message: syncResult.message,
                                });
                                syncDiagnostic = {
                                    sync_failed: true,
                                    reason: syncResult.reason,
                                    backend: syncResult.backend,
                                    exit_code: syncResult.exit_code,
                                    stderr: syncResult.stderr?.slice(0, 4096),
                                    stdout: syncResult.stdout?.slice(0, 4096),
                                    message: syncResult.message,
                                    hint: 'Try `issue_sync_retry` or run the underlying gh/glab command manually to debug.',
                                };
                            }
                        }
                    }
                }
            }
            else {
                // issue_sync='off' — leave a retryable audit marker so issue_sync_retry
                // can later create remotes once sync is re-enabled (#336).
                db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
           VALUES (?, 'executor', 'sync_skipped', ?, ?, ?)`, [
                    issueId,
                    `issue ${issueId} sync skipped: issue_sync is off`,
                    JSON.stringify({ issue_id: issueId, reason: 'issue_sync_off' }),
                    nowISO(),
                ]);
                // Surface a warning when the project clearly looks remote-tracked (git
                // origin is gh/glab) but sync is disabled, so bro can mention the drift.
                const preferred = detectPreferred();
                if (preferred !== null) {
                    syncDiagnostic = {
                        sync_skipped: true,
                        reason: 'issue_sync is "off" but origin points at ' + preferred,
                        hint: 'If this project should mirror issues to the remote, run `config_set(key="issue_sync", value="auto")`.',
                    };
                }
            }
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            const issue = decodeIssue(row);
            const redacted = redactIssue(issue, agent, { include_description: true });
            const payload = { ...redacted };
            if (syncDiagnostic)
                payload._sync = syncDiagnostic;
            return ok(payload);
        })),
        issue_get: wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const includeDescription = args['include_description'] ?? false;
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                throw new Error(`Not found: ${issueId}`);
            }
            const issue = decodeIssue(row);
            return ok(redactIssue(issue, agent, { include_description: includeDescription }));
        }),
        issue_resume: wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            const issueId = requireArg(args, 'issue_id');
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                throw new Error(`Not found: ${issueId}`);
            }
            const issue = decodeIssue(row);
            const task = db.get(`SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`, [issueId]);
            return ok({ issue: redactIssue(issue, agent), next_task: task ?? null });
        }),
        issue_close: requireRoles('issue_close', ['bro'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const now = nowISO();
            const existing = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!existing) {
                throw new Error(`Not found: ${issueId}`);
            }
            db.run(`UPDATE issues
         SET status = 'closed', updated_at = ?, closed_at = COALESCE(closed_at, ?)
         WHERE id = ?`, [now, now, issueId]);
            await syncIssueCloseRemotes(db, dbPath, issueId, args['_spawnFn']);
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok(decodeIssue(updated));
        })),
        issue_get_phase: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const issueRow = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!issueRow) {
                throw new Error(`Not found: ${issueId}`);
            }
            const issue = decodeIssue(issueRow);
            const rawCounts = db.get(`SELECT
           COUNT(*) as tasks_total,
           SUM(CASE WHEN status IN ('completed', 'closed') THEN 1 ELSE 0 END) as tasks_completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as tasks_failed
         FROM tasks WHERE issue_id = ?`, [issueId]);
            const counts = {
                tasks_total: rawCounts?.tasks_total ?? 0,
                tasks_completed: rawCounts?.tasks_completed ?? 0,
                tasks_failed: rawCounts?.tasks_failed ?? 0,
            };
            let phase;
            if (issue.status === 'closed') {
                phase = 'done';
            }
            else if (counts.tasks_total === 0) {
                phase = 'discussion';
            }
            else if (counts.tasks_completed >= counts.tasks_total) {
                phase = 'ready_to_close';
            }
            else {
                phase = 'tasks';
            }
            return ok({ phase, counts });
        }),
        issue_list: wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            const rawStatus = args['status'];
            const rawLimit = args['limit'] ?? 50;
            const rawOffset = args['offset'] ?? 0;
            const fieldsArg = args['fields'];
            const limit = Math.min(Math.max(1, rawLimit), 200);
            const offset = Math.max(0, rawOffset);
            const VALID_ISSUE_STATUSES = new Set(['open', 'closed']);
            if (rawStatus !== undefined && !VALID_ISSUE_STATUSES.has(rawStatus)) {
                return err(`Invalid status: "${rawStatus}". Allowed values: ${[...VALID_ISSUE_STATUSES].join(', ')}`);
            }
            const ALLOWED_ISSUE_LIST_FIELDS = new Set(['id', 'objective', 'status', 'created_at', 'updated_at']);
            if (fieldsArg !== undefined) {
                const unknown = fieldsArg.filter((f) => !ALLOWED_ISSUE_LIST_FIELDS.has(f));
                if (unknown.length > 0) {
                    return err(`Unknown fields: ${unknown.join(', ')}. Allowed: ${[...ALLOWED_ISSUE_LIST_FIELDS].join(', ')}`);
                }
            }
            function projectRow(row) {
                if (!fieldsArg)
                    return row;
                const out = {};
                for (const f of fieldsArg)
                    out[f] = row[f];
                return out;
            }
            let rows;
            if (rawStatus !== undefined) {
                rows = db.all('SELECT id, objective, status, created_at, updated_at FROM issues WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?', [rawStatus, limit, offset]);
            }
            else {
                rows = db.all('SELECT id, objective, status, created_at, updated_at FROM issues ORDER BY updated_at DESC LIMIT ? OFFSET ?', [limit, offset]);
            }
            return ok(rows.map(projectRow));
        }),
        issue_update_description: requireRoles('issue_update_description', ['bro'], wrapHandler(async (args) => {
            const issueId = requireArg(args, 'issue_id');
            const description = requireArg(args, 'description');
            const MAX_DESCRIPTION_BYTES = 1024 * 1024; // 1MB
            if (Buffer.byteLength(description, 'utf8') > MAX_DESCRIPTION_BYTES) {
                return err('description exceeds 1MB limit');
            }
            const existing = db.get('SELECT id FROM issues WHERE id = ?', [issueId]);
            if (!existing) {
                return err(`not_found: issue ${issueId}`);
            }
            const now = nowISO();
            db.run('UPDATE issues SET description = ?, updated_at = ? WHERE id = ?', [description, now, issueId]);
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok(decodeIssue(updated));
        })),
        issue_sync_retry: requireRoles('issue_sync_retry', ['bro'], wrapHandler(async (args) => {
            const issueId = requireArg(args, 'issue_id');
            // _spawnFn: test-only injection point; not in inputSchema
            const spawnFn = args['_spawnFn'] ?? undefined;
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                return err(`not_found: issue ${issueId}`);
            }
            const syncConfigRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
            const syncConfig = syncConfigRow
                ? JSON.parse(syncConfigRow.value_json)
                : 'off';
            if (syncConfig === 'off') {
                return ok({ skipped: true, reason: 'issue_sync is off' });
            }
            const backend = resolveBackend(syncConfig, !!spawnFn);
            if (backend === null || backend === 'off') {
                return ok({ skipped: true, reason: 'no remote backend configured' });
            }
            const issue = decodeIssue(row);
            // Issue-scoped sync (#155/#146): resolve cwd + per-backend slug from the
            // issue's repo. Null when unresolvable — surface a named error.
            const retryCtx = resolveIssueSyncContext(db, row.repo ?? null);
            if (retryCtx === null) {
                return ok({
                    skipped: true,
                    reason: 'unresolvable_repo',
                    repo: row.repo ?? null,
                    hint: row.repo
                        ? `issue repo "${row.repo}" has no matching repos row.`
                        : 'multiple repos registered and no issue repo selected.',
                });
            }
            if (row.status === 'closed') {
                const retryCwd = retryCtx.cwd;
                const retryTargets = [];
                if (row.gh_iid != null) {
                    retryTargets.push({ remote_iid: row.gh_iid, remote_kind: 'github' });
                }
                else if (row.remote_iid != null && row.remote_kind === 'github') {
                    retryTargets.push({ remote_iid: row.remote_iid, remote_kind: 'github' });
                }
                if (row.gl_iid != null) {
                    retryTargets.push({ remote_iid: row.gl_iid, remote_kind: 'gitlab' });
                }
                else if (row.remote_iid != null && row.remote_kind === 'gitlab') {
                    retryTargets.push({ remote_iid: row.remote_iid, remote_kind: 'gitlab' });
                }
                if (retryTargets.length === 0) {
                    return ok({ action: 'close', success: false, error: { reason: 'no_remote_iid' } });
                }
                const closeErrors = [];
                for (const target of retryTargets) {
                    const closeResult = await syncIssueClose({
                        remote_iid: target.remote_iid,
                        remote_kind: target.remote_kind,
                        _spawnFn: spawnFn,
                        _cwd: retryCwd,
                        _repoSlug: retryCtx.remoteFor(target.remote_kind === 'github' ? 'gh' : 'glab')?.slug ?? undefined,
                    });
                    if (!closeResult.ok) {
                        closeErrors.push({
                            remote_kind: target.remote_kind,
                            reason: closeResult.reason,
                            exit_code: closeResult.exit_code,
                            stderr: closeResult.stderr?.slice(0, 4096),
                            stdout: closeResult.stdout?.slice(0, 4096),
                            message: closeResult.message,
                        });
                    }
                }
                if (closeErrors.length === 0) {
                    return ok({ action: 'close', success: true });
                }
                return ok({ action: 'close', success: false, errors: closeErrors });
            }
            // Only retry backends whose iid column is NULL — mirrors the close path's
            // resolution. Prevents duplicate remote creates when one backend already
            // succeeded in a prior attempt.
            const retryCwd = retryCtx.cwd;
            const createTargets = [];
            if (backend === 'gh' || backend === 'both') {
                if (row.gh_iid == null && !(row.remote_kind === 'github' && row.remote_iid != null)) {
                    createTargets.push('gh');
                }
            }
            if (backend === 'glab' || backend === 'both') {
                if (row.gl_iid == null && !(row.remote_kind === 'gitlab' && row.remote_iid != null)) {
                    createTargets.push('glab');
                }
            }
            if (createTargets.length === 0) {
                return ok({ action: 'create', success: true, skipped: true, reason: 'already_synced' });
            }
            const createErrors = [];
            let lastSuccess = null;
            for (const target of createTargets) {
                const retryRemote = retryCtx.remoteFor(target);
                const syncResult = await syncIssueCreate({
                    issueId: row.id,
                    title: issue.objective,
                    body: row.description,
                    labels: [],
                    _backend: target,
                    _spawnFn: spawnFn,
                    _cwd: retryCwd,
                    _remoteUrl: retryRemote?.url ?? undefined,
                    _repoSlug: retryRemote?.slug ?? undefined,
                });
                if (!isSyncFailure(syncResult)) {
                    lastSuccess = { remote_iid: syncResult.remote_iid, remote_kind: syncResult.remote_kind };
                    const retryGhIid = syncResult.remote_kind === 'github' ? syncResult.remote_iid : null;
                    const retryGlIid = syncResult.remote_kind === 'gitlab' ? syncResult.remote_iid : null;
                    db.run(`UPDATE issues SET remote_iid = COALESCE(remote_iid, ?), remote_kind = COALESCE(remote_kind, ?), gh_iid = COALESCE(gh_iid, ?), gl_iid = COALESCE(gl_iid, ?), updated_at = ? WHERE id = ?`, [syncResult.remote_iid, syncResult.remote_kind, retryGhIid, retryGlIid, nowISO(), issueId]);
                }
                else {
                    createErrors.push({
                        backend: syncResult.backend,
                        reason: syncResult.reason,
                        exit_code: syncResult.exit_code,
                        stderr: syncResult.stderr?.slice(0, 4096),
                        stdout: syncResult.stdout?.slice(0, 4096),
                        message: syncResult.message,
                    });
                }
            }
            if (createErrors.length === 0 && lastSuccess !== null) {
                return ok({ action: 'create', success: true, remote_iid: lastSuccess.remote_iid, remote_kind: lastSuccess.remote_kind });
            }
            if (lastSuccess !== null) {
                return ok({ action: 'create', success: true, partial: true, errors: createErrors, remote_iid: lastSuccess.remote_iid, remote_kind: lastSuccess.remote_kind });
            }
            return ok({
                action: 'create',
                success: false,
                errors: createErrors,
            });
        })),
        issue_link: requireRoles('issue_link', ['bro'], wrapHandler(async (args) => {
            const issueId = requireArg(args, 'issue_id');
            const backend = requireArg(args, 'backend');
            const iid = requireArg(args, 'iid');
            const force = args['force'] ?? false;
            if (!Number.isInteger(iid) || iid <= 0) {
                return err(`invalid iid: must be a positive integer`);
            }
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                return err(`not_found: issue ${issueId}`);
            }
            const iidColumn = backend === 'github' ? 'gh_iid' : 'gl_iid';
            const existingIid = backend === 'github' ? row.gh_iid : row.gl_iid;
            if (existingIid != null && !force) {
                return err(`already_linked: issue ${issueId} already has ${backend} iid ${existingIid} — pass force=true to overwrite`);
            }
            const now = nowISO();
            if (backend === 'github') {
                db.run(`UPDATE issues SET gh_iid = ?, remote_iid = COALESCE(remote_iid, ?), remote_kind = COALESCE(remote_kind, 'github'), updated_at = ? WHERE id = ?`, [iid, iid, now, issueId]);
            }
            else {
                db.run(`UPDATE issues SET gl_iid = ?, remote_iid = COALESCE(remote_iid, ?), remote_kind = COALESCE(remote_kind, 'gitlab'), updated_at = ? WHERE id = ?`, [iid, iid, now, issueId]);
            }
            db.run(`INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
         VALUES (?, 'executor', 'issue_linked', ?, ?, ?)`, [
                parseInt(issueId, 10),
                `issue ${issueId} linked to ${backend} #${iid}${force && existingIid != null ? ` (forced, was ${existingIid})` : ''}`,
                JSON.stringify({ issue_id: issueId, backend, iid, forced: force && existingIid != null }),
                now,
            ]);
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok({ linked: true, backend, iid, issue: decodeIssue(updated) });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=issues.js.map