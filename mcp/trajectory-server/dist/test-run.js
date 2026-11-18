/**
 * `node dist/test-run.js [--log <path>] [--max-lines <n>] -- <argv...>` (GH 1907):
 * runs one test command — argv[0] with the rest as its arguments, no shell
 * (GH 2438); shell syntax goes through `-- bash -c '<cmd>'` — writes its
 * combined raw output to a log file and prints one summary line plus capped
 * failure excerpts instead of the full output. Recognises node TAP, node spec
 * and assert-style (`N/M passed`) output; anything else prints its tail on a
 * non-zero exit. A full suite (isFullSuiteArgv) first waits for a suite slot
 * (suite-lock.ts, GH 2092).
 *
 * The command runs in a process group of its own, stdin closed, within a hard
 * budget (GH 3249): `--budget-s <n>`, else TMB_TEST_RUN_BUDGET_S, else 1800 s.
 * Past it test-run stops the group (SIGTERM, SIGKILL after a grace), frees
 * the slot, says `budget Ns exceeded; killed process group P` in the log and
 * on stdout, and exits 124. SIGTERM, SIGINT or SIGHUP to test-run, or its
 * parent going away (checked every 5 s), stops the group and frees the slot
 * the same way, exiting 128 + the signal (129 when orphaned).
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireSuiteSlot, isFullSuiteArgv, stopProcessGroup, SUITE_LOCK_HELD_ENV } from './suite-lock.js';
const DEFAULT_MAX_LINES = 40;
const MAX_FAILURES = 10;
/** The default budget: the swe verification gate's maximum budget (VERIFICATION_MAX_S). */
const DEFAULT_BUDGET_S = 1800;
const BUDGET_ENV = 'TMB_TEST_RUN_BUDGET_S';
const PARENT_CHECK_MS = 5_000;
const TIMED_OUT_EXIT = 124;
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;
const USAGE = 'usage: node test-run.js [--log <path>] [--max-lines <n>] [--budget-s <n>] -- <argv...>';
const SHELL_HINT = "use -- bash -c '<cmd>' for shell syntax";
const SHELL_BUILTINS = new Set(['exit', 'cd', 'export', 'source', '.', 'set', 'unset', 'alias', 'eval', '[[', 'return', 'shift', 'trap', 'ulimit', 'umask']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function stripAnsi(text) {
    return text.replace(ANSI_RE, '');
}
function parseArgs(argv) {
    let log = join(tmpdir(), `tmb-test-run-${process.pid}-${Date.now()}.log`);
    let maxLines = DEFAULT_MAX_LINES;
    let budgetS = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') {
            const childArgv = argv.slice(i + 1);
            if (!childArgv[0]?.trim())
                return null;
            return { log: resolve(log), maxLines, budgetS, command: childArgv.join(' '), argv: childArgv };
        }
        const value = argv[i + 1];
        if (value === undefined)
            return null;
        if (arg === '--log') {
            log = value;
        }
        else if (arg === '--max-lines') {
            if (!POSITIVE_INT_RE.test(value))
                return null;
            maxLines = Number(value);
        }
        else if (arg === '--budget-s') {
            if (!POSITIVE_INT_RE.test(value))
                return null;
            budgetS = Number(value);
        }
        else {
            return null;
        }
        i++;
    }
    return null;
}
function trailerCount(lines, prefix, key) {
    const re = new RegExp(`^${prefix} ${key} (\\d+)\\s*$`);
    let found = null;
    for (const line of lines) {
        const m = re.exec(line);
        if (m)
            found = (found ?? 0) + Number(m[1]);
    }
    return found;
}
function trimBlock(block, drop) {
    let end = block.length;
    while (end > 1 && drop.test(block[end - 1]))
        end--;
    return block.slice(0, end);
}
function indentOf(line) {
    return line.length - line.trimStart().length;
}
const TAP_RESULT_RE = /^\s*(not ok|ok)\b/;
const TAP_STOP_RE = /^\s*(?:(?:not ok|ok)\b|1\.\.\d+|# Subtest:)/;
const TAP_TRAILER_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /;
function tapFailures(lines) {
    const blocks = [];
    for (let i = 0; i < lines.length; i++) {
        const head = lines[i];
        const m = TAP_RESULT_RE.exec(head);
        if (!m || m[1] !== 'not ok' || /#\s*(TODO|SKIP)\b/i.test(head))
            continue;
        const indent = indentOf(head);
        const block = [head];
        let yamlIndent = null;
        for (let j = i + 1; j < lines.length; j++) {
            const line = lines[j];
            if (TAP_TRAILER_RE.test(line))
                break;
            if (TAP_STOP_RE.test(line) && indentOf(line) <= indent)
                break;
            block.push(line);
            if (block.length === 2 && line.trim() === '---' && indentOf(line) > indent)
                yamlIndent = indentOf(line);
            else if (yamlIndent !== null && line.trim() === '...' && indentOf(line) === yamlIndent)
                break;
        }
        if (block.some((l) => /failureType: 'subtestsFailed'/.test(l)))
            continue;
        blocks.push(trimBlock(block, /^\s*(# Subtest:.*)?$/));
    }
    return blocks;
}
function specFailures(lines) {
    const start = lines.findIndex((l) => /^✖ failing tests:\s*$/.test(l));
    if (start < 0)
        return [];
    const blocks = [];
    let current = null;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        const opens = line.startsWith('test at ') || (line.startsWith('✖ ') && !(current?.length === 1 && current[0].startsWith('test at ')));
        if (opens) {
            if (current)
                blocks.push(trimBlock(current, /^\s*$/));
            current = [line];
        }
        else if (current) {
            current.push(line);
        }
    }
    if (current)
        blocks.push(trimBlock(current, /^\s*$/));
    return blocks;
}
const ASSERT_ALL_RE = /^(\d+)\/(\d+) passed\s*$/;
const ASSERT_SOME_RE = /^(\d+) passed, (\d+) failed \((\d+) total\)\s*$/;
function assertFailures(lines) {
    const blocks = [];
    let current = null;
    for (const line of lines) {
        if (line.startsWith('FAIL ')) {
            if (current)
                blocks.push(trimBlock(current, /^\s*$/));
            current = [line];
        }
        else if (line.startsWith('PASS ') || ASSERT_ALL_RE.test(line) || ASSERT_SOME_RE.test(line)) {
            if (current)
                blocks.push(trimBlock(current, /^\s*$/));
            current = null;
        }
        else if (current) {
            current.push(line);
        }
    }
    if (current)
        blocks.push(trimBlock(current, /^\s*$/));
    return blocks;
}
function sumSkip(skipped, todo) {
    return (skipped ?? 0) + (todo ?? 0);
}
function parseOutput(text) {
    const lines = stripAnsi(text).split(/\r?\n/);
    const tapPass = trailerCount(lines, '#', 'pass');
    const tapFail = trailerCount(lines, '#', 'fail');
    if (tapPass !== null || tapFail !== null) {
        return {
            format: 'tap',
            pass: tapPass ?? 0,
            fail: tapFail ?? 0,
            skip: sumSkip(trailerCount(lines, '#', 'skipped'), trailerCount(lines, '#', 'todo')),
            failures: tapFailures(lines),
        };
    }
    const specPass = trailerCount(lines, 'ℹ', 'pass');
    const specFail = trailerCount(lines, 'ℹ', 'fail');
    if (specPass !== null || specFail !== null) {
        return {
            format: 'spec',
            pass: specPass ?? 0,
            fail: specFail ?? 0,
            skip: sumSkip(trailerCount(lines, 'ℹ', 'skipped'), trailerCount(lines, 'ℹ', 'todo')),
            failures: specFailures(lines),
        };
    }
    let pass = null;
    let fail = 0;
    for (const line of lines) {
        const all = ASSERT_ALL_RE.exec(line);
        const some = ASSERT_SOME_RE.exec(line);
        if (all) {
            pass = (pass ?? 0) + Number(all[1]);
            fail += Number(all[2]) - Number(all[1]);
        }
        else if (some) {
            pass = (pass ?? 0) + Number(some[1]);
            fail += Number(some[2]);
        }
    }
    if (pass !== null) {
        return { format: 'assert', pass, fail, skip: 0, failures: assertFailures(lines) };
    }
    return { format: 'unknown', pass: null, fail: null, skip: null, failures: [] };
}
function count(n) {
    return n === null ? '?' : String(n);
}
function render(parsed, rc, log, elapsedMs, maxLines, rawText) {
    const out = [
        `test-run: exit=${rc} pass=${count(parsed.pass)} fail=${count(parsed.fail)} skip=${count(parsed.skip)} ` +
            `format=${parsed.format} log=${log} elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
    ];
    if (rc === 0)
        return out;
    if (parsed.failures.length === 0) {
        const text = stripAnsi(rawText).replace(/\r?\n$/, '');
        if (text !== '')
            out.push(...text.split(/\r?\n/).slice(-maxLines));
        return out;
    }
    for (const block of parsed.failures.slice(0, MAX_FAILURES)) {
        out.push(...block.slice(0, maxLines));
        if (block.length > maxLines)
            out.push(`… (${block.length - maxLines} more lines in log)`);
    }
    if (parsed.failures.length > MAX_FAILURES) {
        out.push(`… and ${parsed.failures.length - MAX_FAILURES} more failures`);
    }
    return out;
}
function exitCode(status, signal) {
    if (status !== null)
        return status;
    if (signal !== null)
        return 128 + (constants.signals[signal] ?? 0);
    return 1;
}
async function main(argv) {
    const opts = parseArgs(argv);
    if (!opts) {
        process.stderr.write(`${USAGE}\n`);
        return 2;
    }
    const program = opts.argv[0];
    if (SHELL_BUILTINS.has(program) || ASSIGNMENT_RE.test(program)) {
        process.stderr.write(`test-run: ${program} is shell syntax, not a program; ${SHELL_HINT}\n`);
        return 2;
    }
    const budgetS = opts.budgetS ?? envBudgetS(process.env);
    if (budgetS === null) {
        process.stderr.write(`test-run: ${BUDGET_ENV} must be a positive integer of seconds\n`);
        return 2;
    }
    mkdirSync(dirname(opts.log), { recursive: true });
    // A reader that went away with test-run's parent must not crash the cleanup.
    process.stdout.on('error', () => undefined);
    process.stderr.on('error', () => undefined);
    let slot = { kind: 'unlocked' };
    let group;
    // Set from signal and timer callbacks, so held in an object the control-flow analysis leaves unnarrowed.
    const stop = { why: null, done: null };
    const requestStop = (why) => {
        if (stop.why !== null)
            return;
        stop.why = why;
        if (group !== undefined) {
            stop.done = stopProcessGroup(group);
            return;
        }
        // No command runs yet: free a slot already taken and leave at once.
        if (slot.kind === 'held')
            slot.release();
        process.exit(stopExitCode(why));
    };
    const unwatch = watchForStop(requestStop);
    try {
        if (isFullSuiteArgv(opts.argv))
            slot = await acquireSuiteSlot({ command: opts.command, worktree: process.cwd(), env: process.env });
        const env = slot.kind === 'held' ? { ...process.env, [SUITE_LOCK_HELD_ENV]: slot.slot } : process.env;
        const fd = openSync(opts.log, 'w');
        const started = performance.now();
        let rc;
        let notice = null;
        try {
            const child = spawn(program, opts.argv.slice(1), { stdio: ['ignore', fd, fd], env, detached: true });
            group = child.pid;
            const budgetTimer = setTimeout(() => requestStop({ kind: 'budget', budgetS }), budgetS * 1000);
            const result = await new Promise((done) => {
                child.once('error', (error) => done({ status: null, signal: null, error }));
                child.once('exit', (status, signal) => done({ status, signal }));
            });
            clearTimeout(budgetTimer);
            await stop.done;
            const stopped = stop.why;
            if (stopped !== null) {
                rc = stopExitCode(stopped);
                notice = `test-run: ${stopReason(stopped)}; killed process group ${group ?? '?'}`;
                writeSync(fd, `${notice}\n`);
            }
            else if (result.error) {
                const message = `test-run: cannot run ${program} (${result.error.code ?? result.error.message}); ${SHELL_HINT}\n`;
                writeSync(fd, message);
                process.stderr.write(message);
                rc = 127;
            }
            else {
                rc = exitCode(result.status, result.signal);
            }
        }
        finally {
            closeSync(fd);
        }
        const elapsed = performance.now() - started;
        const raw = readFileSync(opts.log, 'utf8');
        const lines = render(parseOutput(raw), rc, opts.log, elapsed, opts.maxLines, raw);
        if (notice !== null && !lines.includes(notice))
            lines.splice(1, 0, notice);
        process.stdout.write(`${lines.join('\n')}\n`);
        return rc;
    }
    finally {
        unwatch();
        if (slot.kind === 'held')
            slot.release();
    }
}
/** TMB_TEST_RUN_BUDGET_S when set, else the default; null when it is set to anything but a positive integer. */
function envBudgetS(env) {
    const raw = env[BUDGET_ENV] ?? '';
    if (raw === '')
        return DEFAULT_BUDGET_S;
    return POSITIVE_INT_RE.test(raw) ? Number(raw) : null;
}
function stopExitCode(stop) {
    if (stop.kind === 'budget')
        return TIMED_OUT_EXIT;
    return 128 + constants.signals[stop.kind === 'signal' ? stop.signal : 'SIGHUP'];
}
function stopReason(stop) {
    if (stop.kind === 'budget')
        return `budget ${stop.budgetS}s exceeded`;
    if (stop.kind === 'signal')
        return `received ${stop.signal}`;
    return `parent pid ${stop.parent} is gone`;
}
/** Calls <onStop> on SIGTERM, SIGINT or SIGHUP, or once test-run's parent has gone; returns the unwatch. */
function watchForStop(onStop) {
    const parent = process.ppid;
    const handlers = STOP_SIGNALS.map((signal) => {
        const handler = () => onStop({ kind: 'signal', signal });
        process.on(signal, handler);
        return [signal, handler];
    });
    // A dead parent reparents test-run (to launchd or init), which changes its ppid.
    const parentCheck = setInterval(() => {
        if (process.ppid !== parent)
            onStop({ kind: 'orphaned', parent });
    }, PARENT_CHECK_MS);
    return () => {
        clearInterval(parentCheck);
        for (const [signal, handler] of handlers)
            process.off(signal, handler);
    };
}
process.exitCode = await main(process.argv.slice(2));
//# sourceMappingURL=test-run.js.map