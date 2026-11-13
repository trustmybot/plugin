/**
 * PostToolUse gate (GH 2570): after a swe Write, Edit or MultiEdit, runs the
 * lints the edited file's repo declares on that file and blocks on the first
 * that fails, so swe fixes it in the same turn.
 *
 * The repo opts in with <top>/.config/tmb/edit-lint.json,
 * {"version":1,"lints":[{"glob":"<path glob>","command":"<cmd>"}]}, <top> being
 * `git -C <dir of the file> rev-parse --show-toplevel`. Each entry whose glob
 * matches the top-relative path (lint-fingerprint.ts matchesInput: path.matchesGlob
 * with `*` and `**` matching dot segments too, F641-1) runs, in config order, as
 * `bash -c '<command> "$TMB_EDIT_LINT_PATH"'` in <top>, lint-staged style, the
 * path reaching bash only through that env var so no part of it is ever parsed
 * as shell (CodeQL js/shell-command-injection-from-environment). It is an
 * allowlist: only the repo's own commands run, and only their non-zero exit
 * blocks, with the command, its exit code and its last 20 output lines.
 *
 * Silent for another role or tool, a missing or relative file_path (never
 * joined to the cwd), a file outside a git checkout, no config and no matching
 * glob. A malformed config, a command that cannot start and a command killed at
 * the budget left each give a one-line note and no block. Commands share the
 * gate's budget: the router deadline, else EDIT_LINT_BUDGET_MS, less
 * WRAP_UP_MS so the note is out before the router stops waiting. The runner
 * mirrors utils/worktree-setup.ts: one process group per command, its output
 * in a scratch file, the group SIGKILLed at its limit.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ALLOW } from './gate.js';
import { spawnLimit } from './lib/deadline.js';
import { blockResult } from './lib/deny.js';
import { gitRun } from './lib/git.js';
import { jqCompact } from './lib/jq.js';
import { matchesInput } from './lib/lint-fingerprint.js';
import { normalizeRole } from './lib/role.js';
export const GATE_NAME = 'swe-edit-lint';
export const EDIT_LINT_FILE = '.config/tmb/edit-lint.json';
export const EDIT_LINT_BUDGET_MS = 10_000;
export const WRAP_UP_MS = 500;
export const PATH_VAR = 'TMB_EDIT_LINT_PATH';
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const TAIL_LINES = 20;
const TAIL_CHARS = 4000;
const signals = osConstants.signals;
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
export function parseEditLint(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { error: `not valid JSON: ${e.message}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return { error: 'must be a JSON object {"version":1,"lints":[...]}' };
    const { version, lints } = parsed;
    if (version !== 1)
        return { error: `version must be 1, got ${JSON.stringify(version) ?? 'none'}` };
    const valid = (l) => l !== null && typeof l === 'object' && typeof l.glob === 'string' && l.glob !== '' && typeof l.command === 'string' && l.command.trim() !== '';
    if (!Array.isArray(lints) || !lints.every(valid))
        return { error: 'lints must be an array of {"glob":"<non-empty>","command":"<non-empty>"}' };
    return { lints: lints.map((l) => ({ glob: l.glob, command: l.command })) };
}
function readEditLint(top) {
    let raw;
    try {
        raw = readFileSync(join(top, EDIT_LINT_FILE), 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        return { error: `cannot read: ${e.message}` };
    }
    return parseEditLint(raw);
}
function tail(text) {
    return text.replace(/\n+$/, '').split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
}
function runLint(command, rel, cwd, env, timeoutMs, outPath) {
    return new Promise((done) => {
        const fd = openSync(outPath, 'w');
        let timedOut = false;
        let settled = false;
        const finish = (run) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            done(run);
        };
        const child = spawn('bash', ['-c', `${command} "$${PATH_VAR}"`], { cwd, env: { ...env, PWD: cwd, [PATH_VAR]: rel }, stdio: ['ignore', fd, fd], detached: true });
        closeSync(fd);
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (child.pid !== undefined)
                    process.kill(-child.pid, 'SIGKILL');
            }
            catch {
                /* already gone */
            }
        }, timeoutMs);
        child.on('error', (e) => finish({ exitCode: 127, timedOut: false, startError: e.message }));
        child.on('exit', (code, signal) => finish({ exitCode: code ?? 128 + (signal !== null ? (signals[signal] ?? 0) : 0), timedOut }));
    });
}
function note(text) {
    return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `TMB: ${GATE_NAME}: ${oneLine(text)}` } })}\n`, code: 0 };
}
function payloadFields(payload) {
    let parsed;
    try {
        parsed = JSON.parse(payload);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    const p = parsed;
    const str = (v) => (typeof v === 'string' ? v : '');
    const input = p.tool_input !== null && typeof p.tool_input === 'object' ? p.tool_input : {};
    return { tool: str(p.tool_name), role: normalizeRole(str(p.agent_type) || str(p.subagent_type)), filePath: str(input.file_path) };
}
/** <file>'s path from the top of its git checkout, both canonical, or null outside one. */
async function checkoutPath(file, env) {
    let real;
    try {
        real = realpathSync(file);
    }
    catch {
        return null;
    }
    const git = await gitRun(dirname(real), ['rev-parse', '--show-toplevel'], env);
    const shown = git.stdout.replace(/\n+$/, '');
    if (git.code !== 0 || shown === '')
        return null;
    let top;
    try {
        top = realpathSync(shown);
    }
    catch {
        return null;
    }
    const rel = relative(top, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
        return null;
    return { top, rel };
}
export const sweEditLint = async (payload, env) => {
    const started = performance.now();
    const deadline = started + (spawnLimit(EDIT_LINT_BUDGET_MS)?.timeout ?? EDIT_LINT_BUDGET_MS) - WRAP_UP_MS;
    const fields = payloadFields(payload);
    if (fields === null || !EDIT_TOOLS.has(fields.tool) || fields.role !== 'swe')
        return ALLOW;
    if (!fields.filePath.startsWith('/'))
        return ALLOW;
    const where = await checkoutPath(fields.filePath, env);
    if (where === null)
        return ALLOW;
    const { top, rel } = where;
    const config = readEditLint(top);
    if (config === null)
        return ALLOW;
    if ('error' in config)
        return note(`${EDIT_LINT_FILE}: ${config.error}; no edit lint ran.`);
    let matching;
    try {
        matching = config.lints.filter((l) => matchesInput(rel, l.glob));
    }
    catch (e) {
        return note(`${EDIT_LINT_FILE}: a glob does not parse: ${e.message}; no edit lint ran.`);
    }
    if (matching.length === 0)
        return ALLOW;
    let scratch;
    try {
        scratch = mkdtempSync(join(tmpdir(), 'tmb-edit-lint-'));
    }
    catch (e) {
        return note(`cannot create a scratch dir: ${e.message}; no edit lint ran.`);
    }
    try {
        for (const [i, { command }] of matching.entries()) {
            const left = Math.floor(deadline - performance.now());
            const unrun = matching.length - i;
            if (left <= 0)
                return note(`the budget ran out before \`${command}\` on ${rel}; ${unrun} edit lint(s) did not run and nothing blocked. CI still runs them.`);
            const outPath = join(scratch, `out-${i + 1}`);
            const run = await runLint(command, rel, top, env, left, outPath);
            if (run.startError !== undefined)
                return note(`\`${command}\` on ${rel} could not start: ${run.startError}; nothing blocked.`);
            if (run.timedOut)
                return note(`\`${command}\` on ${rel} was killed at the ${left} ms of budget left; ${unrun - 1} later edit lint(s) did not run and nothing blocked. CI still runs them.`);
            if (run.exitCode === 0)
                continue;
            let out = '';
            try {
                out = readFileSync(outPath, 'utf8');
            }
            catch {
                /* no output file */
            }
            const shown = tail(out);
            const reason = [
                `${GATE_NAME}: \`${command} "${rel}"\` (${EDIT_LINT_FILE}, glob ${matching[i].glob}) exited ${run.exitCode} after your ${fields.tool} of ${rel}.`,
                shown === '' ? 'It printed nothing.' : `Output (last ${TAIL_LINES} lines):\n${shown}`,
                '',
            ].join('\n');
            return blockResult(reason, { allowed: `an Edit of ${rel} that makes \`${command} "${rel}"\` exit 0, run from ${top}.` });
        }
        return ALLOW;
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};
//# sourceMappingURL=swe-edit-lint.js.map