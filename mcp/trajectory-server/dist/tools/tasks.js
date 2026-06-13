import { nowISO } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { serverLog } from '../logger.js';
import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { resolve, dirname } from 'node:path';
// Extract directories implied by a spec's `## Files` section. Mirrors
// parseFilesDirs in composites.ts — kept here to avoid a circular import
// (composites.ts imports BRANCH_ID_RE from tasks.ts).
function specFileDirs(specBody) {
    const dirs = new Set();
    let inFiles = false;
    for (const line of specBody.split('\n')) {
        const h2 = line.match(/^##\s+(.+)/);
        if (h2) {
            inFiles = /^files\b/i.test(h2[1].trim());
            continue;
        }
        if (!inFiles)
            continue;
        const m = line.match(/^\s*[-*]\s+`?([^`\s—|]+)/);
        if (!m)
            continue;
        const path = m[1].replace(/[`,.;]+$/, '');
        const slash = path.lastIndexOf('/');
        dirs.add(slash >= 0 ? path.slice(0, slash) : '');
    }
    return dirs;
}
export const BRANCH_ID_RE = /^(feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert)\/[a-z0-9][a-z0-9-]{0,62}$/;
const BASE_BRANCH_ALLOWLIST = new Set(['dev', 'main', 'master']);
// Hard cap on tasks.spec_body. Architect should cite existing code/conventions
// rather than restate them; a spec longer than ~8k is usually a sign the task
// should be split via depends_on. Very long specs push SWE cold-start into the
// minutes range (issue #55: a 55k-char spec hung the session). Tunable via
// the TMB_SPEC_BODY_MAX_BYTES env var for downstream users with a different
// SWE token budget; defaults to 8000 chars.
export const SPEC_BODY_MAX_BYTES = (() => {
    const raw = process.env['TMB_SPEC_BODY_MAX_BYTES'];
    if (raw === undefined)
        return 8000;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
})();
function validateBranchId(branchId) {
    if (!BRANCH_ID_RE.test(branchId)) {
        throw new Error(`Invalid branch_id "${branchId}". Must match git-convention format: <type>/<slug> ` +
            `where <type> is one of feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert ` +
            `and <slug> is lowercase alnum + hyphens (max 63 chars). Examples: feat/user-login, fix/auth-crash.`);
    }
}
function validateParentBranchId(branchId) {
    if (BASE_BRANCH_ALLOWLIST.has(branchId) || BRANCH_ID_RE.test(branchId))
        return;
    throw new Error(`Invalid branch_id "${branchId}". Must be a base branch (dev, main, master) or git-convention ` +
        `format: <type>/<slug> where <type> is one of feat|fix|refactor|chore|docs|test|perf|build|ci|style|revert ` +
        `and <slug> is lowercase alnum + hyphens (max 63 chars). Examples: dev, main, feat/user-login.`);
}
// Allowed target statuses for swe. SWE may only set running, completed, or
// failed — pre-execution states (pending, escalated) are bro-managed; 'closed'
// is bro's atomic-close transition; 'needs_validation' is not a valid SWE
// terminal state. Additionally, closed and escalated are terminal for SWE —
// a closed task cannot be touched by SWE. See #114, #343.
const SWE_ALLOWED_TARGET_STATUSES = new Set(['running', 'completed', 'failed']);
// States that SWE may not transition OUT OF (terminal for SWE).
const SWE_LOCKED_SOURCE_STATES = new Set(['closed', 'escalated']);
function ensureBranchInRepo(branchId, repoPath, parentBranchId) {
    const existsResult = spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', branchId], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (existsResult.status === 0)
        return null;
    const stderr = (existsResult.stderr ?? '');
    if (stderr.includes('not a git repository') || stderr.includes('cannot change to')) {
        serverLog({
            level: 'warn',
            msg: `[task_create_batch] repo '${repoPath}' is not a resolvable git repository; skipping branch-existence check for '${branchId}'.`,
        });
        return null;
    }
    let startPoint = 'HEAD';
    if (parentBranchId) {
        const parentResult = spawnSync('git', ['-C', repoPath, 'rev-parse', '--verify', parentBranchId], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
        if (parentResult.status === 0)
            startPoint = parentBranchId;
    }
    const createResult = spawnSync('git', ['-C', repoPath, 'branch', branchId, startPoint], {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
    });
    if (createResult.status !== 0) {
        throw new Error(`task_create_batch: failed to auto-create branch '${branchId}' from '${startPoint}' in repo '${repoPath}': ` +
            (createResult.stderr ?? '').trim());
    }
    return { branchId, startPoint, repoPath };
}
const VALID_STATUSES = new Set([
    'pending',
    'running',
    'needs_validation',
    'completed',
    'closed',
    'failed',
    'escalated',
]);
// Allowed status transitions for bro (#278). Without this, bro could move any
// status to any status — e.g. pending→closed (skipping verification) or
// closed→completed (re-satisfying a downstream gate by fiat). Keys not present
// reject every outbound move; a same-status no-op is always allowed.
//   - Into 'completed' only from a work state (running / needs_validation) —
//     bro can't fabricate completion from pending or a terminal state.
//   - Into 'closed' only from verified/terminal states, never from pending.
//   - 'closed'→'escalated' is the push-gate pushback path (pr-reviewer FAILs
//     after the task was closed; bro reopens the work).
const BRO_TRANSITIONS = {
    pending: new Set(['running', 'failed', 'escalated']),
    running: new Set(['pending', 'needs_validation', 'completed', 'failed', 'escalated']),
    needs_validation: new Set(['running', 'completed', 'failed', 'escalated', 'closed']),
    completed: new Set(['needs_validation', 'failed', 'escalated', 'closed']),
    failed: new Set(['pending', 'running', 'escalated', 'closed']),
    escalated: new Set(['pending', 'running', 'failed', 'closed']),
    closed: new Set(['escalated']),
};
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
export function taskTools(db) {
    const definitions = [
        {
            name: 'task_create_batch',
            description: 'Insert multiple tasks for an issue in a single transaction. branch_id MUST be a git-convention name (feat/foo, fix/bar, refactor/baz, etc.); it doubles as the working git branch.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                    tasks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                branch_id: { type: 'string' },
                                parent_branch_id: { type: 'string' },
                                title: { type: 'string' },
                                description: { type: 'string' },
                                spec_body: {
                                    type: 'string',
                                    description: 'Full markdown body SWE reads. Required for any task that will be SWE-executed. Max 8000 chars — over this, the architect should split into multiple tasks via depends_on, or cite existing code/conventions rather than restating them. See issue #55.',
                                },
                                repo: {
                                    type: 'string',
                                    description: 'Optional relative path to the git repo for this task (e.g. "inner", "repos/backend"). ' +
                                        'Must not contain ".." or start with "/". Null/omitted for single-repo CC. ' +
                                        'Used by the WorktreeCreate hook to route worktree creation to the right repo.',
                                },
                                prompt_bearing: {
                                    type: 'number',
                                    description: 'Set to 1 when this task intentionally modifies prompt-surface files ' +
                                        '(agents/, skills/*/SKILL.md, commands/, templates/, CLAUDE.md, etc.). ' +
                                        'The swe-boundary hook checks this flag before blocking prompt-surface writes. Default 0.',
                                },
                            },
                            required: ['branch_id', 'description'],
                        },
                    },
                    waive_scope_gate: {
                        type: 'boolean',
                        description: "Set true to bypass the scope-ambiguity gate. Only acceptable for truly trivial changes (typo fix, one-line doc change, etc.) where no Q+A was needed. If false or omitted, the issue MUST have at least one discussion row with kind='question' before tasks can be created.",
                    },
                    emit_planning_complete: {
                        type: 'boolean',
                        description: "Set true to atomically emit a planning_complete audit event in the same transaction as the task INSERTs. Eliminates the L5 03/12 failure mode where the LLM would create tasks but skip the closing audit_log call. The tmb_planning skill (Step 4) should set this to true.",
                    },
                    planning_complete_summary: {
                        type: 'string',
                        description: "Optional override for the planning_complete event's summary text. Defaults to: 'Planning complete for issue <id>: <N> task(s) created on <branch>.'",
                    },
                    waive_scope_gate_reason: {
                        type: 'string',
                        description: "Required when waive_scope_gate=true. Min 10 chars. Explain why this task has no Human-reviewed scope (e.g. 'typo fix in README line 12; no interpretation needed').",
                    },
                    waive_branch_gate: {
                        type: 'boolean',
                    },
                    waive_branch_gate_reason: {
                        type: 'string',
                    },
                    waive_registry_gate: {
                        type: 'boolean',
                        description: "Set true to bypass the world-model-cold gate. Only acceptable when /scan can't run for some reason (offline / scratch test fixture). If false or omitted, the kuzu world model MUST be warm (a deep_scan_completed audit row must exist) before tasks can be created — populate via /scan or scan_run.",
                    },
                    waive_registry_gate_reason: {
                        type: 'string',
                        description: "Required when waive_registry_gate=true. Min 10 chars. Explain why /scan can't run.",
                    },
                    waive_intent_gate: {
                        type: 'boolean',
                        description: "Set true to bypass the intent-discussion gate. Acceptable for trivial work where the user intent is unambiguous and verbatim capture would be ceremony. If false or omitted, the issue MUST have at least one discussion row with kind='intent' before tasks can be created.",
                    },
                    waive_intent_gate_reason: {
                        type: 'string',
                        description: "Required when waive_intent_gate=true. Min 10 chars. Explain why intent capture is unnecessary.",
                    },
                    waive_decision_gate: {
                        type: 'boolean',
                        description: "Set true to bypass the decision-audit gate. Acceptable only for trivial work where capturing a chosen approach as a kind='decision' discussion is ceremony (typo fix, mechanical rename, etc.). If false or omitted, the issue MUST have at least one kind='decision' discussion summarizing bro's chosen approach (1-3 sentences: what, why, trade-offs) before tasks can be created.",
                    },
                    waive_decision_gate_reason: {
                        type: 'string',
                        description: "Required when waive_decision_gate=true. Min 10 chars. Explain why an explicit decision-audit row is unnecessary.",
                    },
                    waive_spec_shape: {
                        type: 'boolean',
                        description: "Set true to bypass the spec-section shape gate. Acceptable for tasks without a full spec (e.g. placeholder tasks, non-SWE tasks). If false or omitted, each spec_body must contain ## Files, ## Success Criteria, ## Verification and be ≤200 lines.",
                    },
                    waive_spec_shape_reason: {
                        type: 'string',
                        description: "Required when waive_spec_shape=true. Min 10 chars. Explain why the spec does not have the required sections.",
                    },
                },
                required: ['agent', 'issue_id', 'tasks'],
            },
        },
        {
            name: 'task_get',
            description: 'Fetch a single task by ID.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                },
                required: ['agent', 'task_id'],
            },
        },
        {
            name: 'task_update_status',
            description: 'Update the status of a task. Optionally records a commit SHA in the same transaction, ensuring status and SHA are persisted atomically.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                    status: {
                        type: 'string',
                        enum: ['pending', 'running', 'needs_validation', 'completed', 'closed', 'failed', 'escalated'],
                    },
                    attempts: { type: 'number' },
                    commit_sha: {
                        type: 'string',
                        description: 'Optional git commit SHA (full 40-char or short 7+ char hex). Persisted atomically with the status update.',
                    },
                },
                required: ['agent', 'task_id', 'status'],
            },
        },
        {
            name: 'task_first_actionable',
            description: 'Returns the lex-lowest pending/failed task for an issue (groups by type prefix: chore<ci<docs<feat<...). branch_id ordering is lexicographic over git-convention names.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    issue_id: { type: 'string' },
                },
                required: ['agent', 'issue_id'],
            },
        },
    ];
    const handlers = {
        task_create_batch: requireRoles('task_create_batch', ['bro'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            requireArg(args, 'tasks');
            const taskInputs = args['tasks'];
            if (!Array.isArray(taskInputs) || taskInputs.length === 0) {
                return ok([]);
            }
            // --- Scope-ambiguity gate (MCP-level enforcement) ---
            // Every task_create_batch must be preceded by at least one
            // discussion row with kind='question' for this issue, UNLESS the
            // caller explicitly waives the gate with a written reason. This
            // stops the LLM from silently bypassing the alignment loop under
            // auto-mode pressure.
            const waived = args['waive_scope_gate'] === true;
            const waiverReason = (args['waive_scope_gate_reason'] ?? '');
            // --- Spec-section shape gate (MCP-level enforcement) ---
            // Each spec_body must contain the three required H2 sections and be ≤200 lines.
            // Waivable with waive_spec_shape_reason (≥10 chars, audited).
            const specShapeWaived = args['waive_spec_shape'] === true;
            const specShapeWaiverReason = (args['waive_spec_shape_reason'] ?? '');
            if (specShapeWaived) {
                if (typeof specShapeWaiverReason !== 'string' || specShapeWaiverReason.trim().length < 10) {
                    return err('waive_spec_shape_reason must be a string ≥10 chars.');
                }
            }
            else {
                const REQUIRED_H2 = ['## Files', '## Success Criteria', '## Verification'];
                for (const t of args['tasks']) {
                    if (!t.spec_body)
                        continue;
                    const missing = REQUIRED_H2.filter((h) => !t.spec_body.split('\n').some((l) => l.trimEnd().toLowerCase() === h.toLowerCase()));
                    const lineCount = t.spec_body.split('\n').length;
                    if (missing.length > 0 || lineCount > 200) {
                        const parts = [];
                        if (missing.length > 0)
                            parts.push(`missing sections: ${missing.join(', ')}`);
                        if (lineCount > 200)
                            parts.push(`spec_body is ${lineCount} lines (max 200)`);
                        return {
                            isError: true,
                            content: [{
                                    type: 'text',
                                    text: JSON.stringify({
                                        error: 'spec_shape_violation',
                                        message: `Spec shape gate: task branch_id='${t.branch_id}' — ${parts.join('; ')}. ` +
                                            `Each spec_body must contain ## Files, ## Success Criteria, ## Verification (H2 headings) ` +
                                            `and be ≤200 lines. Add the missing sections or pass waive_spec_shape=true with ` +
                                            `waive_spec_shape_reason="<why>" (≥10 chars) for tasks without full specs.`,
                                        branch_id: t.branch_id,
                                        missing_sections: missing,
                                        line_count: lineCount,
                                    }),
                                }],
                        };
                    }
                }
            }
            if (waived) {
                if (typeof waiverReason !== 'string' || waiverReason.trim().length < 10) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: "waive_scope_gate_reason must be a string ≥10 chars. Explain why this task has no Human-reviewed scope.",
                                }),
                            },
                        ],
                    };
                }
            }
            else {
                const row = db.get(`SELECT COUNT(*) as c FROM discussions WHERE issue_id = ? AND kind = 'question'`, [issueId]);
                const questionCount = row?.c ?? 0;
                if (questionCount === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'scope_gate_violation',
                                    message: `Scope-ambiguity gate: issue ${issueId} has zero kind='question' discussions. ` +
                                        `Before creating tasks, architect must ask the Human at least one clarifying ` +
                                        `question via discussion_append(kind='question') and record their answer via ` +
                                        `discussion_append(kind='answer'). For truly trivial changes (typo fix, one-line ` +
                                        `doc), pass waive_scope_gate=true with waive_scope_gate_reason="<why trivial>".`,
                                    issue_id: issueId,
                                    questions_found: 0,
                                }),
                            },
                        ],
                    };
                }
            }
            // --- Branch-id-proposal gate (MCP-level enforcement, #155) ---
            // task_create_batch must be preceded by an audit event with
            // event_type='branch_id_proposed' for this issue. Stops bro from spawning
            // SWE without first running tmb_planning §Step 2 (which calls
            // branch_id_propose, asks the Human to confirm, runs git switch -c, and
            // emits the branch_id_proposed audit event).
            const branchGateWaived = args['waive_branch_gate'] === true;
            const branchGateWaiverReason = (args['waive_branch_gate_reason'] ?? '');
            if (branchGateWaived) {
                if (typeof branchGateWaiverReason !== 'string' || branchGateWaiverReason.trim().length < 10) {
                    return err('waive_branch_gate_reason must be a string ≥10 chars.');
                }
            }
            else {
                const proposed = db.get(`SELECT COUNT(*) as c FROM audit WHERE issue_id = ? AND event_type = 'branch_id_proposed'`, [issueId]);
                if ((proposed?.c ?? 0) === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'branch_state_violation',
                                    message: `branch_state_violation: issue ${issueId} has zero audit events with event_type='branch_id_proposed'. ` +
                                        `Run tmb_planning §Step 2 first (it calls branch_id_propose, confirms with Human, runs git switch -c, and emits the audit event). ` +
                                        `For exceptional cases, pass waive_branch_gate=true with waive_branch_gate_reason="<why>".`,
                                    issue_id: issueId,
                                }),
                            },
                        ],
                    };
                }
            }
            // --- World-model-cold gate (MCP-level enforcement) ---
            // /scan must have run at least once before bro can create tasks.
            // The check is "is there any deep_scan_completed audit row?" — once
            // /scan runs once per project lifetime, the gate clears. Without this
            // gate, bro can ship work into an empty `directories` table and plan
            // blind — no project map to reason from.
            const registryGateWaived = args['waive_registry_gate'] === true;
            const registryGateWaiverReason = (args['waive_registry_gate_reason'] ?? '');
            if (registryGateWaived) {
                if (typeof registryGateWaiverReason !== 'string' ||
                    registryGateWaiverReason.trim().length < 10) {
                    return err('waive_registry_gate_reason must be a string ≥10 chars.');
                }
            }
            else {
                const scanRow = db.get(`SELECT COUNT(*) as c FROM audit WHERE event_type = 'deep_scan_completed'`);
                if ((scanRow?.c ?? 0) === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'registry_cold_violation',
                                    message: `World-model-cold gate: no deep_scan_completed audit row exists. ` +
                                        `Run /scan (or call scan_run directly) to discover repos and populate the world model. ` +
                                        `For exceptional cases, pass waive_registry_gate=true with waive_registry_gate_reason="<why>".`,
                                }),
                            },
                        ],
                    };
                }
            }
            // --- Intent-discussion gate (MCP-level enforcement) ---
            // tmb_planning Step 0 mandates discussion_append(kind='intent', body='Human
            // intent verbatim: ...') before task_create_batch. Production showed 0
            // intent rows across 9 issues — bro consistently skipped this write
            // because no gate enforced it. Server-side now does.
            const intentGateWaived = args['waive_intent_gate'] === true;
            const intentGateWaiverReason = (args['waive_intent_gate_reason'] ?? '');
            if (intentGateWaived) {
                if (typeof intentGateWaiverReason !== 'string' ||
                    intentGateWaiverReason.trim().length < 10) {
                    return err('waive_intent_gate_reason must be a string ≥10 chars.');
                }
            }
            else {
                const intentRow = db.get(`SELECT COUNT(*) as c FROM discussions WHERE issue_id = ? AND kind = 'intent'`, [issueId]);
                if ((intentRow?.c ?? 0) === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'intent_gate_violation',
                                    message: `Intent gate: issue ${issueId} has zero kind='intent' discussions. ` +
                                        `tmb_planning Step 0 mandates discussion_append(kind='intent', body='Human intent verbatim: "<the request>"') ` +
                                        `before task_create_batch. For exceptional cases, pass waive_intent_gate=true with waive_intent_gate_reason="<why>".`,
                                    issue_id: issueId,
                                }),
                            },
                        ],
                    };
                }
            }
            // --- Decision-audit gate (MCP-level enforcement) ---
            // Universal: every issue must have at least one kind='decision' discussion
            // summarizing bro's chosen approach (what, why, trade-offs) before
            // task_create_batch. Replaces the older simple/difficult triage gate +
            // decision-when-difficult gate combo. The audit trail is uniformly useful
            // — for trivial work the decision body can be one short sentence; for
            // architectural work it's bro's planned rationale (and a sibling ADR
            // file lands under docs/trustmybot/architecture/manual/decisions/).
            const decisionGateWaived = args['waive_decision_gate'] === true;
            const decisionGateWaiverReason = (args['waive_decision_gate_reason'] ?? '');
            if (decisionGateWaived) {
                if (typeof decisionGateWaiverReason !== 'string' ||
                    decisionGateWaiverReason.trim().length < 10) {
                    return err('waive_decision_gate_reason must be a string ≥10 chars.');
                }
            }
            else {
                const decisionRow = db.get(`SELECT COUNT(*) as c FROM discussions WHERE issue_id = ? AND kind = 'decision'`, [issueId]);
                if ((decisionRow?.c ?? 0) === 0) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    error: 'decision_gate_violation',
                                    message: `Decision gate: issue ${issueId} has zero kind='decision' discussions. ` +
                                        `tmb_planning mandates discussion_append(kind='decision', body='<chosen approach: what, why, trade-offs>') ` +
                                        `before task_create_batch. For architectural changes also author an ADR at docs/trustmybot/architecture/manual/decisions/. ` +
                                        `For trivial waives, pass waive_decision_gate=true with waive_decision_gate_reason="<why>".`,
                                    issue_id: issueId,
                                }),
                            },
                        ],
                    };
                }
            }
            // Resolve the default repo once for all tasks so the branch-existence
            // check can fire even when task.repo is omitted. (#360)
            const defaultRepoRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'`);
            let defaultRepoValue = null;
            if (defaultRepoRow?.value_json) {
                try {
                    const parsed = JSON.parse(defaultRepoRow.value_json);
                    if (typeof parsed === 'string' && parsed.length > 0) {
                        defaultRepoValue = parsed;
                    }
                }
                catch {
                    // malformed config row — leave null
                }
            }
            // Pre-transaction: format-validate then branch-ensure against the
            // resolved repo (explicit > default). Order matters: bad format should
            // produce the format error, not a git error. (#360, #529)
            const dbDir = db.dbPath === ':memory:' ? process.cwd() : dirname(db.dbPath);
            const autocreatedAudits = [];
            for (const t of taskInputs) {
                if (!t.branch_id)
                    throw new Error('Missing required arg: branch_id');
                validateBranchId(t.branch_id);
                let effectiveRepoName = null;
                if (t.repo !== undefined && t.repo !== null && t.repo !== '') {
                    const repo = t.repo;
                    if (repo.includes('..')) {
                        throw new Error(`Invalid repo "${repo}": must not contain "..". Use a relative path like "inner" or "repos/backend".`);
                    }
                    if (repo.startsWith('/')) {
                        throw new Error(`Invalid repo "${repo}": must not start with "/". Use a relative path like "inner" or "repos/backend".`);
                    }
                    effectiveRepoName = repo;
                }
                else {
                    effectiveRepoName = defaultRepoValue;
                }
                if (effectiveRepoName) {
                    const reposRow = db.get(`SELECT path FROM repos WHERE name = ?`, [effectiveRepoName]);
                    let repoPath;
                    if (reposRow) {
                        const rawPath = reposRow.path;
                        repoPath = rawPath.startsWith('/') ? rawPath : resolve(dbDir, rawPath);
                    }
                    else {
                        repoPath = effectiveRepoName;
                    }
                    const parentBranchId = t.parent_branch_id ?? null;
                    const audit = ensureBranchInRepo(t.branch_id, repoPath, parentBranchId);
                    if (audit)
                        autocreatedAudits.push(audit);
                }
            }
            const inserted = db.transaction(() => {
                const results = [];
                const now = nowISO();
                for (const t of taskInputs) {
                    if (!t.branch_id)
                        throw new Error('Missing required arg: branch_id');
                    if (t.parent_branch_id != null)
                        validateParentBranchId(t.parent_branch_id);
                    if (!t.description)
                        throw new Error('Missing required arg: description');
                    if (t.spec_body !== undefined) {
                        if (typeof t.spec_body !== 'string') {
                            throw new Error(`spec_body must be a string, got ${typeof t.spec_body}`);
                        }
                        // Hard cap: SPEC_BODY_MAX_BYTES (default 8000) per task. See the
                        // export at the top of the file for rationale + env override.
                        if (t.spec_body.length > SPEC_BODY_MAX_BYTES) {
                            throw new Error(`spec_body exceeds ${SPEC_BODY_MAX_BYTES} char limit (actual: ${t.spec_body.length}). ` +
                                `Split into multiple tasks via depends_on, or cite existing code/` +
                                `conventions rather than restating them inline. Very long specs ` +
                                `push SWE cold-start into the minutes range; see issue #55. ` +
                                `Override the limit via TMB_SPEC_BODY_MAX_BYTES.`);
                        }
                    }
                    let repoValue = null;
                    if (t.repo !== undefined && t.repo !== null && t.repo !== '') {
                        repoValue = t.repo;
                    }
                    else {
                        repoValue = defaultRepoValue;
                    }
                    // Server-side parent_branch_id default: when omitted/null, resolve from
                    // the per-repo target_branch (v11) falling back to global pr_target.
                    // Fixes L5 92-base-branch where bro skipped reading config('pr_target')
                    // and tasks landed against main on gitflow projects with pr_target='dev'.
                    let parentBranchId = t.parent_branch_id ?? null;
                    if (parentBranchId == null) {
                        // 1. Try per-repo target_branch from the task's repos row.
                        const taskRepoName = t.repo ?? defaultRepoValue;
                        if (taskRepoName) {
                            const repoTargetRow = db.get(`SELECT target_branch FROM repos WHERE name = ?`, [taskRepoName]);
                            if (repoTargetRow?.target_branch) {
                                parentBranchId = repoTargetRow.target_branch;
                            }
                        }
                    }
                    if (parentBranchId == null) {
                        // 2. Fall back to global pr_target.
                        const prTargetRow = db.get(`SELECT value_json FROM plugin_config WHERE key = 'pr_target'`);
                        if (prTargetRow?.value_json) {
                            try {
                                const prTarget = JSON.parse(prTargetRow.value_json);
                                if (typeof prTarget === 'string' && prTarget.length > 0) {
                                    parentBranchId = prTarget;
                                }
                            }
                            catch {
                                // malformed config row — leave as null and fall through
                            }
                        }
                        if (parentBranchId == null)
                            parentBranchId = 'main';
                    }
                    const promptBearing = typeof t.prompt_bearing === 'number' && t.prompt_bearing === 1 ? 1 : 0;
                    db.run(`INSERT INTO tasks
               (issue_id, branch_id, parent_branch_id, title, description,
                status, attempts, spec_body, repo, prompt_bearing, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`, [
                        issueId,
                        t.branch_id,
                        parentBranchId,
                        t.title ?? '',
                        t.description,
                        t.spec_body ?? '',
                        repoValue,
                        promptBearing,
                        now,
                        now,
                    ]);
                    const row = db.get('SELECT * FROM tasks WHERE rowid = last_insert_rowid()');
                    if (row) {
                        results.push(row);
                        // Bro-as-agent_run (#2886): open a bro row per task at planning
                        // time. `completed_at` stays NULL until bro_atomic_close finalizes
                        // the row with duration + (eventually) tokens. Makes bro's
                        // skill/rule invocations attributable to a tracked agent_run.
                        db.run(`INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at)
               VALUES (?, ?, 'bro', ?)`, [row.id, issueId, now]);
                    }
                }
                // Audit rows for any branches auto-created by ensureBranchInRepo (#529).
                for (const ac of autocreatedAudits) {
                    db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, 'trajectory-server', 'tmb_branch_autocreated', ?, ?, ?)`, [
                        issueId,
                        ac.branchId,
                        `Auto-created branch '${ac.branchId}' from '${ac.startPoint}' in repo '${ac.repoPath}'.`,
                        JSON.stringify({ branch: ac.branchId, start_point: ac.startPoint, repo_path: ac.repoPath }),
                        now,
                    ]);
                }
                // Optional atomic audit emission: when emit_planning_complete=true, insert
                // the planning_complete event in the SAME transaction as the task creation.
                // This eliminates the L5 03/12 failure mode where the LLM would create
                // tasks but skip the closing audit_log call. With this flag, the closing
                // event is server-side and cannot be dropped between LLM turns.
                const emitPlanningComplete = args['emit_planning_complete'] === true;
                if (emitPlanningComplete && results.length > 0) {
                    const firstTask = results[0];
                    const branchForAudit = firstTask.branch_id;
                    const summary = args['planning_complete_summary'] ??
                        `Planning complete for issue ${issueId}: ${results.length} task(s) created on ${branchForAudit}.`;
                    const contentJson = JSON.stringify({
                        issue_id: issueId,
                        task_count: results.length,
                        task_branch_ids: results.map((r) => r.branch_id),
                        parent_branch_ids: results.map((r) => r.parent_branch_id),
                    });
                    const fromNode = args['agent'] ?? 'bro';
                    db.run(`INSERT INTO audit
               (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'planning_complete', ?, ?, ?)`, [issueId, branchForAudit, fromNode, summary, contentJson, now]);
                }
                // Audit log for gate waivers so pr-reviewer / human-review can flag
                // tasks that skipped the alignment loop. Runs inside the same txn as
                // task INSERTs so a crash between commit and audit cannot lose the record.
                // One row per waived gate (#358).
                const firstBranch = results[0]?.branch_id ?? '';
                const agentFromNode = args['agent'];
                if (waived) {
                    db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'scope_gate_waived', ?, ?, ?)`, [
                        issueId,
                        firstBranch,
                        agentFromNode,
                        waiverReason.slice(0, 200),
                        JSON.stringify({
                            waive_scope_gate_reason: waiverReason,
                            tasks_created: results.length,
                        }),
                        now,
                    ]);
                }
                if (branchGateWaived) {
                    db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'branch_gate_waived', ?, ?, ?)`, [
                        issueId,
                        firstBranch,
                        agentFromNode,
                        branchGateWaiverReason.slice(0, 200),
                        JSON.stringify({ waive_branch_gate_reason: branchGateWaiverReason, tasks_created: results.length }),
                        now,
                    ]);
                }
                if (registryGateWaived) {
                    db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'registry_gate_waived', ?, ?, ?)`, [
                        issueId,
                        firstBranch,
                        agentFromNode,
                        registryGateWaiverReason.slice(0, 200),
                        JSON.stringify({ waive_registry_gate_reason: registryGateWaiverReason, tasks_created: results.length }),
                        now,
                    ]);
                }
                if (intentGateWaived) {
                    db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'intent_gate_waived', ?, ?, ?)`, [
                        issueId,
                        firstBranch,
                        agentFromNode,
                        intentGateWaiverReason.slice(0, 200),
                        JSON.stringify({ waive_intent_gate_reason: intentGateWaiverReason, tasks_created: results.length }),
                        now,
                    ]);
                }
                if (decisionGateWaived) {
                    db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'decision_gate_waived', ?, ?, ?)`, [
                        issueId,
                        firstBranch,
                        agentFromNode,
                        decisionGateWaiverReason.slice(0, 200),
                        JSON.stringify({ waive_decision_gate_reason: decisionGateWaiverReason, tasks_created: results.length }),
                        now,
                    ]);
                }
                if (specShapeWaived) {
                    db.run(`INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
             VALUES (?, ?, ?, 'spec_shape_gate_waived', ?, ?, ?)`, [
                        issueId,
                        firstBranch,
                        agentFromNode,
                        specShapeWaiverReason.slice(0, 200),
                        JSON.stringify({ waive_spec_shape_reason: specShapeWaiverReason, tasks_created: results.length }),
                        now,
                    ]);
                }
                return results;
            });
            // --- Gate 6: Parallel-overlap field ---
            // Compute pairwise ## Files-section overlap across the batch and return
            // parallel_groups (safe to run concurrently) + overlapping_pairs.
            // Pure response enrichment — no gating, no error on overlap.
            const parallelGroups = [];
            const overlappingPairs = [];
            if (inserted.length > 1) {
                const taskFilePaths = inserted.map((t) => ({
                    id: t.id,
                    paths: specFileDirs(t.spec_body ?? ''),
                }));
                const adjMatrix = new Map();
                for (const t of taskFilePaths)
                    adjMatrix.set(t.id, new Set());
                for (let i = 0; i < taskFilePaths.length; i++) {
                    for (let j = i + 1; j < taskFilePaths.length; j++) {
                        const a = taskFilePaths[i];
                        const b = taskFilePaths[j];
                        const shared = [...a.paths].filter((p) => b.paths.has(p));
                        if (shared.length > 0) {
                            overlappingPairs.push({ a: a.id, b: b.id, shared_paths: shared });
                            adjMatrix.get(a.id).add(b.id);
                            adjMatrix.get(b.id).add(a.id);
                        }
                    }
                }
                const visited = new Set();
                for (const t of taskFilePaths) {
                    if (visited.has(t.id))
                        continue;
                    if ((adjMatrix.get(t.id)?.size ?? 0) === 0) {
                        parallelGroups.push([t.id]);
                        visited.add(t.id);
                    }
                    else {
                        const group = [t.id];
                        visited.add(t.id);
                        for (const neighbor of adjMatrix.get(t.id)) {
                            if (!visited.has(neighbor)) {
                                group.push(neighbor);
                                visited.add(neighbor);
                            }
                        }
                        parallelGroups.push(group);
                    }
                }
            }
            return ok({ tasks: inserted, parallel_groups: parallelGroups, overlapping_pairs: overlappingPairs });
        })),
        task_get: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const taskId = requireArg(args, 'task_id');
            const task = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (!task) {
                throw new Error(`Not found: ${taskId}`);
            }
            return ok(task);
        }),
        task_update_status: requireRoles('task_update_status', ['bro', 'swe'], wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const agent = normalizeAgent(args['agent']);
            const taskId = requireArg(args, 'task_id');
            const status = requireArg(args, 'status');
            const rawCommitSha = args['commit_sha'] !== undefined
                ? args['commit_sha'].toLowerCase()
                : undefined;
            if (!VALID_STATUSES.has(status)) {
                throw new Error(`Invalid status: ${status}. Valid values: ${[...VALID_STATUSES].join(', ')}`);
            }
            if (rawCommitSha !== undefined) {
                if (rawCommitSha.length < 7 || !/^[0-9a-f]+$/.test(rawCommitSha)) {
                    throw new Error(`Invalid commit_sha: "${rawCommitSha}". Must be a hex string of at least 7 characters (short SHA) or 40 characters (full SHA).`);
                }
            }
            const task = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
            if (!task) {
                throw new Error(`Not found: ${taskId}`);
            }
            if (agent === 'swe') {
                if (SWE_LOCKED_SOURCE_STATES.has(task.status)) {
                    throw new Error(`task_update_status rejected: SWE may not move task ${taskId} out of '${task.status}'. ` +
                        `'${task.status}' is terminal for SWE. See #114.`);
                }
                if (!SWE_ALLOWED_TARGET_STATUSES.has(status)) {
                    throw new Error(`task_update_status rejected: SWE may only set status to 'running', 'completed', or 'failed' (got '${status}'). ` +
                        `Pre-execution states (pending, escalated) are bro-managed; 'closed' is bro's atomic-close transition; ` +
                        `'needs_validation' is not a valid SWE terminal state — use 'failed' instead if the work blocked. See #114.`);
                }
            }
            if (agent === 'bro' && status !== task.status) {
                const allowed = BRO_TRANSITIONS[task.status] ?? new Set();
                if (!allowed.has(status)) {
                    const valid = [...allowed].join(', ') || '(none — terminal)';
                    throw new Error(`task_update_status rejected: bro may not move task ${taskId} from '${task.status}' to '${status}'. ` +
                        `Allowed from '${task.status}': ${valid}. ` +
                        `Close verified work via bro_atomic_close; reopen a closed task by escalating. See #278.`);
                }
            }
            const now = nowISO();
            const attempts = args['attempts'] !== undefined ? args['attempts'] : task.attempts;
            // completed_at is carried only by post-completion states. Stamp it on
            // 'completed', preserve it through 'closed', and clear it on any move to
            // an active/failed/escalated state — a reopened task must not keep a
            // stale completion stamp that downstream gates would trust (#278).
            const completedAt = status === 'completed' ? now : status === 'closed' ? task.completed_at : null;
            if (rawCommitSha !== undefined) {
                db.run(`UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ?, commit_sha = ? WHERE id = ?`, [status, attempts, now, completedAt, rawCommitSha, taskId]);
            }
            else {
                db.run(`UPDATE tasks SET status = ?, attempts = ?, updated_at = ?, completed_at = ? WHERE id = ?`, [status, attempts, now, completedAt, taskId]);
            }
            const updated = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
            return ok(updated);
        })),
        task_first_actionable: wrapHandler(async (args) => {
            requireArg(args, 'agent');
            const issueId = requireArg(args, 'issue_id');
            const task = db.get(`SELECT * FROM tasks
         WHERE issue_id = ? AND status IN ('pending', 'failed')
         ORDER BY branch_id ASC
         LIMIT 1`, [issueId]);
            return ok(task ?? null);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=tasks.js.map