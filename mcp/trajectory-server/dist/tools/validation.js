import { nowISO } from '../db.js';
import { normalizeAgent, redactValidationRow, requireRoles } from '../middleware/agent-scope.js';
import { insertAudit } from './audit.js';
import { applyReopenInTx, atLeastReworkFloor, insertEffortRaised } from './reopen.js';
import { PROBE_SHAPE, parseProbes, probesJson } from './review-probes.js';
import { FINDING_ORDER_SQL, PASS_RUN_SQL, VERIFICATION_RUN_REQUIRED, latestVerificationRun, passRunRefusal } from './verification-runs.js';
import { SPAWN_NOTE_MAX_CHARS, WM_FEEDBACK_KEYS, toWmFeedback, wmFeedbackProblem } from '../success-criteria.js';
const VALID_VERDICTS = new Set(['pass', 'fail', 'escalate']);
/** The statuses a code-reviewer FAIL moves back to running: work handed to review, or closed after it. */
const AUTO_REOPEN_STATUSES = new Set(['completed', 'needs_validation', 'closed']);
function reviewFailSpawnNote(validationId, findings) {
    const listed = findings.map((f) => (f.class ? `${f.id} (${f.class})` : f.id)).join(', ');
    const note = `Reopened by review FAIL (validation ${validationId}); fix ${listed}: task_brief.open_findings has each probe.`;
    return note.length > SPAWN_NOTE_MAX_CHARS ? `${note.slice(0, SPAWN_NOTE_MAX_CHARS - 1)}…` : note;
}
/**
 * What a code-reviewer FAIL does to its task, inside validation_record's
 * transaction (GH 2866): a completed, needs_validation or closed task of an
 * open issue is reopened to running at the rework floor effort; a running one
 * only has its effort raised to the floor; any other status, or a closed
 * issue, is left as it is. The reopen's task_reopened row keeps the cleared
 * completion report and stamp, which a re-review of the same commit restores.
 */
