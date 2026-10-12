import { resolveRepoForSync } from '../utils/repo-paths.js';
import { repoRemotes } from '../repos/remotes.js';
import { nowISO } from '../db.js';
import { normalizeAgent, redactIssue, requireRoles } from '../middleware/agent-scope.js';
import { resolveBackend, detectPreferred, remoteSyncGate } from '../sync/backend.js';
import { syncIssueCreate, syncIssueClose, isSyncFailure, repoSlugFromRemoteUrl, verifyRemoteIssue } from '../sync/issue_sync.js';
import { serverLog } from '../logger.js';
import { insertAudit } from './audit.js';
import { WAIVE_REVIEW_REASON_MIN, closedTasksWithoutReview, escalateLiveTasksForIssueClose, liveTasksOfIssue, markIssueClosed, } from './lifecycle.js';
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
// A minimal valid label set (one classification + one priority) drawn from the
// project taxonomy. issue_create labels aren't persisted locally, so a retry
// (#1028) can't recover the originals — it re-derives this default so the
// retried remote issue satisfies the same mandatory-tagging invariant
// issue_create enforces, rather than sending labels:[] (which a
// tagging-enforced remote would reject).
export function defaultSyncLabels(db) {
    const { classification, priorityLabels } = resolveLabelTaxonomy(db);
    const labels = [];
    if (classification.length > 0)
        labels.push(classification[0]);
    if (priorityLabels.length > 0)
        labels.push(priorityLabels[0]);
    return labels;
}
// Fail closed: reject unless the labels arg satisfies BOTH required categories,
// checked against the project's configured (or generic-default) taxonomy.
// Returns a named error string listing what is missing and the valid options,
// or null when the labels are valid. Extra labels (in neither set) are allowed.
export function validateIssueLabels(db, labels, taxonomy) {
    const { classification, priorityLabels } = taxonomy ?? resolveLabelTaxonomy(db);
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
// FK (milestone, repo) -> milestones(name, repo): upsert the milestones row so
// the issues insert doesn't violate it. Only meaningful when repo is non-null
// (milestones.repo is NOT NULL and FKs the repos table); with a null repo the
// composite FK is not enforced, so no upsert is needed. Reuses an existing row
// (per-repo PK, no duplicate).
function ensureMilestoneRow(db, milestone, repo) {
    if (repo === null)
        return;
    db.run(`INSERT INTO milestones (name, repo) VALUES (?, ?)
     ON CONFLICT(name, repo) DO NOTHING`, [milestone, repo]);
}
// Milestone default (#15): when issue_create / intent_start omit the milestone,
// derive it from the issue's own repo — never a global. An explicit (non-empty)
// milestone arg always wins and upserts its (name, repo) FK row (#985).
// Otherwise, when the repo has exactly one OPEN milestone, that milestone is the
// default; zero or more than one open milestones leave it null (honors #763's
// no-forced-binding). The default path NEVER auto-creates a milestone row — it
// only binds to one that already exists for the repo. A null repo yields null.
// The returned `milestone_default` names which of those branches fired so the
// caller can tell an untriaged issue from an ambiguous default.
export function resolveDefaultMilestone(db, explicitMilestone, repo) {
    if (explicitMilestone !== null && explicitMilestone !== '') {
        ensureMilestoneRow(db, explicitMilestone, repo);
        return { milestone: explicitMilestone, milestone_default: 'explicit' };
    }
    if (repo === null)
        return { milestone: null, milestone_default: 'none_open' };
    const open = db.all(`SELECT name FROM milestones WHERE repo = ? AND state = 'open' ORDER BY name`, [repo]);
    if (open.length === 1)
        return { milestone: open[0].name, milestone_default: 'applied' };
    if (open.length === 0)
        return { milestone: null, milestone_default: 'none_open' };
    return {
        milestone: null,
        milestone_default: 'multiple_open',
        open_milestones: open.map((m) => m.name),
    };
}
// The milestone_default fields every created-issue payload carries.
export function milestoneDefaultFields(resolution) {
    const fields = { milestone_default: resolution.milestone_default };
    if (resolution.open_milestones)
        fields['open_milestones'] = resolution.open_milestones;
    return fields;
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
function refusal(code, detail) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: code, ...detail }) }],
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
            const entry = repoRemotes(db, resolved.name).find((r) => r.provider === provider);
            if (!entry)
                return null;
            return { url: entry.url, slug: repoSlugFromRemoteUrl(entry.url) };
        },
    };
}
// Remote adoption (#36). Resolve the backend for a remote_iid (explicit arg, or
// the repo's sole configured remote) and verify the remote issue exists via
// gh/glab before any local link is persisted. Shared by issue_create's adopt-
// at-create path and the after-the-fact issue_adopt_remote tool. Returns the
// resolved backend on success, or a named error on an invalid iid / ambiguous
// backend / failed remote verification.
async function verifyAdoptionRemote(db, issueRepo, remoteBackendArg, remoteIid, spawnFn) {
    if (!Number.isInteger(remoteIid) || remoteIid <= 0) {
        return { ok: false, error: `invalid_remote_iid: must be a positive integer, got ${String(remoteIid)}` };
    }
    const syncCtx = resolveIssueSyncContext(db, issueRepo);
    let backend = remoteBackendArg;
    if (!backend) {
        const hasGh = syncCtx?.remoteFor('gh') != null;
        const hasGl = syncCtx?.remoteFor('glab') != null;
        if (hasGh && !hasGl)
            backend = 'github';
        else if (hasGl && !hasGh)
            backend = 'gitlab';
        else if (hasGh && hasGl) {
            return { ok: false, error: 'remote_backend_ambiguous: repo has both github and gitlab remotes — pass remote_backend' };
        }
        else {
            return { ok: false, error: 'remote_backend_unresolved: repo has no configured remote — pass remote_backend' };
        }
    }
    const cliBackend = backend === 'github' ? 'gh' : 'glab';
    const remote = syncCtx?.remoteFor(cliBackend);
    const verify = await verifyRemoteIssue(cliBackend, remoteIid, {
        spawnFn,
        cwd: syncCtx?.cwd,
        repoSlug: remote?.slug ?? undefined,
    });
    if (!verify.ok) {
        return {
            ok: false,
            error: `remote_verify_failed: ${backend} issue #${remoteIid} not found or not viewable (${verify.reason ?? 'unknown'})`,
        };
    }
    return { ok: true, backend };
}
// Fire the remote (GitHub/GitLab) issue-close for whatever remotes the row is
// linked to. The local `issues.status='closed'` UPDATE is the caller's
// responsibility — this is only the remote-sync half, and every remote close
// goes through `remoteSyncGate`: a gated-off close spawns nothing and leaves one
// `issue_close_remote_skipped` audit row. Sync failures are logged, never
// thrown: a remote hiccup must not fail the local close. Shared by
// `issue_close`, `bro_atomic_close` and `task_recover`.
export async function syncIssueCloseRemotes(db, dbPath, issueId, spawnFn) {
    const remoteRow = db.get(`SELECT gh_iid, gl_iid, repo FROM issues WHERE id = ?`, [issueId]);
    const targets = [];
    if (remoteRow?.gh_iid != null) {
        targets.push({ remote_kind: 'github', remote_iid: remoteRow.gh_iid, closed: false });
    }
    if (remoteRow?.gl_iid != null) {
        targets.push({ remote_kind: 'gitlab', remote_iid: remoteRow.gl_iid, closed: false });
    }
    if (targets.length === 0)
        return { synced: false, remotes: [] };
    // Issue-scoped sync (#155/#146): resolve cwd + per-backend repo slug from the
    // issue's repo. When unresolvable, fall back to no explicit cwd/slug — a
    // best-effort close must not throw (the local close already happened).
    const closeCtx = resolveIssueSyncContext(db, remoteRow?.repo ?? null);
    const gate = remoteSyncGate(db, {
        repoRemotes: closeCtx
            ? { github: closeCtx.remoteFor('gh') !== null, gitlab: closeCtx.remoteFor('glab') !== null }
            : null,
        spawnFn: spawnFn ? (cmd, args) => spawnFn(cmd, args, { encoding: 'utf8' }) : undefined,
    });
    if (!gate.enabled) {
        const reason = gate.reason ?? 'no_backend';
        insertAudit(db, {
            issue_id: issueId,
            from_node: 'trajectory-server',
            event_type: 'issue_close_remote_skipped',
            summary: `issue ${issueId} closed locally; remote close skipped (${reason})`,
            content_json: JSON.stringify({
                reason,
                remotes: targets.map(({ remote_kind, remote_iid }) => ({ remote_kind, remote_iid })),
            }),
            created_at: nowISO(),
        });
        return { synced: false, skipped: reason, remotes: targets };
    }
    for (const target of targets) {
        const closeSlug = closeCtx?.remoteFor(target.remote_kind === 'github' ? 'gh' : 'glab')?.slug ?? undefined;
        const closeResult = await syncIssueClose({
            remote_iid: target.remote_iid,
            remote_kind: target.remote_kind,
            _cwd: closeCtx?.cwd,
            _repoSlug: closeSlug,
            _spawnFn: spawnFn,
        });
        target.closed = closeResult.ok;
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
    return { synced: targets.every((t) => t.closed), remotes: targets };
}
export function issueTools(db, dbPath = '', options = {}) {
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
                    remote_iid: { type: 'number', description: 'Optional. Adopt an existing remote issue instead of creating one: verifies the remote issue exists, links it, and skips remote creation. A failed verification creates nothing.' },
                    remote_backend: { type: 'string', enum: ['github', 'gitlab'], description: 'Optional backend for remote_iid adoption. Defaults to the repo\'s sole configured remote.' },
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
            description: 'Close an issue locally, then mirror the close to its linked remote. Refuses with issue_has_open_tasks (task ids + statuses) while any task is pending/running/needs_validation/completed, unless cascade=true escalates those tasks first (one task_escalated_by_issue_close audit row each, open agent_runs closed issue_closed). Refuses with tasks_without_review while a closed task has no passing pr-reviewer verdict for its current commit, unless waive_review=true + waive_review_reason records review_gate_waived per task.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    cascade: {
                        type: 'boolean',
                        description: 'When true, escalate every live task of the issue (pending/running/needs_validation/completed) and close their open agent_runs before closing the issue. Default false: refuse while tasks are live.',
                    },
                    reason: {
                        type: 'string',
                        description: 'Optional reason stored on each task_escalated_by_issue_close audit row when cascade=true.',
                    },
                    waive_review: {
                        type: 'boolean',
                        description: 'When true, close even though closed tasks lack a passing pr-reviewer verdict; writes one review_gate_waived audit row per such task. Requires waive_review_reason.',
                    },
                    waive_review_reason: {
                        type: 'string',
                        description: 'Required when waive_review is true (min 10 chars): why the review is skipped.',
                    },
                },
                required: ['agent', 'issue_id'],
            },
        },
        {
            name: 'issue_get_phase',
            description: "Return the current workflow phase and task counts for an issue. tasks_completed counts closed tasks only; tasks_awaiting_close counts tasks the SWE reported completed that bro has not closed yet. phase is ready_to_close once every task is closed.",
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
                    milestone: { type: 'string', description: "Optional milestone filter: a milestone name, or 'none' for issues with no milestone." },
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
            name: 'issue_adopt_remote',
            description: 'Link an existing local issue to an existing remote issue after verifying it exists. Bro only. Errors if the row is already linked to a different iid; re-adopting the same iid is idempotent.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', enum: ['bro'], description: 'Calling agent identity (bro only)' },
                    issue_id: { type: 'string', description: 'Local issue ID' },
                    remote_iid: { type: 'number', description: 'Remote issue number to adopt' },
                    remote_backend: { type: 'string', enum: ['github', 'gitlab'], description: 'Optional. Defaults to the repo\'s sole configured remote.' },
                },
                required: ['agent', 'issue_id', 'remote_iid'],
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
            // labels: passed to remote sync AND persisted on the row (#53) as a JSON
            // array string so issue_sync_retry replays the original validated set
            // instead of re-deriving defaultSyncLabels.
            const labels = args['labels'] ?? [];
            // Mandatory tagging (#93/#777): fail closed before any insert/sync.
            const labelError = validateIssueLabels(db, labels, options.labelTaxonomy);
            if (labelError !== null) {
                return err(labelError);
            }
            // repo (#155): explicit arg, else the sole/managed repo when exactly one
            // repos row exists. Null for an ambiguous multi-repo install with no
            // selector — the FK is nullable so the insert still succeeds. Resolved
            // before the dedup check so dedup can scope to the same repo.
            const explicitRepo = args['repo'] ?? null;
            const issueRepo = explicitRepo ?? resolveRepoForSync(db, null)?.name ?? null;
            // Dedup pre-check (#91/#775): unless explicitly overridden, refuse to
            // fork a second open issue for objective-equivalent work. Deterministic
            // token-set Jaccard against OPEN issues in the SAME repo (or repo-less
            // ones); a match at/above the threshold short-circuits the insert. Issues
            // in other repos are distinct work and never dedup against this one.
            const allowDuplicate = args['allow_duplicate'] ?? false;
            if (!allowDuplicate) {
                const openIssues = db.all(`SELECT id, objective FROM issues WHERE status = 'open' AND (repo IS NULL OR repo = ?)`, [issueRepo]);
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
            // milestone: optional; persisted locally AND passed to remote sync
            // (#83/#763). When omitted, defaults to the issue repo's sole OPEN
            // milestone (#15); an explicit milestone upserts its FK row (#985/#154).
            const explicitMilestone = args['milestone'] ?? null;
            const milestoneResolution = resolveDefaultMilestone(db, explicitMilestone, issueRepo);
            const milestone = milestoneResolution.milestone;
            // _spawnFn: test-only injection point; not in inputSchema
            const spawnFn = args['_spawnFn'] ?? undefined;
            const now = nowISO();
            // Remote adoption (#36): when a remote_iid is supplied, verify the remote
            // issue exists, persist the link on the new row, and SKIP remote creation.
            // A failed verification returns a named error and inserts nothing.
            const remoteIidRaw = args['remote_iid'];
            if (remoteIidRaw !== undefined && remoteIidRaw !== null) {
                const remoteIid = typeof remoteIidRaw === 'number' ? remoteIidRaw : Number(remoteIidRaw);
                const remoteBackendArg = args['remote_backend'];
                const adoption = await verifyAdoptionRemote(db, issueRepo, remoteBackendArg, remoteIid, spawnFn);
                if (!adoption.ok) {
                    return err(adoption.error);
                }
                db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo, labels)
           VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`, [objective, description, now, now, milestone, issueRepo, JSON.stringify(labels)]);
                const adoptRowId = db.get(`SELECT id FROM issues WHERE rowid = last_insert_rowid()`);
                if (!adoptRowId) {
                    throw new Error('issue_create: failed to retrieve inserted row');
                }
                const adoptId = adoptRowId.id;
                const ghIid = adoption.backend === 'github' ? remoteIid : null;
                const glIid = adoption.backend === 'gitlab' ? remoteIid : null;
                db.run(`UPDATE issues SET remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`, [adoption.backend, ghIid, glIid, now, adoptId]);
                insertAudit(db, {
                    issue_id: adoptId,
                    from_node: 'executor',
                    event_type: 'issue_adopted',
                    summary: `issue ${adoptId} adopted ${adoption.backend} #${remoteIid} at create`,
                    content_json: JSON.stringify({ issue_id: adoptId, backend: adoption.backend, remote_iid: remoteIid, at_create: true }),
                    created_at: now,
                });
                const adoptedRow = db.get('SELECT * FROM issues WHERE id = ?', [adoptId]);
                const adoptedIssue = decodeIssue(adoptedRow);
                const adoptedRedacted = redactIssue(adoptedIssue, agent, { include_description: true });
                const adoptedPayload = {
                    ...adoptedRedacted,
                    ...milestoneDefaultFields(milestoneResolution),
                };
                adoptedPayload._adopted = { backend: adoption.backend, remote_iid: remoteIid };
                return ok(adoptedPayload);
            }
            db.run(`INSERT INTO issues (objective, description, status, created_at, updated_at, milestone, repo, labels)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?)`, [objective, description, now, now, milestone, issueRepo, JSON.stringify(labels)]);
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
                // Issue-scoped sync (#155/#146): resolve cwd + per-backend remote from
                // the issue's repo. The repo's remotes also drive the 'auto' backend
                // decision (#1043) — never a process.cwd() git probe.
                const syncCtx = resolveIssueSyncContext(db, issueRepo);
                const remoteProviders = syncCtx
                    ? { github: syncCtx.remoteFor('gh') !== null, gitlab: syncCtx.remoteFor('glab') !== null }
                    : null;
                const backend = resolveBackend(syncConfig, remoteProviders, !!spawnFn);
                if (backend === null) {
                    serverLog({ event: 'issue_sync_skip', reason: 'no_remote_configured', issueId });
                }
                else if (backend !== 'off') {
                    // Unresolvable repo while sync is on → named error rather than a
                    // silent process.cwd() sync.
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
                        const payload = {
                            ...redacted,
                            ...milestoneDefaultFields(milestoneResolution),
                        };
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
                                db.run(`UPDATE issues SET remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`, [firstSuccess.remote_kind, ghIid, glIid, now, issueId]);
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
                            // Label pre-validation warning (#36): union the labels dropped by
                            // either backend. Only surfaced when no failure/partial diagnostic
                            // already occupies the slot.
                            const droppedLabels = new Set();
                            if (!isSyncFailure(ghResult) && ghResult.unknown_labels) {
                                for (const l of ghResult.unknown_labels)
                                    droppedLabels.add(l);
                            }
                            if (!isSyncFailure(glResult) && glResult.unknown_labels) {
                                for (const l of glResult.unknown_labels)
                                    droppedLabels.add(l);
                            }
                            if (droppedLabels.size > 0 && !syncDiagnostic) {
                                syncDiagnostic = {
                                    labels_dropped: [...droppedLabels],
                                    reason: 'labels_not_in_remote_taxonomy',
                                    hint: 'These requested labels do not exist on the remote and were omitted from the remote issue; all labels are still kept on the local issue.',
                                };
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
                                db.run(`UPDATE issues SET remote_kind = ?, gh_iid = ?, gl_iid = ?, updated_at = ? WHERE id = ?`, [syncResult.remote_kind, ghIid, glIid, now, issueId]);
                                // Label pre-validation warning (#36): the remote issue was created
                                // with the valid subset; surface the dropped labels. The local row
                                // still carries the full requested set.
                                if (syncResult.unknown_labels && syncResult.unknown_labels.length > 0) {
                                    syncDiagnostic = {
                                        labels_dropped: syncResult.unknown_labels,
                                        reason: 'labels_not_in_remote_taxonomy',
                                        hint: 'These requested labels do not exist on the remote and were omitted from the remote issue; all labels are still kept on the local issue.',
                                    };
                                }
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
                insertAudit(db, {
                    issue_id: issueId,
                    from_node: 'executor',
                    event_type: 'sync_skipped',
                    summary: `issue ${issueId} sync skipped: issue_sync is off`,
                    content_json: JSON.stringify({ issue_id: issueId, reason: 'issue_sync_off' }),
                    created_at: nowISO(),
                });
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
            const payload = {
                ...redacted,
                ...milestoneDefaultFields(milestoneResolution),
            };
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
            const cascade = args['cascade'] === true;
            const waiveReview = args['waive_review'] === true;
            const waiveReason = args['waive_review_reason'];
            const cascadeReason = typeof args['reason'] === 'string' && args['reason'].trim() !== ''
                ? args['reason']
                : 'issue closed with cascade';
            if (waiveReview && (typeof waiveReason !== 'string' || waiveReason.trim().length < WAIVE_REVIEW_REASON_MIN)) {
                return err(`waive_review_reason must be a string ≥${WAIVE_REVIEW_REASON_MIN} chars.`);
            }
            const live = liveTasksOfIssue(db, issueId);
            if (live.length > 0 && !cascade) {
                return refusal('issue_has_open_tasks', {
                    message: `Issue ${issueId} has tasks not in closed|failed|escalated. Finish them, or pass cascade=true ` +
                        `to escalate them and close the issue.`,
                    tasks: live.map((t) => ({ task_id: t.id, status: t.status })),
                });
            }
            const unreviewed = closedTasksWithoutReview(db, issueId);
            if (unreviewed.length > 0 && !waiveReview) {
                return refusal('tasks_without_review', {
                    message: `Issue ${issueId} has closed tasks with no passing pr-reviewer verdict for their current commit. ` +
                        `Run pr-reviewer, or pass waive_review=true with waive_review_reason="<why>".`,
                    tasks: unreviewed.map((t) => ({ task_id: t.id, commit_sha: t.commit_sha })),
                });
            }
            db.transaction(() => {
                if (waiveReview) {
                    for (const t of unreviewed) {
                        insertAudit(db, {
                            issue_id: t.issue_id,
                            branch_id: t.branch_id,
                            from_node: 'bro',
                            event_type: 'review_gate_waived',
                            summary: `issue_close review gate waived for task ${t.id}`,
                            content_json: JSON.stringify({
                                skill: 'issue_close',
                                task_id: t.id,
                                commit_sha: t.commit_sha,
                                waive_review_reason: waiveReason,
                            }),
                            created_at: now,
                        });
                    }
                }
                escalateLiveTasksForIssueClose(db, live, cascadeReason, now);
                markIssueClosed(db, issueId, now);
            });
            const remote = await syncIssueCloseRemotes(db, dbPath, issueId, args['_spawnFn']);
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok({
                ...decodeIssue(updated),
                tasks_escalated: live.map((t) => t.id),
                review_waived_tasks: waiveReview ? unreviewed.map((t) => t.id) : [],
                remote,
            });
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
           SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as tasks_completed,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as tasks_awaiting_close,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as tasks_failed
         FROM tasks WHERE issue_id = ?`, [issueId]);
            const counts = {
                tasks_total: rawCounts?.tasks_total ?? 0,
                tasks_completed: rawCounts?.tasks_completed ?? 0,
                tasks_awaiting_close: rawCounts?.tasks_awaiting_close ?? 0,
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
            const rawMilestone = args['milestone'];
            const conditions = [];
            const params = [];
            if (rawStatus !== undefined) {
                conditions.push('status = ?');
                params.push(rawStatus);
            }
            if (rawMilestone !== undefined && rawMilestone !== '') {
                if (rawMilestone === 'none') {
                    conditions.push('milestone IS NULL');
                }
                else {
                    conditions.push('milestone = ?');
                    params.push(rawMilestone);
                }
            }
            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const rows = db.all(`SELECT id, objective, status, created_at, updated_at FROM issues ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
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
            // Issue-scoped sync (#155/#146): resolve cwd + per-backend slug from the
            // issue's repo. The repo's remotes also drive the 'auto' backend decision
            // (#1043). Null when unresolvable — surface a named error.
            const retryCtx = resolveIssueSyncContext(db, row.repo ?? null);
            const retryRemotes = retryCtx
                ? { github: retryCtx.remoteFor('gh') !== null, gitlab: retryCtx.remoteFor('glab') !== null }
                : null;
            const backend = resolveBackend(syncConfig, retryRemotes, !!spawnFn);
            if (backend === null || backend === 'off') {
                return ok({ skipped: true, reason: 'no remote backend configured' });
            }
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
            const issue = decodeIssue(row);
            if (row.status === 'closed') {
                const retryCwd = retryCtx.cwd;
                const retryTargets = [];
                if (row.gh_iid != null) {
                    retryTargets.push({ remote_iid: row.gh_iid, remote_kind: 'github' });
                }
                if (row.gl_iid != null) {
                    retryTargets.push({ remote_iid: row.gl_iid, remote_kind: 'gitlab' });
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
                if (row.gh_iid == null) {
                    createTargets.push('gh');
                }
            }
            if (backend === 'glab' || backend === 'both') {
                if (row.gl_iid == null) {
                    createTargets.push('glab');
                }
            }
            if (createTargets.length === 0) {
                return ok({ action: 'create', success: true, skipped: true, reason: 'already_synced' });
            }
            // Replay the label set persisted at create (#53). Non-NULL → replay the
            // original validated labels verbatim (syncIssueCreate's #1067 pre-validation
            // drops any taxonomy-invalid entries with an unknown_labels warning). NULL
            // is a legacy pre-v28 row: re-derive defaultSyncLabels so it still satisfies
            // the mandatory-tagging invariant (#1028). Malformed JSON degrades to the
            // same fallback rather than throwing.
            let retryLabels;
            if (row.labels == null) {
                retryLabels = defaultSyncLabels(db);
            }
            else {
                try {
                    const parsed = JSON.parse(row.labels);
                    retryLabels = Array.isArray(parsed) ? parsed : defaultSyncLabels(db);
                }
                catch {
                    retryLabels = defaultSyncLabels(db);
                }
            }
            const createErrors = [];
            let lastSuccess = null;
            for (const target of createTargets) {
                const retryRemote = retryCtx.remoteFor(target);
                const syncResult = await syncIssueCreate({
                    issueId: row.id,
                    title: issue.objective,
                    body: row.description,
                    labels: retryLabels,
                    milestone: row.milestone ?? undefined,
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
                    db.run(`UPDATE issues SET remote_kind = COALESCE(remote_kind, ?), gh_iid = COALESCE(gh_iid, ?), gl_iid = COALESCE(gl_iid, ?), updated_at = ? WHERE id = ?`, [syncResult.remote_kind, retryGhIid, retryGlIid, nowISO(), issueId]);
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
                db.run(`UPDATE issues SET gh_iid = ?, remote_kind = COALESCE(remote_kind, 'github'), updated_at = ? WHERE id = ?`, [iid, now, issueId]);
            }
            else {
                db.run(`UPDATE issues SET gl_iid = ?, remote_kind = COALESCE(remote_kind, 'gitlab'), updated_at = ? WHERE id = ?`, [iid, now, issueId]);
            }
            insertAudit(db, {
                issue_id: parseInt(issueId, 10),
                from_node: 'executor',
                event_type: 'issue_linked',
                summary: `issue ${issueId} linked to ${backend} #${iid}${force && existingIid != null ? ` (forced, was ${existingIid})` : ''}`,
                content_json: JSON.stringify({ issue_id: issueId, backend, iid, forced: force && existingIid != null }),
                created_at: now,
            });
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok({ linked: true, backend, iid, issue: decodeIssue(updated) });
        })),
        issue_adopt_remote: requireRoles('issue_adopt_remote', ['bro'], wrapHandler(async (args) => {
            const issueId = requireArg(args, 'issue_id');
            const remoteIidRaw = requireArg(args, 'remote_iid');
            const remoteIid = typeof remoteIidRaw === 'number' ? remoteIidRaw : Number(remoteIidRaw);
            const remoteBackendArg = args['remote_backend'];
            // _spawnFn: test-only injection point; not in inputSchema
            const spawnFn = args['_spawnFn'] ?? undefined;
            const row = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            if (!row) {
                return err(`not_found: issue ${issueId}`);
            }
            const adoption = await verifyAdoptionRemote(db, row.repo ?? null, remoteBackendArg, remoteIid, spawnFn);
            if (!adoption.ok) {
                return err(adoption.error);
            }
            // Conflict: an existing link for the same backend to a DIFFERENT iid is a
            // hard error; re-adopting the same iid is idempotent.
            const existingIid = adoption.backend === 'github' ? row.gh_iid : row.gl_iid;
            if (existingIid != null && existingIid !== remoteIid) {
                return err(`already_linked: issue ${issueId} already has a ${adoption.backend} link (#${existingIid}); re-adopt is only idempotent for the same iid`);
            }
            const idempotent = existingIid === remoteIid;
            const now = nowISO();
            const ghIid = adoption.backend === 'github' ? remoteIid : null;
            const glIid = adoption.backend === 'gitlab' ? remoteIid : null;
            db.run(`UPDATE issues SET gh_iid = COALESCE(?, gh_iid), gl_iid = COALESCE(?, gl_iid), remote_kind = COALESCE(remote_kind, ?), updated_at = ? WHERE id = ?`, [ghIid, glIid, adoption.backend, now, issueId]);
            if (!idempotent) {
                insertAudit(db, {
                    issue_id: parseInt(issueId, 10),
                    from_node: 'executor',
                    event_type: 'issue_adopted',
                    summary: `issue ${issueId} adopted ${adoption.backend} #${remoteIid}`,
                    content_json: JSON.stringify({ issue_id: issueId, backend: adoption.backend, remote_iid: remoteIid, at_create: false }),
                    created_at: now,
                });
            }
            const updated = db.get('SELECT * FROM issues WHERE id = ?', [issueId]);
            return ok({ adopted: true, backend: adoption.backend, remote_iid: remoteIid, idempotent, issue: decodeIssue(updated) });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=issues.js.map