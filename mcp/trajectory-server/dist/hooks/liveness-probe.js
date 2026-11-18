/**
 * The reports-only liveness probe (GH 2205): `probe` turns injected time, load,
 * run rows, background tasks and file stats into findings, and the
 * liveness-sentinel and liveness-alert gates report them. Nothing here kills,
 * closes or fails anything.
 *
 * A subagent is suspect when its transcript (else its start) is older than
 * TMB_RUN_SILENT_MIN (default 30) minutes x clamp(load1/ncpu, 1, 4). A run of
 * another session also needs that session's main transcript past the threshold,
 * so a live lane is never flagged. A shell gets a verdict only when its command
 * parses as a `tail -f`/`tail -F` pipeline; silence alone is not death.
 *
 * The once-marker is a `liveness_finding_reported` audit row per kind and
 * finding id, shared by both gates.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { auditSql, dedupeGuard, dbWrite, nowIso } from './lib/audit.js';
import { dbPath, gateRead, GATE_READ_ERROR, sqlQuote } from './lib/db.js';
import { jqCompact } from './lib/jq.js';
import { pruneStaleMarkers } from './lib/persona.js';
import { pluginName, posixDirname, TMB_STATE_HOST_DIR } from './lib/project-env.js';
export const RUN_SILENT_ENV = 'TMB_RUN_SILENT_MIN';
export const DEFAULT_RUN_SILENT_MIN = 30;
const EVENT = 'liveness_finding_reported';
const MS_PER_MIN = 60_000;
const MAX_LOAD_FACTOR = 4;
const COMMAND_CHARS = 200;
const SYSTEM_ISSUE = '-1';
const SNAPSHOT_SUFFIX = '.liveness-snapshot.json';
const MARKER_INFIX = '.liveness-';
const UNBOUND_SPAWN = 'tool_use:';
const TASK_OUTPUT = /(?:^|\/)tasks\/([^/]+)\.output$/;
const SHELL_SYNTAX = ';&()<>`$*?~\\\n{}';
export function silentLimitMs(env, load1, ncpu) {
    const raw = env[RUN_SILENT_ENV] ?? '';
    const base = /^[0-9]+$/.test(raw) ? Number(raw) : DEFAULT_RUN_SILENT_MIN;
    const ratio = ncpu > 0 ? load1 / ncpu : 1;
    const factor = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 1), MAX_LOAD_FACTOR) : 1;
    return base * factor * MS_PER_MIN;
}
/** The words and `|` separators of a command, null when it holds any other shell syntax. */
function pipelineWords(command) {
    const text = command.replace(/\s2>(?:\/dev\/null|&1)(?=\s|\||$)/g, '');
    const words = [];
    let word = '';
    let inWord = false;
    let quote = '';
    const flush = () => {
        if (inWord)
            words.push(word);
        word = '';
        inWord = false;
    };
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (quote === "'") {
            if (c === "'")
                quote = '';
            else
                word += c;
        }
        else if (quote === '"') {
            if (c === '"')
                quote = '';
            else if (c === '`' || (c === '$' && /[\w{(@*#?!$-]/.test(text[i + 1] ?? '')))
                return null;
            else if (c === '\\') {
                i += 1;
                word += text[i] ?? '';
            }
            else
                word += c;
        }
        else if (c === "'" || c === '"') {
            quote = c;
            inWord = true;
        }
        else if (c === ' ' || c === '\t') {
            flush();
        }
        else if (c === '|') {
            flush();
            words.push('|');
        }
        else if (SHELL_SYNTAX.includes(c)) {
            return null;
        }
        else {
            word += c;
            inWord = true;
        }
    }
    if (quote !== '')
        return null;
    flush();
    const hasEmptyStage = words[0] === '|' || words[words.length - 1] === '|' || words.some((w, i) => w === '|' && words[i + 1] === '|');
    return hasEmptyStage ? null : words;
}
/**
 * The one file a `tail -f`/`tail -F` pipeline follows. Null for every other
 * command: an allowlist, so anything it cannot read gets no verdict.
 */
export function tailFollowTarget(command) {
    const words = pipelineWords(command);
    if (words === null || words[0] !== 'tail')
        return null;
    const end = words.indexOf('|');
    const args = words.slice(1, end < 0 ? undefined : end);
    let follows = false;
    let target = null;
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        const count = /^-([fFqv]*)[nc]([+-]?\d+)?$/.exec(arg);
        if (count) {
            if (/[fF]/.test(count[1]))
                follows = true;
            if (count[2] === undefined) {
                i += 1;
                if (!/^[+-]?\d+$/.test(args[i] ?? ''))
                    return null;
            }
        }
        else if (/^-[fFqv]+$/.test(arg)) {
            if (/[fF]/.test(arg))
                follows = true;
        }
        else if (arg.startsWith('-') || target !== null) {
            return null;
        }
        else {
            target = arg;
        }
    }
    return follows ? target : null;
}
function subagentTranscript(mainTranscript, agentId) {
    return `${mainTranscript.replace(/\.jsonl$/, '')}/subagents/agent-${agentId}.jsonl`;
}
function boundAgentId(run) {
    return run.spawnId === null || run.spawnId === '' || run.spawnId.startsWith(UNBOUND_SPAWN) ? null : run.spawnId;
}
/** A row with no session_id belongs to this session when this session holds its transcript. */
function isOwnRun(run, input) {
    if (run.sessionId !== null)
        return run.sessionId === input.sessionId;
    const agentId = boundAgentId(run);
    return agentId !== null && input.transcriptPath !== '' && input.mtimeMs(subagentTranscript(input.transcriptPath, agentId)) !== null;
}
function silentMs(lastMs, now) {
    return lastMs === null ? null : Math.max(0, now.getTime() - lastMs);
}
function isoMs(iso) {
    if (!iso)
        return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
}
function runFinding(run, input, limitMs) {
    const own = isOwnRun(run, input);
    const main = own ? input.transcriptPath : input.mainTranscripts.get(run.sessionId ?? '');
    if (main === undefined)
        return null;
    if (!own) {
        const mainSilent = silentMs(input.mtimeMs(main), input.now);
        if (mainSilent === null || mainSilent <= limitMs)
            return null;
    }
    const agentId = boundAgentId(run);
    const transcriptMs = agentId !== null && main !== '' ? input.mtimeMs(subagentTranscript(main, agentId)) : null;
    const silent = silentMs(transcriptMs ?? isoMs(run.startedAt), input.now);
    if (silent === null || silent <= limitMs)
        return null;
    return {
        kind: 'subagent',
        findingId: String(run.id),
        issueId: run.issueId,
        branchId: run.branchId,
        runId: run.id,
        taskId: run.taskId,
        agentType: run.agentType,
        agentId,
        shellId: null,
        command: null,
        silentMin: Math.floor(silent / MS_PER_MIN),
        reason: transcriptMs === null ? 'no transcript found, so this counts from its start' : 'its transcript has gone silent',
    };
}
function taskFinding(task, input, limitMs) {
    const transcriptMs = input.transcriptPath === '' ? null : input.mtimeMs(subagentTranscript(input.transcriptPath, task.id));
    const silent = silentMs(transcriptMs ?? isoMs(task.firstSeen), input.now);
    if (silent === null || silent <= limitMs)
        return null;
    return {
        kind: 'subagent',
        findingId: task.id,
        issueId: null,
        branchId: null,
        runId: null,
        taskId: null,
        agentType: null,
        agentId: task.id,
        shellId: null,
        command: null,
        silentMin: Math.floor(silent / MS_PER_MIN),
        reason: transcriptMs === null ? 'no transcript found, so this counts from when it was first seen' : 'its transcript has gone silent',
    };
}
function shellFinding(task, running, input, limitMs) {
    const target = tailFollowTarget(task.command ?? '');
    if (target === null)
        return null;
    const seenFor = silentMs(isoMs(task.firstSeen), input.now);
    if (seenFor === null || seenFor <= limitMs)
        return null;
    let silent = seenFor;
    let reason;
    const output = TASK_OUTPUT.exec(target);
    if (target === '/dev/null') {
        reason = 'it follows /dev/null, which never gets a line';
    }
    else if (output) {
        if (running.has(output[1]))
            return null;
        reason = `it follows the output of task ${output[1]}, which is no longer running`;
    }
    else {
        if (!target.startsWith('/'))
            return null;
        const fileSilent = silentMs(input.mtimeMs(target), input.now);
        if (fileSilent === null || fileSilent <= limitMs)
            return null;
        silent = fileSilent;
        reason = `the file it follows has gone silent: ${target}`;
    }
    return {
        kind: 'shell',
        findingId: task.id,
        issueId: null,
        branchId: null,
        runId: null,
        taskId: null,
        agentType: null,
        agentId: null,
        shellId: task.id,
        command: task.command ?? null,
        silentMin: Math.floor(silent / MS_PER_MIN),
        reason,
    };
}
export function probe(input) {
    const limitMs = silentLimitMs(input.env, input.load1, input.ncpu);
    const live = input.backgroundTasks.filter((t) => t.status === 'running');
    const running = new Set(live.map((t) => t.id));
    const runAgents = new Set(input.runs.map((r) => r.spawnId));
    const found = [
        ...input.runs.filter((r) => r.agentType !== 'bro').map((r) => runFinding(r, input, limitMs)),
        ...live.filter((t) => t.type === 'subagent' && !runAgents.has(t.id)).map((t) => taskFinding(t, input, limitMs)),
        ...live.filter((t) => t.type === 'shell').map((t) => shellFinding(t, running, input, limitMs)),
    ];
    return found.filter((f) => f !== null);
}
function regularFileMtimeMs(path) {
    try {
        const st = statSync(path);
        return st.isFile() ? st.mtimeMs : null;
    }
    catch {
        return null;
    }
}
/** Each named session's main transcript under ~/.claude/projects/*. */
function findMainTranscripts(sessionIds, env) {
    const found = new Map();
    if (sessionIds.length === 0 || !env.HOME)
        return found;
    const projects = `${env.HOME}/.claude/projects`;
    let folders;
    try {
        folders = readdirSync(projects);
    }
    catch {
        return found;
    }
    for (const folder of folders) {
        for (const id of sessionIds) {
            if (found.has(id))
                continue;
            const path = `${projects}/${folder}/${id}.jsonl`;
            if (regularFileMtimeMs(path) !== null)
                found.set(id, path);
        }
    }
    return found;
}
function openRuns(db, env) {
    const out = gateRead(db, `SELECT COALESCE(json_group_array(json_object(
         'id', r.id, 'task_id', r.task_id, 'issue_id', COALESCE(r.issue_id, t.issue_id), 'branch_id', t.branch_id,
         'agent_type', r.agent_type, 'spawn_id', r.spawn_id, 'session_id', r.session_id, 'started_at', r.started_at)), '[]')
       FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
      WHERE r.completed_at IS NULL AND r.agent_type <> 'bro';`, env);
    if (out === GATE_READ_ERROR || out === '')
        return null;
    return JSON.parse(out).map((r) => ({
        id: r.id,
        taskId: r.task_id,
        issueId: r.issue_id,
        branchId: r.branch_id,
        agentType: r.agent_type,
        spawnId: r.spawn_id,
        sessionId: r.session_id,
        startedAt: r.started_at,
    }));
}
function findingKey(kind, findingId) {
    return `${kind}:${findingId}`;
}
function reportedKeys(db, env) {
    const out = gateRead(db, `SELECT COALESCE(json_group_array(json_extract(content_json, '$.kind') || ':' || json_extract(content_json, '$.finding_id')), '[]')
       FROM audit WHERE event_type = 'liveness_finding_reported' AND json_valid(content_json);`, env);
    if (out === GATE_READ_ERROR || out === '')
        return null;
    return new Set(JSON.parse(out));
}
/** One probe of the live DB, load and files; null when the DB cannot be read. */
export function sweep(db, ctx, env) {
    const runs = openRuns(db, env);
    const reported = reportedKeys(db, env);
    if (runs === null || reported === null)
        return null;
    const others = [...new Set(runs.map((r) => r.sessionId).filter((s) => s !== null && s !== ctx.sessionId))];
    const input = {
        now: ctx.now,
        load1: loadavg()[0],
        ncpu: availableParallelism(),
        env,
        sessionId: ctx.sessionId,
        transcriptPath: ctx.transcriptPath,
        runs,
        backgroundTasks: ctx.tasks,
        mainTranscripts: findMainTranscripts(others, env),
        mtimeMs: regularFileMtimeMs,
    };
    return {
        watching: ctx.tasks.some((t) => t.status === 'running') || runs.some((r) => isOwnRun(r, input)),
        findings: probe(input).filter((f) => !reported.has(findingKey(f.kind, f.findingId))),
    };
}
/** Writes the once-markers; the findings actually claimed, or null when the write failed. */
export function claimLivenessFinding(db, findings, now, env, gate) {
    const statements = [];
    for (const f of findings) {
        const content = jqCompact({
            kind: f.kind,
            finding_id: f.findingId,
            run_id: f.runId,
            task_id: f.taskId,
            agent_type: f.agentType,
            agent_id: f.agentId,
            shell_id: f.shellId,
            command: f.command,
            silent_min: f.silentMin,
            reason: f.reason,
        });
        const guard = dedupeGuard(EVENT, content, ['$.kind', '$.finding_id'], { caller: gate });
        const row = auditSql({
            issueId: f.issueId === null ? SYSTEM_ISSUE : String(f.issueId),
            branchId: f.branchId ?? '',
            fromNode: `hook:${gate}`,
            eventType: EVENT,
            summary: `${f.kind} ${f.findingId} silent ${f.silentMin} min`,
            contentJson: content,
        }, guard.sql, { caller: gate, env, now: nowIso(now) });
        if (guard.code !== 0 || row.code !== 0)
            return null;
        statements.push(row.sql, `SELECT '${sqlQuote(findingKey(f.kind, f.findingId))}' WHERE changes() = 1;`);
    }
    const w = dbWrite(db, statements.join('\n'), { caller: gate, env });
    if (!w.ok)
        return null;
    const claimed = new Set(w.stdout.split('\n').map((l) => l.trim()));
    return findings.filter((f) => claimed.has(findingKey(f.kind, f.findingId)));
}
function oneLineCommand(command) {
    const flat = command.replace(/\s+/g, ' ').trim();
    return flat.length > COMMAND_CHARS ? `${flat.slice(0, COMMAND_CHARS)}...` : flat;
}
function findingLine(f) {
    if (f.kind === 'shell') {
        return `- shell ${f.shellId} (\`${oneLineCommand(f.command ?? '')}\`): silent ${f.silentMin} min; ${f.reason}.`;
    }
    const who = [
        f.runId === null ? null : `run ${f.runId}`,
        f.taskId === null ? null : `task ${f.taskId}`,
        f.agentType,
        f.agentId === null ? 'agent id unbound' : `agent ${f.agentId}`,
    ].filter((part) => part !== null);
    return `- ${who.join(', ')}: silent ${f.silentMin} min; ${f.reason}.`;
}
export function findingReport(findings) {
    return [
        'TMB liveness: these look dead or hung.',
        ...findings.map(findingLine),
        'This is a report only: nothing was killed, closed or failed. Verify each one, tell the Human once, and use task_recover for a dead swe run.',
    ].join('\n');
}
function isDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
/** Where a session's liveness files live, found with no DB read when the project holds its state dir. */
export function livenessSessionsDir(env) {
    const project = env.CLAUDE_PROJECT_DIR ? `${env.CLAUDE_PROJECT_DIR}/${TMB_STATE_HOST_DIR}/${pluginName(env)}` : '';
    if (project !== '' && isDir(project))
        return `${project}/sessions`;
    const db = dbPath(env);
    return db === null ? null : `${posixDirname(db)}/sessions`;
}
export function writeStateFile(sessionsDir, name, text) {
    try {
        mkdirSync(sessionsDir, { recursive: true });
        const tmp = `${sessionsDir}/${name}.${process.pid}.tmp`;
        writeFileSync(tmp, text);
        renameSync(tmp, `${sessionsDir}/${name}`);
    }
    catch {
        /* a state file never fails its hook */
    }
}
export function readStateFile(sessionsDir, name) {
    try {
        return readFileSync(`${sessionsDir}/${name}`, 'utf8');
    }
    catch {
        return null;
    }
}
function backgroundTasksOf(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((t) => {
        if (typeof t?.id !== 'string' || (t.type !== 'shell' && t.type !== 'subagent'))
            return [];
        const { status } = t;
        return [{
                id: t.id,
                type: t.type,
                status: typeof status === 'string' ? status : '',
                description: typeof t.description === 'string' ? t.description : '',
                ...(typeof t.command === 'string' ? { command: t.command } : {}),
                ...(typeof t.firstSeen === 'string' ? { firstSeen: t.firstSeen } : {}),
            }];
    });
}
export function readSnapshot(sessionsDir, sessionId) {
    const text = readStateFile(sessionsDir, `${sessionId}${SNAPSHOT_SUFFIX}`);
    if (text === null)
        return [];
    try {
        return backgroundTasksOf(JSON.parse(text));
    }
    catch {
        return [];
    }
}
/** Records this Stop's running background tasks, each keeping the firstSeen of the Stop that first listed it. */
export function writeSnapshot(sessionsDir, sessionId, payloadTasks, now) {
    const seen = new Map(readSnapshot(sessionsDir, sessionId).map((t) => [t.id, t.firstSeen]));
    const tasks = backgroundTasksOf(payloadTasks)
        .filter((t) => t.status === 'running')
        .map((t) => ({ ...t, firstSeen: seen.get(t.id) ?? now.toISOString() }));
    writeStateFile(sessionsDir, `${sessionId}${SNAPSHOT_SUFFIX}`, JSON.stringify(tasks));
    pruneStaleMarkers(sessionsDir, (name) => name.includes(MARKER_INFIX));
    return tasks;
}
//# sourceMappingURL=liveness-probe.js.map