function reopenAfterReviewFail(db, fail) {
    const agent = 'code-reviewer';
    const task = db.get(`SELECT t.id, t.issue_id, t.branch_id, t.status, t.effort, t.completion_report, t.completed_at, i.status AS issue_status
       FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id WHERE t.id = ?`, [fail.taskId]);
    if (!task)
        return { reopen_skipped: { reason: 'task_missing' } };
    if (task.issue_status === null)
        return { reopen_skipped: { reason: 'issue_missing' } };
    if (task.issue_status === 'closed')
        return { reopen_skipped: { reason: 'issue_closed' } };
    const effort = atLeastReworkFloor(task.effort);
    const raise = effort !== task.effort;
    if (task.status === 'running') {
        if (raise) {
            db.run(`UPDATE tasks SET effort = ?, updated_at = ? WHERE id = ?`, [effort, fail.now, task.id]);
            insertEffortRaised(db, { issue_id: task.issue_id, branch_id: task.branch_id, task_id: task.id }, task.effort, effort, agent, fail.now);
        }
        return { reopen_skipped: { reason: 'status_running', effort_raised: raise } };
    }
    if (!AUTO_REOPEN_STATUSES.has(task.status))
        return { reopen_skipped: { reason: `status_${task.status}` } };
    const findingIds = fail.findings.map((f) => f.id);
    const raised = applyReopenInTx(db, {
        task,
        agent,
        reason: `code-reviewer FAIL (validation ${fail.validationId}): ${findingIds.join(', ')}`,
        effort,
        spawnNote: reviewFailSpawnNote(fail.validationId, fail.findings),
        now: fail.now,
        auditContent: {
            validation_id: fail.validationId,
            finding_ids: findingIds,
            auto: true,
            completion_report: task.completion_report,
            completed_at: task.completed_at,
        },
    });
    return {
        reopened: { task_id: task.id, from_status: task.status, status: 'running', effort, effort_raised: raised, finding_ids: findingIds },
    };
}
export const WM_FEEDBACK_SCHEMA = {
    type: 'object',
    description: 'Optional: what the world model answered, missed or got wrong during this task, each in a sentence. Stored as one wm_feedback audit row, none when every field is blank; trajectory_doctor counts them.',
    properties: {
        answered: { type: 'string', description: 'What a world_model_* call answered that saved a Grep, Glob or Read.' },
        missed: { type: 'string', description: 'What it had no answer for, so Grep or a Read found it instead.' },
        wrong: { type: 'string', description: 'What it returned that the code contradicts.' },
    },
    additionalProperties: false,
};
/** One wm_feedback audit row on the task's issue (GH 2417), none when every field is absent or blank (GH 2421). */
export function insertWmFeedback(db, task, agent, feedback, createdAt) {
    if (WM_FEEDBACK_KEYS.every((k) => (feedback[k] ?? '').trim() === ''))
        return;
    const flagged = ['missed', 'wrong'].filter((k) => (feedback[k] ?? '').trim() !== '');
    insertAudit(db, {
        issue_id: task.issue_id,
        branch_id: task.branch_id ?? null,
        from_node: agent,
        event_type: 'wm_feedback',
        summary: `${agent} world-model feedback on task ${task.id}${flagged.length > 0 ? ` (${flagged.join(', ')})` : ''}`,
        content_json: JSON.stringify({
            task_id: task.id,
            agent,
            answered: feedback.answered ?? null,
            missed: feedback.missed ?? null,
            wrong: feedback.wrong ?? null,
        }),
        created_at: createdAt,
    });
}
/** The head of code-reviewer's final message (GH 1959), built from the row validation_record just wrote. */
export function reviewerReturnLine(row, commitSha, findings) {
    const sha = commitSha ? commitSha.slice(0, 8) : '-';
    return `verdict=${row.verdict} task=${row.task_id} sha=${sha} attempt=${row.attempt_n} row=${row.id} findings=${findings}`;
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
export const REVIEWER_OBSERVE_FROM_NODE = 'hook:reviewer-identity-observe';
export const REVIEWER_OBSERVATION_TTL_S = 600;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
function latestObservation(db, taskId, attemptN) {
    return db.get(`SELECT id,
            json_extract(content_json, '$.session_id') AS session_id,
            json_extract(content_json, '$.agent_id') AS agent_id,
            COALESCE(json_extract(content_json, '$.observed_at'), created_at) AS observed_at
       FROM audit
      WHERE event_type = 'reviewer_identity_observed'
        AND from_node = ?
        AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
        AND CAST(json_extract(content_json, '$.attempt_n') AS INTEGER) = ?
        AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
        AND COALESCE(json_extract(content_json, '$.superseded'), 0) = 0
      ORDER BY id DESC
      LIMIT 1`, [REVIEWER_OBSERVE_FROM_NODE, taskId, attemptN]);
}
export const REVIEWER_SPAWN_FROM_NODE = 'hook:record-reviewer-spawn';
function reviewedSha(db, taskId, attemptN) {
    return (db.get(`SELECT json_extract(content_json, '$.commit_sha') AS sha
         FROM audit
        WHERE event_type = 'reviewer_spawn_observed'
          AND from_node = ?
          AND json_valid(content_json)
          AND json_type(content_json, '$.commit_sha') = 'text'
          AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
          AND CAST(json_extract(content_json, '$.attempt_n') AS INTEGER) = ?
        ORDER BY id DESC
        LIMIT 1`, [REVIEWER_SPAWN_FROM_NODE, taskId, attemptN])?.sha ?? null);
}
function supersedeOlderObservations(db, taskId, attemptN, consumedId, now) {
    db.run(`UPDATE audit
        SET content_json = json_set(content_json, '$.superseded', 1, '$.superseded_by', CAST(? AS INTEGER), '$.superseded_at', ?)
      WHERE event_type = 'reviewer_identity_observed'
        AND from_node = ?
        AND id < ?
        AND json_valid(content_json)
        AND CAST(json_extract(content_json, '$.task_id') AS INTEGER) = ?
        AND CAST(json_extract(content_json, '$.attempt_n') AS INTEGER) = ?
        AND COALESCE(json_extract(content_json, '$.consumed'), 0) = 0
        AND COALESCE(json_extract(content_json, '$.superseded'), 0) = 0`, [consumedId, now, REVIEWER_OBSERVE_FROM_NODE, consumedId, taskId, attemptN]);
}
function observationAgeS(observation, nowMs) {
    const observedMs = Date.parse(String(observation.observed_at ?? ''));
    return Number.isFinite(observedMs) ? Math.floor((nowMs - observedMs) / 1000) : Number.POSITIVE_INFINITY;
}
const FINDING_SEVERITIES = ['blocking', 'nit', 'pre_existing'];
const FINDING_KEYS = new Set(['criterion_id', 'probe_cmd', 'expected', 'observed', 'severity', 'class']);
const FINDING_SHAPE = '{criterion_id?, probe_cmd, expected, observed, severity?, class?}';
/**
 * The typed findings[] of a verdict. probe_cmd, expected and observed are
 * trimmed non-empty strings; criterion_id and class are non-empty strings or
 * absent/null; severity is blocking (the default), nit or pre_existing.
 * fail needs at least one blocking finding, pass takes only nit and
 * pre_existing ones, escalate needs a non-empty list.
 */
function parseFindings(verdict, raw) {
    const list = raw === undefined || raw === null ? [] : raw;
    if (!Array.isArray(list)) {
        throw new Error(`findings must be an array of ${FINDING_SHAPE}; got ${typeof raw}`);
    }
    if (verdict !== 'pass' && list.length === 0) {
        throw new Error(`findings_required: a ${verdict} verdict needs a non-empty findings[] — one ${FINDING_SHAPE} per defect, each probe_cmd a command that exits 0 once the defect is fixed.`);
    }
    const findings = list.map((item, i) => parseFinding(item, i));
    if (verdict === 'pass') {
        const blocking = findings.findIndex((f) => f.severity === 'blocking');
        if (blocking >= 0) {
            throw new Error(`findings_refused: a pass verdict records only nit or pre_existing findings; findings[${blocking}] is blocking (an omitted severity is blocking). Send a blocking finding with verdict fail or escalate.`);
        }
    }
    if (verdict === 'fail' && !findings.some((f) => f.severity === 'blocking')) {
        throw new Error('findings_required: a fail verdict needs at least one finding with severity blocking (an omitted severity is blocking); nit and pre_existing findings alone ride on a pass.');
    }
    return findings;
}
function parseFinding(item, i) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(`findings[${i}] must be an object ${FINDING_SHAPE}`);
    }
    const entry = item;
    const unknown = Object.keys(entry).filter((k) => !FINDING_KEYS.has(k));
    if (unknown.length > 0) {
        throw new Error(`findings[${i}] has unknown field(s) ${unknown.join(', ')}; the server assigns id and status. Allowed: ${[...FINDING_KEYS].join(', ')}`);
    }
    const text = (field) => {
        const v = entry[field];
        if (typeof v !== 'string' || v.trim() === '') {
            throw new Error(`findings[${i}].${field} must be a non-empty string`);
        }
        return v.trim();
    };
    const criterion = entry['criterion_id'];
    if (criterion !== undefined && criterion !== null && (typeof criterion !== 'string' || criterion.trim() === '')) {
        throw new Error(`findings[${i}].criterion_id must be a non-empty string or null`);
    }
    const severity = entry['severity'] ?? 'blocking';
    if (!FINDING_SEVERITIES.includes(severity)) {
        throw new Error(`findings[${i}].severity must be one of ${FINDING_SEVERITIES.join(', ')}; got ${JSON.stringify(severity)}`);
    }
    const cls = entry['class'];
    if (cls !== undefined && cls !== null && (typeof cls !== 'string' || cls.trim() === '')) {
        throw new Error(`findings[${i}].class must be a non-empty string or null`);
    }
    return {
        criterion_id: typeof criterion === 'string' ? criterion.trim() : null,
        probe_cmd: text('probe_cmd'),
        expected: text('expected'),
        observed: text('observed'),
        severity: severity,
        class: typeof cls === 'string' ? cls.trim() : null,
    };
}
/** A validation_attempts row with its probes_json column read back as probes (null when none were recorded). */
function withProbes(row) {
    const { probes_json: stored, ...rest } = row;
    return { ...rest, probes: stored ? JSON.parse(stored) : null };
}
function coerceTaskId(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`task_id must be a positive integer; got: ${JSON.stringify(raw)}`);
    }
    return n;
}
export function validationTools(db) {
    const definitions = [
        {
            name: 'validation_record',
            description: 'Record a validation attempt for a task. subagent_session_id and reviewer_agent_id come from the fresh (<=600 s) reviewer-identity-observe hook row for (task_id, attempt_n); caller values are ignored. ' +
                'A pass is refused (verification_run_required) unless the newest verification run at tasks.commit_sha exited 0 and did not time out. ' +
                "Each finding becomes a review_findings row. Append-only: an attempt_n that already has a row is stored as the task's highest attempt_n + 1, and the result reports the stored attempt. wm_feedback's audit row goes on the task's issue.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                    attempt_n: { type: 'number' },
                    verdict: {
                        type: 'string',
                        enum: ['pass', 'fail', 'escalate'],
                        description: "pass needs the task's newest verification run at tasks.commit_sha to have exited 0 without timing out (prefix match on the sha, so a merge-only re-review of a later sha passes on the task commit's run); else verification_run_required names what was found: no commit, no run, only a run at another commit, a timed-out run or a failed one. fail and escalate need no run.",
                    },
                    feedback: { type: 'string' },
                    mcp_available: { type: 'boolean', description: 'Required when agent="code-reviewer": true if the review ran with the trajectory MCP up, false for the honor-system fallback. The typed push-gate signal bro reads from the validation row.' },
                    subagent_session_id: { type: 'string', description: 'Ignored: derived from the hook observation. Recorded only on the mcp_available:false honor-system path when no observation exists.' },
                    findings: {
                        type: 'array',
                        description: 'One entry per defect. A fail verdict needs at least one blocking finding; escalate needs a non-empty list; pass takes only nit and pre_existing findings (absent or [] when there are none). ' +
                            'The server assigns each id F<task_id>-<n> (n counts up per task) and status open; findings attach to the stored attempt and are never deleted. ' +
                            'On every later task_update_status(completed) the swe verification gate runs each non-wontfix blocking finding\'s probe_cmd after verification[]: ' +
                            'a passing probe marks an open finding fixed (resolved_at set); any failing probe fails the gate, and a failing fixed finding is reported as a regression. ' +
                            'task_brief.open_findings shows the open blocking ones to the swe; nit and pre_existing findings stay on record and block nothing.',
                        items: {
                            type: 'object',
                            properties: {
                                criterion_id: { type: ['string', 'null'], description: 'The spec Success Criteria id the finding breaks (e.g. "SC2"). Omit or null when it covers no single criterion.' },
                                probe_cmd: {
                                    type: 'string',
                                    description: 'Self-contained shell command, run with bash -c from the task worktree root, that exits 0 once the finding is fixed and non-zero while it stands. ' +
                                        'Inline node -e, bash -c or a heredoc is fine; it must not depend on files only the reviewer has. Example: grep -q "findings" mcp/trajectory-server/src/tools/validation.ts',
                                },
                                expected: { type: 'string', description: 'What correct behaviour looks like (what the probe checks for).' },
                                observed: { type: 'string', description: 'What the reviewer saw instead, with the file:line or output that shows it.' },
                                severity: {
                                    type: 'string',
                                    enum: [...FINDING_SEVERITIES],
                                    description: 'blocking (default) fails the verdict and gates the close; nit is a non-blocking style or polish note; pre_existing is a defect the task did not introduce.',
                                },
                                class: { type: ['string', 'null'], description: 'The bug class this finding belongs to, so its siblings can be swept together. Omit or null when none.' },
                            },
                            required: ['probe_cmd', 'expected', 'observed'],
                            additionalProperties: false,
                        },
                    },
                    probes: {
                        type: 'array',
                        description: `The checks run in the reviewed checkout, ${PROBE_SHAPE}: what it checks, the command, what it showed. A pass needs one or more (probes_required); fail and escalate may carry them.`,
                        items: {
                            type: 'object',
                            properties: { target: { type: 'string' }, probe_cmd: { type: 'string' }, observed: { type: 'string' } },
                            required: ['target', 'probe_cmd', 'observed'],
                            additionalProperties: false,
                        },
                    },
                    wm_feedback: WM_FEEDBACK_SCHEMA,
                },
                required: ['agent', 'task_id', 'attempt_n', 'verdict', 'feedback'],
            },
        },
        {
            name: 'validation_history',
            description: 'All validation attempts for a task by attempt_n ascending. Each row carries reviewed_sha, the commit reviewed (or null), verification_run, the latest gate run the attempt started (null when none), findings, the review_findings rows of that attempt, and probes (null when none; both withheld wherever feedback is). ' +
                'Without limit, a bare array; with limit, {rows, next_cursor}.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    task_id: { type: 'string' },
                    own_task_id: { type: 'string', description: 'The calling agent\'s own task ID (used to gate feedback access for swe)' },
                    limit: { type: 'number', description: 'Optional — max rows to return. When provided, response includes next_cursor.' },
                    cursor: { type: 'string', description: 'Opaque cursor from a previous response.' },
                    fields: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional column projection. Allowed: id, task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, reviewer_agent_id, reviewed_sha, created_at, verification_run, findings, probes. Unknown fields return a named error. Default: all columns.',
                    },
                },
                required: ['agent', 'task_id'],
            },
        },
    ];
    const handlers = {
        // LOAD-BEARING-SAFETY: only code-reviewer writes a verdict, never bro on its behalf. Bro impersonating
        // code-reviewer is a content-integrity violation, so this refuses bro's identity, and the auto-mode
        // classifier blocks bro's raw DB writes as impersonation; the honor-system validation-record-fallback
        // CLI is for code-reviewer itself to write the row when this server is down.
        validation_record: requireRoles('validation_record', ['code-reviewer'], wrapHandler(async (args) => {
            const agent = requireArg(args, 'agent');
            const taskId = coerceTaskId(requireArg(args, 'task_id'));
            requireArg(args, 'attempt_n');
            const verdict = requireArg(args, 'verdict');
            requireArg(args, 'feedback');
            const role = normalizeAgent(agent);
            const mcpAvailableArg = args['mcp_available'];
            if (role === 'code-reviewer' && typeof mcpAvailableArg !== 'boolean') {
                throw new Error('precondition_failed: validation_record with agent="code-reviewer" requires mcp_available (boolean) — the typed push-gate signal bro reads (true=MCP up, false=honor-system fallback).');
            }
            const mcpAvailable = mcpAvailableArg === false ? 0 : 1;
            if (!VALID_VERDICTS.has(verdict)) {
                throw new Error(`Invalid verdict: "${verdict}". Allowed values: ${[...VALID_VERDICTS].join(', ')}`);
            }
            const findings = parseFindings(verdict, args['findings']);
            const probes = parseProbes(verdict, args['probes']);
            const wmFeedbackArg = args['wm_feedback'];
            let wmFeedback = null;
            if (wmFeedbackArg !== undefined && wmFeedbackArg !== null) {
                const problem = wmFeedbackProblem(wmFeedbackArg, 'wm_feedback');
                if (problem)
                    throw new Error(`wm_feedback_invalid: ${problem}`);
                wmFeedback = toWmFeedback(wmFeedbackArg);
            }
            const taskExists = db.get(`SELECT t.id, t.issue_id, t.branch_id, COALESCE(t.repo, i.repo) AS repo, t.commit_sha
           FROM tasks t LEFT JOIN issues i ON i.id = t.issue_id
          WHERE t.id = ?`, [taskId]);
            if (!taskExists) {
                throw new Error(`task_id=${taskId} not found in tasks table`);
            }
            const attemptN = args['attempt_n'];
            const feedback = args['feedback'];
            const now = nowISO();
            const callerSessionId = typeof args['subagent_session_id'] === 'string' ? args['subagent_session_id'] : null;
            const findingIds = [];
            let storedAttempt = attemptN;
            let rowId = 0;
            let reopen;
            db.transaction(() => {
                const latest = latestObservation(db, taskId, attemptN);
                const ageS = latest ? observationAgeS(latest, Date.now()) : 0;
                const staleRow = latest !== undefined && ageS > REVIEWER_OBSERVATION_TTL_S ? latest : undefined;
                const observed = staleRow ? undefined : latest;
                let subagentSessionId;
                let reviewerAgentId;
                if (observed) {
                    const observedAgentId = typeof observed.agent_id === 'string' ? observed.agent_id : '';
                    if (observedAgentId === '') {
                        throw new Error(`reviewer_not_independent: the observed validation_record call for task ${taskId} attempt ${attemptN} carried no agent_id — it came from the main loop, not a code-reviewer subagent.`);
                    }
                    if (!AGENT_ID_RE.test(observedAgentId)) {
                        throw new Error(`reviewer_agent_id_malformed: observed agent_id ${JSON.stringify(observedAgentId)} does not match [A-Za-z0-9_-]{8,64}.`);
                    }
                    const sweRun = db.get(`SELECT id FROM agent_runs WHERE task_id = ? AND agent_type = 'swe' AND spawn_id = ? LIMIT 1`, [taskId, observedAgentId]);
                    if (sweRun) {
                        throw new Error(`reviewer_not_independent: reviewer agent_id ${observedAgentId} is the swe that ran task ${taskId}; spawn a separate code-reviewer.`);
                    }
                    subagentSessionId = typeof observed.session_id === 'string' && observed.session_id !== '' ? observed.session_id : null;
                    reviewerAgentId = observedAgentId;
                    db.run(`UPDATE audit SET content_json = json_set(content_json, '$.consumed', 1) WHERE id = ?`, [observed.id]);
                    supersedeOlderObservations(db, taskId, attemptN, observed.id, now);
                }
                else if (mcpAvailable === 0) {
                    subagentSessionId = callerSessionId;
                    reviewerAgentId = null;
                    insertAudit(db, {
                        issue_id: taskExists.issue_id,
                        from_node: 'trajectory-server',
                        event_type: 'validation_session_unverified',
                        summary: `validation_record for task ${taskId} attempt ${attemptN} recorded on the honor-system path without a hook-observed reviewer identity`,
                        content_json: JSON.stringify({ task_id: taskId, attempt_n: attemptN, subagent_session_id: callerSessionId }),
                        created_at: now,
                    });
                }
                else if (staleRow) {
                    const age = Number.isFinite(ageS) ? `${ageS}s old` : 'of unknown age';
                    throw new Error(`subagent_session_unavailable: the newest unconsumed reviewer_identity_observed row for task ${taskId} attempt ${attemptN} (audit id ${staleRow.id}) is ${age}, past the ${REVIEWER_OBSERVATION_TTL_S}s freshness window; call validation_record again so the reviewer-identity-observe hook records a fresh row.`);
                }
                else {
                    throw new Error(`subagent_session_unavailable: no reviewer_identity_observed row for task ${taskId} attempt ${attemptN}. validation_record must be called by a spawned code-reviewer subagent (the reviewer-identity-observe hook records its identity); pass mcp_available:false only on the honor-system path.`);
                }
                if (verdict === 'pass') {
                    const run = db.get(PASS_RUN_SQL, [taskId, (taskExists.commit_sha ?? '').toLowerCase()]);
                    const refusal = passRunRefusal(taskId, taskExists.commit_sha, run);
                    if (refusal)
                        throw new Error(`${VERIFICATION_RUN_REQUIRED}: ${refusal}`);
                }
                storedAttempt = db.get(`SELECT CASE WHEN EXISTS (SELECT 1 FROM validation_attempts WHERE task_id = ?1 AND attempt_n = ?2)
                  THEN (SELECT MAX(attempt_n) + 1 FROM validation_attempts WHERE task_id = ?1)
                  ELSE ?2 END AS n`, [taskId, attemptN])?.n ?? attemptN;
                rowId = db.run(`INSERT INTO validation_attempts
             (task_id, attempt_n, agent, verdict, feedback, mcp_available, subagent_session_id, reviewer_agent_id, reviewed_sha, created_at, repo, probes_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [taskId, storedAttempt, agent, verdict, feedback, mcpAvailable, subagentSessionId, reviewerAgentId, reviewedSha(db, taskId, attemptN), now, taskExists.repo, probesJson(probes)]).lastInsertRowid;
                const lastN = db.get(`SELECT MAX(${FINDING_ORDER_SQL}) AS n FROM review_findings WHERE task_id = ?`, [taskId])?.n ?? 0;
                findings.forEach((f, i) => {
                    const id = `F${taskId}-${lastN + i + 1}`;
                    db.run(`INSERT INTO review_findings (id, task_id, attempt_n, criterion_id, probe_cmd, expected, observed, status, created_at, severity, class)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`, [id, taskId, storedAttempt, f.criterion_id, f.probe_cmd, f.expected, f.observed, now, f.severity, f.class]);
                    findingIds.push(id);
                });
                if (wmFeedback)
                    insertWmFeedback(db, taskExists, agent, wmFeedback, now);
                if (verdict === 'fail') {
                    const blocking = findings.flatMap((f, i) => (f.severity === 'blocking' ? [{ id: findingIds[i], class: f.class }] : []));
                    reopen = reopenAfterReviewFail(db, { taskId, validationId: Number(rowId), findings: blocking, now });
                }
            });
            const row = db.get(`SELECT * FROM validation_attempts WHERE rowid = ?`, [rowId]);
            const recorded = findingIds.map((id) => ({ ...db.get('SELECT * FROM review_findings WHERE id = ?', [id]) }));
            return ok({
                ...(row ? withProbes(row) : {}),
                findings: recorded,
                ...reopen,
                return_line: row ? reviewerReturnLine(row, taskExists.commit_sha, recorded.length) : undefined,
            });
        })),
        validation_history: wrapHandler(async (args) => {
            const agent = normalizeAgent(args['agent']);
            const taskId = coerceTaskId(requireArg(args, 'task_id'));
            const ownTaskIdRaw = args['own_task_id'];
            const ownTaskId = ownTaskIdRaw !== undefined && ownTaskIdRaw !== null
                ? coerceTaskId(ownTaskIdRaw)
                : undefined;
            const limitArg = args['limit'];
            const cursorArg = args['cursor'];
            const fieldsArg = args['fields'];
            const ALLOWED_VALIDATION_FIELDS = new Set(['id', 'task_id', 'attempt_n', 'agent', 'verdict', 'feedback', 'mcp_available', 'subagent_session_id', 'reviewer_agent_id', 'reviewed_sha', 'created_at', 'verification_run', 'findings', 'probes']);
            if (fieldsArg !== undefined) {
                const unknown = fieldsArg.filter((f) => !ALLOWED_VALIDATION_FIELDS.has(f));
                if (unknown.length > 0) {
                    return err(`Unknown fields: ${unknown.join(', ')}. Allowed: ${[...ALLOWED_VALIDATION_FIELDS].join(', ')}`);
                }
            }
            const findingCols = ['id', 'criterion_id', 'status', 'probe_cmd', 'expected', 'observed', 'severity', 'class'].filter((c) => (db.get(`SELECT COUNT(*) AS n FROM pragma_table_info('review_findings') WHERE name = ?`, [c])?.n ?? 0) > 0);
            function attemptFindings(attemptN) {
                return db.all(`SELECT ${findingCols.join(', ')} FROM review_findings WHERE task_id = ? AND attempt_n = ? ORDER BY rowid`, [taskId, attemptN]);
            }
            function projectRow(redacted) {
                const { probes, ...attempt } = withProbes(redacted);
                const row = {
                    ...attempt,
                    verification_run: latestVerificationRun(db, taskId, { startedBy: String(redacted.created_at) }),
                };
                if ('feedback' in redacted) {
                    row['findings'] = attemptFindings(Number(redacted.attempt_n));
                    row['probes'] = probes;
                }
                if (!fieldsArg)
                    return row;
                const out = {};
                for (const f of fieldsArg)
                    out[f] = row[f];
                return out;
            }
            if (limitArg === undefined || limitArg === null) {
                const rows = db.all(`SELECT * FROM validation_attempts WHERE task_id = ? ORDER BY attempt_n ASC`, [taskId]);
                return ok(rows.map((row) => projectRow(redactValidationRow(row, agent, { own_task_id: ownTaskId }))));
            }
            const limit = Math.min(Math.max(1, limitArg), 500);
            let cursorFilter = '';
            let cursorParams = [];
            if (cursorArg) {
                try {
                    const decoded = JSON.parse(Buffer.from(cursorArg, 'base64').toString('utf8'));
                    if (typeof decoded.attempt_n === 'number') {
                        cursorFilter = 'AND attempt_n > ?';
                        cursorParams = [decoded.attempt_n];
                    }
                }
                catch {
                    // ignore invalid cursor
                }
            }
            const sql = 'SELECT * FROM validation_attempts WHERE task_id = ? ' +
                cursorFilter +
                ' ORDER BY attempt_n ASC LIMIT ?';
            const fetchedRows = db.all(sql, [taskId, ...cursorParams, limit + 1]);
            const hasMore = fetchedRows.length > limit;
            const rows = hasMore ? fetchedRows.slice(0, limit) : fetchedRows;
            const last = rows[rows.length - 1];
            const next_cursor = hasMore && last
                ? Buffer.from(JSON.stringify({ attempt_n: last.attempt_n })).toString('base64')
                : undefined;
            return ok({
                rows: rows.map((row) => projectRow(redactValidationRow(row, agent, { own_task_id: ownTaskId }))),
                next_cursor,
            });
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=validation.js.map