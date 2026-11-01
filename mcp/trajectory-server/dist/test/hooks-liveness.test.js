/**
 * The liveness probe and its two callers (GH 2205). `probe` runs pure on
 * injected inputs. liveness-alert runs in process with a fixture clock.
 * liveness-sentinel runs as the `node dist/hooks.js liveness-sentinel`
 * subprocess Stop spawns, on a temp DB, with 600-minute-old fixtures so the
 * machine's real load factor (at most 4 x 30 min) cannot change a verdict.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { livenessAlert, makeLivenessAlert, THROTTLE_MS } from '../hooks/liveness-alert.js';
import { probe, readSnapshot, tailFollowTarget } from '../hooks/liveness-probe.js';
import { livenessSentinel, TOKEN_SUFFIX } from '../hooks/liveness-sentinel.js';
import { findGate, gateNames, ROUTER_GROUPS } from '../hooks/registry.js';
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = resolve(SERVER_ROOT, '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const HOOKS_JS = join(SERVER_ROOT, 'dist/hooks.js');
const NOW = new Date('2026-10-25T12:00:00.000Z');
const MINUTE = 60_000;
const OLD_MIN = 600;
const SID = 'sess-own';
const TRANSCRIPT = `/p/${SID}.jsonl`;
const agentTranscript = (id) => `/p/${SID}/subagents/agent-${id}.jsonl`;
const isoAgo = (minutes, from = NOW) => new Date(from.getTime() - minutes * MINUTE).toISOString();
function run(overrides = {}) {
    return { id: 1, taskId: 5, issueId: 9, branchId: 'fix/5-x', agentType: 'swe', spawnId: 'a1', sessionId: SID, startedAt: isoAgo(OLD_MIN), ...overrides };
}
function shell(command, id = 'b1', firstSeenMin = OLD_MIN) {
    return { id, type: 'shell', status: 'running', description: 'd', command, firstSeen: isoAgo(firstSeenMin) };
}
function input(overrides, files = {}) {
    return {
        now: NOW,
        load1: 1,
        ncpu: 8,
        env: {},
        sessionId: SID,
        transcriptPath: TRANSCRIPT,
        runs: [],
        backgroundTasks: [],
        mainTranscripts: new Map(),
        mtimeMs: (path) => (path in files ? NOW.getTime() - files[path] * MINUTE : null),
        ...overrides,
    };
}
describe('liveness probe: subagent rule', () => {
    it('reports a stale run, naming the run, task, agent and silent minutes', () => {
        const [finding, ...rest] = probe(input({ runs: [run()] }, { [agentTranscript('a1')]: 45 }));
        assert.deepEqual(rest, []);
        assert.equal(finding.kind, 'subagent');
        assert.equal(finding.findingId, '1');
        assert.equal(finding.runId, 1);
        assert.equal(finding.taskId, 5);
        assert.equal(finding.agentId, 'a1');
        assert.equal(finding.silentMin, 45);
    });
    it('does not report a run with a fresh transcript and an old started_at', () => {
        assert.deepEqual(probe(input({ runs: [run()] }, { [agentTranscript('a1')]: 1 })), []);
    });
    it('falls back to started_at when the run has no transcript', () => {
        assert.equal(probe(input({ runs: [run()] }))[0].silentMin, OLD_MIN);
        assert.deepEqual(probe(input({ runs: [run({ startedAt: isoAgo(5) })] })), []);
    });
    it('a transcript 40 minutes old is not reported at load factor 2 and is reported at factor 1', () => {
        const files = { [agentTranscript('a1')]: 40 };
        assert.deepEqual(probe(input({ runs: [run()], load1: 16, ncpu: 8 }, files)), []);
        assert.equal(probe(input({ runs: [run()], load1: 8, ncpu: 8 }, files)).length, 1);
    });
    it('clamps the load factor to 1..4 and reads TMB_RUN_SILENT_MIN', () => {
        const files = { [agentTranscript('a1')]: 121 };
        assert.equal(probe(input({ runs: [run()], load1: 800, ncpu: 8 }, files)).length, 1);
        const quiet = { [agentTranscript('a1')]: 29 };
        assert.deepEqual(probe(input({ runs: [run()], load1: 0, ncpu: 8 }, quiet)), []);
        assert.equal(probe(input({ runs: [run()], env: { TMB_RUN_SILENT_MIN: '10' } }, quiet)).length, 1);
    });
    it('a run of another session is suspect only when that session main transcript is past the threshold too', () => {
        const other = run({ sessionId: 'sess-other', spawnId: 'a2' });
        const main = '/q/sess-other.jsonl';
        const agent = '/q/sess-other/subagents/agent-a2.jsonl';
        const mainTranscripts = new Map([['sess-other', main]]);
        assert.deepEqual(probe(input({ runs: [other], mainTranscripts }, { [main]: 2, [agent]: 90 })), []);
        assert.equal(probe(input({ runs: [other], mainTranscripts }, { [main]: 90, [agent]: 90 })).length, 1);
        assert.deepEqual(probe(input({ runs: [other] }, { [main]: 90, [agent]: 90 })), [], 'no main transcript found, no verdict');
    });
    it('a run with no session_id gets a verdict only when this session holds its transcript', () => {
        const unknown = run({ sessionId: null });
        assert.deepEqual(probe(input({ runs: [unknown] })), []);
        assert.equal(probe(input({ runs: [unknown] }, { [agentTranscript('a1')]: 45 })).length, 1);
    });
    it('bro is never suspect', () => {
        assert.deepEqual(probe(input({ runs: [run({ agentType: 'bro' })] })), []);
    });
    it('a type:subagent task counts unless a run row already covers it', () => {
        const task = { id: 'a9', type: 'subagent', status: 'running', description: 'd', firstSeen: isoAgo(OLD_MIN) };
        const [finding] = probe(input({ backgroundTasks: [task] }, { [agentTranscript('a9')]: 50 }));
        assert.equal(finding.agentId, 'a9');
        assert.equal(finding.findingId, 'a9');
        assert.equal(finding.silentMin, 50);
        assert.deepEqual(probe(input({ backgroundTasks: [task] }, { [agentTranscript('a9')]: 2 })), []);
        assert.equal(probe(input({ backgroundTasks: [task], runs: [run({ spawnId: 'a9' })] })).length, 1, 'one finding, the run');
        assert.deepEqual(probe(input({ backgroundTasks: [{ ...task, status: 'completed' }] })), []);
    });
});
describe('liveness probe: shell rule', () => {
    it('recognises only tail -f and tail -F pipelines', () => {
        for (const [command, target] of [
            ['tail -f /x/log', '/x/log'],
            ['tail -F /x/log', '/x/log'],
            ['tail -fn0 /x/log', '/x/log'],
            ['tail -n 5 -f /x/log', '/x/log'],
            ['tail -n5 -F "/x/my log"', '/x/my log'],
            ['tail -f /x/log 2>/dev/null', '/x/log'],
            ['tail -f /x/log | grep -m1 DONE', '/x/log'],
            ['tail -F /x/log | grep -m1 "DONE$"', '/x/log'],
            ["tail -f /x/log | grep -m1 'a|b;c'", '/x/log'],
        ])
            assert.equal(tailFollowTarget(command), target, command);
        for (const command of [
            'tail /x/log',
            'tail -n 5 /x/log',
            'cat /x/log',
            'npm test',
            'sleep 600',
            'tail -f',
            'tail -f /a /b',
            'tail --pid=1 -f /x/log',
            'tail -f /x/log; npm test',
            'npm test && tail -f /x/log',
            'tail -f /x/log & npm test',
            'tail -f $LOG',
            'tail -f "$LOG"',
            'tail -f "$(pick)"',
            'tail -f /x/*.log',
            'tail -f ~/log',
            'tail -f /x/log |',
            'tail -f /x/log > /y',
            'cat /x/log | tail -f',
            '(tail -f /x/log)',
            'tail -f "/x/log',
        ])
            assert.equal(tailFollowTarget(command), null, command);
    });
    it('a non-tail shell with a silent output is never reported', () => {
        for (const command of ['npm test > /x/out', 'sleep 9999', 'tail /x/out', 'grep -f /x/out y']) {
            assert.deepEqual(probe(input({ backgroundTasks: [shell(command)] }, { '/x/out': OLD_MIN })), [], command);
        }
        assert.deepEqual(probe(input({ backgroundTasks: [{ ...shell('x'), command: undefined }] })), []);
    });
    it('a watcher on a live task is not reported, even with a silent output', () => {
        const live = shell('npm test', 'b2');
        const output = '/s/tasks/b2.output';
        assert.deepEqual(probe(input({ backgroundTasks: [shell(`tail -f ${output}`), live] }, { [output]: OLD_MIN })), []);
    });
    it('a watcher on a task no longer running is hung', () => {
        const [finding, ...rest] = probe(input({ backgroundTasks: [shell('tail -f /s/tasks/gone.output | grep -m1 DONE')] }));
        assert.deepEqual(rest, []);
        assert.equal(finding.kind, 'shell');
        assert.equal(finding.shellId, 'b1');
        assert.equal(finding.command, 'tail -f /s/tasks/gone.output | grep -m1 DONE');
        assert.equal(finding.silentMin, OLD_MIN);
        assert.match(finding.reason, /task gone/);
    });
    it('a watcher on /dev/null is hung once first seen past the threshold', () => {
        assert.equal(probe(input({ backgroundTasks: [shell('tail -f /dev/null')] })).length, 1);
        assert.deepEqual(probe(input({ backgroundTasks: [shell('tail -f /dev/null', 'b1', 10)] })), []);
    });
    it('a plain file needs silence past the threshold, an absolute path and an existing file', () => {
        const silent = shell('tail -F /x/log');
        assert.equal(probe(input({ backgroundTasks: [silent] }, { '/x/log': 45 }))[0].silentMin, 45);
        assert.deepEqual(probe(input({ backgroundTasks: [silent] }, { '/x/log': 2 })), []);
        assert.deepEqual(probe(input({ backgroundTasks: [silent] })), [], 'absent file');
        assert.deepEqual(probe(input({ backgroundTasks: [shell('tail -f log')] }, { log: 45 })), [], 'relative path');
    });
    it('a shell not first seen past the threshold gets no verdict, nor one with no firstSeen', () => {
        assert.deepEqual(probe(input({ backgroundTasks: [shell('tail -F /x/log', 'b1', 5)] }, { '/x/log': 45 })), []);
        assert.deepEqual(probe(input({ backgroundTasks: [{ ...shell('tail -f /dev/null'), firstSeen: undefined }] })), []);
    });
});
let sandbox;
let seq = 0;
function fixture() {
    seq += 1;
    const root = join(sandbox, `case-${seq}`);
    const db = join(root, '.claude/tmb/trajectory.db');
    const sessions = join(dirname(db), 'sessions');
    mkdirSync(dirname(db), { recursive: true });
    const d = new DatabaseSync(db);
    d.exec(SCHEMA);
    const t0 = isoAgo(5000, new Date());
    d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(t0, t0);
    d.prepare("INSERT INTO tasks (id, issue_id, branch_id, description, status, created_at, updated_at) VALUES (5, 9, 'fix/5-x', 'd', 'running', ?, ?)").run(t0, t0);
    d.close();
    const withDb = (fn) => {
        const w = new DatabaseSync(db);
        try {
            return fn(w);
        }
        finally {
            w.close();
        }
    };
    return {
        root,
        db,
        sessions,
        env: { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db },
        addRun: (id, sessionId, startedAt, spawnId = `agent${id}`) => withDb((w) => w.prepare("INSERT INTO agent_runs (id, task_id, issue_id, agent_type, started_at, spawn_id, session_id) VALUES (?, 5, 9, 'swe', ?, ?, ?)").run(id, startedAt, spawnId, sessionId)),
        findingRows: (where = '1') => withDb((w) => w.prepare(`SELECT COUNT(*) AS n FROM audit WHERE event_type = 'liveness_finding_reported' AND ${where}`).get().n),
        exec: (sql) => withDb((w) => w.exec(sql)),
        token: () => {
            const path = join(sessions, `${SID}${TOKEN_SUFFIX}`);
            return existsSync(path) ? readFileSync(path, 'utf8') : null;
        },
        snapshot: (tasks) => {
            mkdirSync(sessions, { recursive: true });
            writeFileSync(join(sessions, `${SID}.liveness-snapshot.json`), JSON.stringify(tasks));
        },
    };
}
function start(payload, env) {
    const began = Date.now();
    const child = spawn(process.execPath, ['--experimental-sqlite', '--no-warnings', HOOKS_JS, 'liveness-sentinel'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b) => (stdout += String(b)));
    child.stderr?.on('data', (b) => (stderr += String(b)));
    child.stdin?.end(JSON.stringify(payload));
    const exit = new Promise((done) => child.on('close', (code) => done({ code, stdout, stderr, ms: Date.now() - began })));
    return { child, exit };
}
async function until(what, holds, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!holds()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await sleep(25);
    }
}
async function exitedWithin(exit, ms = 20_000) {
    const timer = sleep(ms, null);
    const done = await Promise.race([exit, timer]);
    assert.notEqual(done, null, `no exit within ${ms} ms`);
    return done;
}
const stop = (tasks = []) => ({
    hook_event_name: 'Stop',
    session_id: SID,
    transcript_path: join(sandbox, 'absent', `${SID}.jsonl`),
    background_tasks: tasks,
});
const attended = (f, extra = {}) => ({ ...f.env, CLAUDE_CODE_SESSION_ATTENDED: '1', TMB_LIVENESS_POLL_S: '1', ...extra });
const hungTail = { id: 'bhung', type: 'shell', status: 'running', description: 'watch', command: 'tail -f /dev/null' };
const longAgo = () => isoAgo(OLD_MIN, new Date());
describe('liveness gates', () => {
    before(() => {
        sandbox = mkdtempSync(join(tmpdir(), 'tmb-liveness-'));
    });
    after(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });
    describe('liveness-sentinel', () => {
        it('is registered, and its Stop entry is a direct asyncRewake with no dispatch.sh and no onFailure', () => {
            assert.equal(findGate('liveness-sentinel'), livenessSentinel);
            assert.ok(gateNames().includes('liveness-sentinel'));
            const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
            const entry = hooks.Stop.flatMap((g) => g.hooks).find((h) => String(h.command).endsWith('liveness-sentinel'));
            assert.deepEqual(entry, {
                type: 'command',
                command: 'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" liveness-sentinel',
                asyncRewake: true,
                timeout: 86400,
            });
        });
        it('unattended exits 0 under 2 s with no wait, after writing the snapshot; firstSeen stays across Stops', async () => {
            const f = fixture();
            f.addRun(1, SID, longAgo());
            for (const env of [f.env, { ...f.env, CLAUDE_CODE_SESSION_ATTENDED: '0' }]) {
                const { code, stderr, ms } = await start(stop([hungTail]), env).exit;
                assert.equal(code, 0);
                assert.equal(stderr, '');
                assert.ok(ms < 2000, `${ms} ms`);
            }
            assert.equal(f.token(), null, 'no generation token');
            assert.equal(f.findingRows(), 0);
            const [first] = readSnapshot(f.sessions, SID);
            assert.equal(first.command, 'tail -f /dev/null');
            const kept = isoAgo(77, new Date());
            f.snapshot([{ ...first, firstSeen: kept }]);
            await start(stop([hungTail, { id: 'bnew', type: 'shell', status: 'running', description: 'd', command: 'npm test' }, { id: 'bdone', type: 'shell', status: 'completed', description: 'd' }]), f.env).exit;
            const after = readSnapshot(f.sessions, SID);
            assert.deepEqual(after.map((t) => t.id), ['bhung', 'bnew']);
            assert.equal(after[0].firstSeen, kept);
            assert.notEqual(after[1].firstSeen, kept);
        });
        it('a stale run and a hung watcher exit 2 naming both, one claim each; a second instance gives no report', async () => {
            const f = fixture();
            f.addRun(1, SID, longAgo());
            f.snapshot([{ ...hungTail, firstSeen: longAgo() }]);
            const woke = await exitedWithin(start(stop([hungTail]), attended(f)).exit);
            assert.equal(woke.code, 2);
            assert.equal(woke.stdout, '');
            assert.match(woke.stderr, /run 1, task 5, swe, agent agent1: silent 600 min/);
            assert.match(woke.stderr, /shell bhung \(`tail -f \/dev\/null`\): silent 600 min/);
            assert.match(woke.stderr, /report only/);
            assert.equal(f.findingRows(), 2);
            assert.equal(f.findingRows("json_extract(content_json, '$.kind') = 'subagent' AND json_extract(content_json, '$.finding_id') = '1'"), 1);
            assert.equal(f.findingRows("json_extract(content_json, '$.kind') = 'shell' AND json_extract(content_json, '$.finding_id') = 'bhung' AND from_node = 'hook:liveness-sentinel'"), 1);
            const firstToken = f.token();
            const second = start(stop([hungTail]), attended(f));
            await until('the second token', () => f.token() !== firstToken);
            await sleep(1500);
            assert.equal(second.child.exitCode, null, 'still polling, no wake');
            writeFileSync(join(f.sessions, `${SID}${TOKEN_SUFFIX}`), 'newer');
            const quiet = await exitedWithin(second.exit);
            assert.equal(quiet.code, 0);
            assert.equal(quiet.stderr, '');
            assert.equal(f.findingRows(), 2);
        });
        it('a newer instance token ends the older instance', async () => {
            const f = fixture();
            f.addRun(1, SID, new Date().toISOString());
            const older = start(stop(), attended(f));
            await until('the first token', () => f.token() !== null);
            const firstToken = f.token();
            const newer = start(stop(), attended(f));
            await until('the second token', () => f.token() !== firstToken);
            assert.equal((await exitedWithin(older.exit)).code, 0);
            writeFileSync(join(f.sessions, `${SID}${TOKEN_SUFFIX}`), 'newer');
            assert.equal((await exitedWithin(newer.exit)).code, 0);
        });
        it('exits 0 when its parent pid changes', async () => {
            const f = fixture();
            f.addRun(1, SID, new Date().toISOString());
            const input = join(f.root, 'payload.json');
            writeFileSync(input, JSON.stringify(stop()));
            const token = join(f.sessions, `${SID}${TOKEN_SUFFIX}`);
            const script = `"${process.execPath}" --experimental-sqlite --no-warnings "${HOOKS_JS}" liveness-sentinel < "${input}" & while [ ! -f "${token}" ]; do sleep 0.05; done`;
            const shellParent = spawn('sh', ['-c', script], { env: attended(f), stdio: ['ignore', 'pipe', 'ignore'] });
            const closed = new Promise((done) => shellParent.stdout.on('close', () => done(null)));
            const result = await Promise.race([closed, sleep(20_000, 'still running')]);
            assert.equal(result, null, 'the orphaned sentinel exits and releases the inherited stdout');
        });
        it('exits 0 at once with nothing of its session to watch', async () => {
            const f = fixture();
            f.addRun(1, 'sess-other', longAgo());
            const { code, stderr } = await exitedWithin(start(stop(), attended(f, { TMB_LIVENESS_POLL_S: '600' })).exit);
            assert.equal(code, 0);
            assert.equal(stderr, '');
        });
        it('when no claim succeeds it exits 0 without waking', async () => {
            const f = fixture();
            f.addRun(1, SID, longAgo());
            f.exec("CREATE TRIGGER no_claim BEFORE INSERT ON audit WHEN NEW.event_type = 'liveness_finding_reported' BEGIN SELECT RAISE(ABORT, 'no claim'); END;");
            const { code, stderr } = await exitedWithin(start(stop(), attended(f)).exit);
            assert.equal(code, 0);
            assert.doesNotMatch(stderr, /TMB liveness/);
        });
        it('takes a silent transcript from the Stop payload path', async () => {
            const f = fixture();
            const main = join(f.root, `home/.claude/projects/p/${SID}.jsonl`);
            const agent = join(f.root, `home/.claude/projects/p/${SID}/subagents/agent-agent1.jsonl`);
            mkdirSync(dirname(agent), { recursive: true });
            writeFileSync(main, '');
            writeFileSync(agent, '');
            f.addRun(1, SID, longAgo());
            const stale = new Date(Date.now() - 500 * MINUTE);
            utimesSync(agent, stale, stale);
            const woke = await exitedWithin(start({ ...stop(), transcript_path: main }, attended(f)).exit);
            assert.equal(woke.code, 2);
            assert.match(woke.stderr, /silent 500 min; its transcript has gone silent/);
        });
    });
    describe('liveness-alert', () => {
        const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'hi' });
        const context = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;
        it('is registered on UserPromptSubmit, and in the router group holding task-overrun-alert', () => {
            assert.equal(findGate('liveness-alert'), livenessAlert);
            for (const event of ['UserPromptSubmit', 'PostToolUse']) {
                const holders = ROUTER_GROUPS.filter((g) => g.event === event && g.gates.some((x) => x.name === 'task-overrun-alert'));
                assert.ok(holders.length > 0, event);
                for (const group of holders)
                    assert.ok(group.gates.some((x) => x.name === 'liveness-alert'), `${event}:${group.matcher}`);
            }
        });
        it('reports a dead run and a hung watcher to bro, as a report only, and writes one row per finding', () => {
            const f = fixture();
            f.addRun(1, SID, isoAgo(OLD_MIN));
            f.snapshot([{ ...hungTail, firstSeen: isoAgo(OLD_MIN) }]);
            const result = makeLivenessAlert(() => NOW)(prompt, f.env);
            assert.equal(result.code, 0);
            const out = JSON.parse(result.stdout);
            assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
            const text = context(result.stdout);
            assert.match(text, /run 1, task 5, swe, agent agent1: silent 600 min; no transcript found/);
            assert.match(text, /shell bhung \(`tail -f \/dev\/null`\): silent 600 min; it follows \/dev\/null/);
            assert.match(text, /report only: nothing was killed, closed or failed/);
            assert.match(text, /Verify each one, tell the Human once, and use task_recover for a dead swe run/);
            assert.equal(f.findingRows("json_extract(content_json, '$.finding_id') = '1' AND from_node = 'hook:liveness-alert'"), 1);
            assert.equal(f.findingRows(), 2);
        });
        it('carries the PostToolUse event name', () => {
            const f = fixture();
            f.addRun(1, SID, isoAgo(OLD_MIN));
            const post = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SID, tool_name: 'mcp__plugin_tmb_trajectory-server__task_list' });
            assert.equal(JSON.parse(makeLivenessAlert(() => NOW)(post, f.env).stdout).hookSpecificOutput.hookEventName, 'PostToolUse');
        });
        it('a shell finding that belongs to no run lands on the system issue', () => {
            const f = fixture();
            f.snapshot([{ ...hungTail, firstSeen: isoAgo(OLD_MIN) }]);
            assert.match(context(makeLivenessAlert(() => NOW)(prompt, f.env).stdout), /shell bhung/);
            assert.equal(f.findingRows('issue_id = -1'), 1);
        });
        it('probes once per 5 minutes per session: a throttled call sees nothing new, a later one does', () => {
            const f = fixture();
            const at = (ms) => makeLivenessAlert(() => new Date(NOW.getTime() + ms));
            assert.equal(at(0)(prompt, f.env).stdout, '');
            f.addRun(1, SID, isoAgo(OLD_MIN));
            assert.equal(at(THROTTLE_MS - 1)(prompt, f.env).stdout, '');
            assert.equal(f.findingRows(), 0, 'throttled: no probe');
            const otherSession = prompt.replace(SID, 'sess-b');
            assert.equal(at(THROTTLE_MS - 1)(otherSession, f.env).stdout, '', 'the other session probed but this run is not its own');
            assert.match(context(at(THROTTLE_MS)(prompt, f.env).stdout), /run 1/);
        });
        it('the throttle read comes before any DB read: an unreadable DB is not touched while throttled', () => {
            const f = fixture();
            const gate = makeLivenessAlert(() => NOW);
            assert.equal(gate(prompt, f.env).stdout, '');
            const stamp = readFileSync(join(f.sessions, `${SID}.liveness-throttle`), 'utf8');
            assert.equal(stamp, String(NOW.getTime()));
            rmSync(f.db);
            assert.deepEqual(gate(prompt, f.env), { stdout: '', code: 0 });
            assert.equal(existsSync(f.db), false);
        });
        it('reports each finding once across both callers', async () => {
            const f = fixture();
            f.addRun(1, SID, longAgo());
            const woke = await exitedWithin(start(stop(), attended(f)).exit);
            assert.equal(woke.code, 2);
            assert.deepEqual(makeLivenessAlert()(prompt, f.env), { stdout: '', code: 0 });
            assert.equal(f.findingRows(), 1);
            const g = fixture();
            g.addRun(1, SID, longAgo());
            assert.match(context(makeLivenessAlert()(prompt, g.env).stdout), /run 1/);
            const later = makeLivenessAlert(() => new Date(Date.now() + THROTTLE_MS + MINUTE));
            assert.deepEqual(later(prompt, g.env), { stdout: '', code: 0 }, 'a second probe finds it claimed');
            assert.equal(g.findingRows(), 1);
            const firstToken = g.token();
            const sentinel = start(stop(), attended(g));
            await until('the sentinel token', () => g.token() !== firstToken);
            await sleep(1500);
            assert.equal(sentinel.child.exitCode, null, 'the sentinel does not wake for it');
            writeFileSync(join(g.sessions, `${SID}${TOKEN_SUFFIX}`), 'newer');
            assert.equal((await exitedWithin(sentinel.exit)).stderr, '');
        });
        it('is silent for a non-bro caller, with no row', () => {
            const f = fixture();
            f.addRun(1, SID, isoAgo(OLD_MIN));
            const swe = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: SID, agent_type: 'swe', tool_name: 'mcp__plugin_tmb_trajectory-server__task_brief' });
            assert.deepEqual(makeLivenessAlert(() => NOW)(swe, f.env), { stdout: '', code: 0 });
            assert.equal(f.findingRows(), 0);
        });
        it('is silent with no DB, and when a claim cannot be written', () => {
            const none = { PATH: process.env.PATH, HOME: join(sandbox, 'nohome'), TRAJECTORY_DB_PATH: join(sandbox, 'nodb/absent.db'), CLAUDE_PROJECT_DIR: join(sandbox, 'noproj') };
            assert.deepEqual(makeLivenessAlert(() => NOW)(prompt, none), { stdout: '', code: 0 });
            const f = fixture();
            f.addRun(1, SID, isoAgo(OLD_MIN));
            f.exec("CREATE TRIGGER no_claim BEFORE INSERT ON audit WHEN NEW.event_type = 'liveness_finding_reported' BEGIN SELECT RAISE(ABORT, 'no claim'); END;");
            assert.deepEqual(makeLivenessAlert(() => NOW)(prompt, f.env), { stdout: '', code: 0 });
        });
    });
});
//# sourceMappingURL=hooks-liveness.test.js.map