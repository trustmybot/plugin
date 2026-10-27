/**
 * Unit tests of the TypeScript task-close gates (GH 1692): swe-atomic-close
 * and post-task-close-rescan. They cover the transcript reduction the .sh ran
 * through `jq -rsc` (message grouping, the resume window, the dominant model,
 * zeros wherever jq stopped on an error), the entry log's key list, the
 * decision matrix run in-process on a PATH with neither jq nor the sqlite3 CLI
 * (decision 703), and the rescan's launch through an injected spawner: a
 * detached child with its stdio ignored and unref'd, started only for
 * bro_atomic_close and never under TMB_SKIP_AUTO_RESCAN=1.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findGate, gateNames } from '../hooks/registry.js';
import { entryKeys, sweAtomicClose, transcriptStats, transcriptStatsOf } from '../hooks/swe-atomic-close.js';
import { launchDetached, rescan } from '../hooks/post-task-close-rescan.js';
import { buildCloseSandbox } from './hooks-task-close-parity.suite.js';
import { noCmdPath } from './hooks-swe-run-parity.suite.js';
const ALLOWED = { stdout: '', code: 0 };
const jsonl = (...entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');
const usage = (input, output, read = 0, created = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: created,
});
describe('swe-atomic-close and post-task-close-rescan are registered gates', () => {
    it('both resolve by name and are listed', () => {
        for (const name of ['swe-atomic-close', 'post-task-close-rescan']) {
            assert.equal(typeof findGate(name), 'function', name);
            assert.ok(gateNames().includes(name), name);
        }
    });
});
describe('transcriptStatsOf: the .sh jq reduction', () => {
    it('groups lines by message id, the last usage of a group winning, and counts every tool_use block', () => {
        const text = jsonl({ timestamp: '2026-10-01T10:00:00Z', message: { id: 'm1', model: 'claude-opus', usage: usage(10, 5, 100, 7), content: [{ type: 'tool_use' }, { type: 'text' }] } }, { timestamp: '2026-10-01T10:00:01.5Z', message: { id: 'm1', model: 'claude-opus', usage: usage(11, 6, 100, 7), content: [{ type: 'tool_use' }] } }, { timestamp: '2026-10-01T10:00:09Z', message: { id: 'm2', model: 'claude-haiku', usage: usage(1000, 1), content: 'hi' } });
        assert.equal(transcriptStatsOf(text), '1011|7|2|9000|100|7|2026-10-01T10:00:00.000Z|claude-haiku');
    });
    it('keeps only the entries at or after the resume instant', () => {
        const text = jsonl({ timestamp: '2026-10-01T10:00:00Z', message: { id: 'a', model: 'm', usage: usage(5, 5) } }, { timestamp: '2026-10-01T10:00:02Z', message: { id: 'b', model: 'm', usage: usage(1, 2) } });
        assert.equal(transcriptStatsOf(text, '2026-10-01T10:00:01.000Z'), '1|2|0|0|0|0|2026-10-01T10:00:02.000Z|m');
    });
    it('breaks a model tie by name and strips <synthetic> to no model', () => {
        const tie = jsonl({ message: { id: 'a', model: 'mB', usage: usage(5, 5) } }, { message: { id: 'b', model: 'mA', usage: usage(5, 5) } });
        assert.equal(transcriptStatsOf(tie), '10|10|0|0|0|0||mA');
        assert.equal(transcriptStatsOf(jsonl({ message: { id: 's', model: '<synthetic>', usage: usage(1, 1) } })), '1|1|0|0|0|0||');
    });
    it('prints zeros wherever jq stops on an error: a bad line, a non-object entry, a string message or a bad month', () => {
        for (const text of ['{bad\n', jsonl(5), jsonl({ message: 'x' }), jsonl({ timestamp: '2026-13-01T10:00:00Z' }), ''])
            assert.equal(transcriptStatsOf(text), '0|0|0|0|0|0||', JSON.stringify(text));
    });
    it('prints zeros for a missing transcript', () => {
        assert.equal(transcriptStats('/nonexistent/transcript.jsonl'), '0|0|0|0|0|0||');
    });
});
describe('entryKeys: the entry log key list', () => {
    it('lists the sorted unique dotted paths of non-null, non-false scalars', () => {
        assert.equal(entryKeys({ b: 1, a: { c: 'x', d: null, e: false }, f: [true, 2] }), '["a.c","b","f.0","f.1"]');
    });
});
describe('swe-atomic-close in-process, with neither jq nor the sqlite3 CLI on PATH (decision 703)', () => {
    let base;
    let s;
    let env;
    const db = () => new DatabaseSync(join(s, 'project/.claude/tmb/trajectory.db'), { readOnly: true });
    const stop = (task, agentType = 'swe') => JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: agentType, agent_id: `agent-${task}`, agent_transcript_path: join(s, 'transcripts', `${task}.jsonl`) });
    before(() => {
        base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-task-close-unit-')));
        s = join(base, 'sandbox');
        const path = noCmdPath(join(base, 'nosqlite'), 'sqlite3', noCmdPath(join(base, 'nojq'), 'jq', process.env.PATH ?? ''));
        env = {
            PATH: path,
            HOME: join(s, 'home'),
            CLAUDE_PROJECT_DIR: join(s, 'project'),
            TRAJECTORY_DB_PATH: join(s, 'project/.claude/tmb/trajectory.db'),
            LC_ALL: 'C',
        };
    });
    before(() => {
        buildCloseSandbox(s);
        cpSync(s, join(base, 'template'), { recursive: true });
    });
    beforeEach(() => {
        rmSync(s, { recursive: true, force: true });
        cpSync(join(base, 'template'), s, { recursive: true });
    });
    after(() => rmSync(base, { recursive: true, force: true }));
    it('auto-completes a running task whose worktree carries a commit', () => {
        assert.deepEqual(sweAtomicClose(stop('30'), { ...env }), ALLOWED);
        const d = db();
        try {
            const task = d.prepare('SELECT status, commit_sha FROM tasks WHERE id = 30').get();
            assert.equal(task.status, 'completed');
            assert.match(task.commit_sha, /^[0-9a-f]{40}$/);
            const audit = d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'swe_atomic_close_auto_completed'").get();
            assert.equal(audit.n, 1);
            const run = d.prepare("SELECT tokens_in, tokens_out, model, effort, exit_reason FROM agent_runs WHERE spawn_id = 'agent-30'").get();
            assert.deepEqual({ ...run }, { tokens_in: 110, tokens_out: 50, model: 'claude-opus-5-5', effort: 'high', exit_reason: 'completed' });
        }
        finally {
            d.close();
        }
    });
    it('warns bro when a running task stopped without commits', () => {
        const r = sweAtomicClose(stop('32'), { ...env });
        assert.match(r.stdout, /"hookEventName":"SubagentStop".*stopped without committing in worktree/);
    });
    it('names a hook block after the run', () => {
        const r = sweAtomicClose(stop('37'), { ...env });
        assert.match(r.stdout, /ended on a hook block with no completion report \(\\"PreToolUse:Bash hook error: BLOCKED: policy second line\\"\)/);
    });
    it('meters a code-reviewer stop at reviewer_effort and leaves the task alone', () => {
        assert.deepEqual(sweAtomicClose(stop('43', 'code-reviewer'), { ...env }), ALLOWED);
        const d = db();
        try {
            const run = d.prepare("SELECT effort, tokens_in, usage_source, completed_at IS NOT NULL AS closed FROM agent_runs WHERE spawn_id = 'agent-43'").get();
            assert.deepEqual({ ...run }, { effort: 'low', tokens_in: 110, usage_source: 'subagent_stop', closed: 1 });
            assert.deepEqual({ ...d.prepare('SELECT status FROM tasks WHERE id = 43').get() }, { status: 'completed' });
        }
        finally {
            d.close();
        }
    });
    it('records an unbound swe spawn as agent_runs_capture_skipped and ignores any other subagent', () => {
        assert.deepEqual(sweAtomicClose(stop('unbound'), { ...env }), ALLOWED);
        assert.deepEqual(sweAtomicClose(stop('30', 'consultant'), { ...env }), ALLOWED);
        const d = db();
        try {
            assert.deepEqual({ ...d.prepare("SELECT COUNT(*) AS n FROM audit WHERE event_type = 'agent_runs_capture_skipped'").get() }, { n: 1 });
            assert.deepEqual({ ...d.prepare('SELECT status FROM tasks WHERE id = 30').get() }, { status: 'running' });
        }
        finally {
            d.close();
        }
    });
});
function fakeSpawner(launches) {
    return (command, args, options) => {
        const launch = { command, args, options, unrefs: 0, errorListeners: 0 };
        launches.push(launch);
        const child = {
            on: () => {
                launch.errorListeners += 1;
                return child;
            },
            unref: () => {
                launch.unrefs += 1;
            },
        };
        return child;
    };
}
describe('post-task-close-rescan: the launch seam', () => {
    const CLOSE = JSON.stringify({ tool_name: 'mcp__plugin_tmb_trajectory-server__bro_atomic_close' });
    let root;
    let env;
    let invoker;
    let db;
    before(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-rescan-unit-')));
        invoker = join(root, 'plugin/scripts/maintenance/run-scan.mjs');
        mkdirSync(join(root, 'plugin/scripts/maintenance'), { recursive: true });
        writeFileSync(invoker, '');
        db = join(root, 'project/.claude/tmb/trajectory.db');
        mkdirSync(join(root, 'project/.claude/tmb'), { recursive: true });
        new DatabaseSync(db).close();
        env = { PATH: process.env.PATH, HOME: root, CLAUDE_PROJECT_DIR: join(root, 'project'), TRAJECTORY_DB_PATH: db };
    });
    after(() => rmSync(root, { recursive: true, force: true }));
    it('starts the invoker detached, stdio ignored and unref\'d, with the resolved DB, and returns without waiting', () => {
        const launches = [];
        assert.deepEqual(rescan(CLOSE, { ...env }, fakeSpawner(launches), join(root, 'plugin')), ALLOWED);
        assert.equal(launches.length, 1);
        const [l] = launches;
        assert.equal(l.command, process.execPath);
        assert.deepEqual(l.args, ['--experimental-sqlite', invoker]);
        assert.equal(l.options.detached, true);
        assert.equal(l.options.stdio, 'ignore');
        assert.equal(l.options.env?.TRAJECTORY_DB_PATH, db);
        assert.equal(l.unrefs, 1);
        assert.equal(l.errorListeners, 1);
    });
    it('matches any channel of the close tool and nothing else', () => {
        const launches = [];
        const spawner = fakeSpawner(launches);
        const plugin = join(root, 'plugin');
        for (const tool of ['mcp__plugin_tmb-dev_trajectory-server__bro_atomic_close', 'mcp__x\ny_trajectory-server__bro_atomic_close'])
            rescan(JSON.stringify({ tool_name: tool }), { ...env }, spawner, plugin);
        for (const tool of ['mcp__plugin_tmb_trajectory-server__task_get', 'bro_atomic_close', 'mcp__plugin_tmb_trajectory-server__bro_atomic_close_v2'])
            rescan(JSON.stringify({ tool_name: tool }), { ...env }, spawner, plugin);
        rescan('{"tool_name": ', { ...env }, spawner, plugin);
        assert.equal(launches.length, 2);
    });
    it('starts nothing under TMB_SKIP_AUTO_RESCAN=1, without an invoker or without a DB', () => {
        const launches = [];
        const spawner = fakeSpawner(launches);
        rescan(CLOSE, { ...env, TMB_SKIP_AUTO_RESCAN: '1' }, spawner, join(root, 'plugin'));
        rescan(CLOSE, { ...env }, spawner, join(root, 'no-plugin'));
        rescan(CLOSE, { ...env }, spawner, '');
        rescan(CLOSE, { PATH: process.env.PATH, HOME: root, CLAUDE_PROJECT_DIR: join(root, 'nowhere') }, spawner, join(root, 'plugin'));
        assert.equal(launches.length, 0);
    });
    it('a spawner that throws leaves the close allowed', () => {
        const throwing = () => {
            throw new Error('EAGAIN');
        };
        assert.deepEqual(rescan(CLOSE, { ...env }, throwing, join(root, 'plugin')), ALLOWED);
    });
    it('launchDetached hands the DB to the child env without touching the caller env', () => {
        const launches = [];
        const caller = { ...env, TRAJECTORY_DB_PATH: 'elsewhere' };
        launchDetached(fakeSpawner(launches), invoker, db, caller);
        assert.equal(launches[0].options.env?.TRAJECTORY_DB_PATH, db);
        assert.equal(caller.TRAJECTORY_DB_PATH, 'elsewhere');
    });
});
//# sourceMappingURL=hooks-task-close.test.js.map