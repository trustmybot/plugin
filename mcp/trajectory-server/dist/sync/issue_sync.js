import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const logDir = join(homedir(), '.claude', 'tmb', 'logs');
const syncLogPath = join(logDir, 'issue-sync.log');
try {
    mkdirSync(logDir, { recursive: true });
}
catch {
    // Log dir creation failed; logging becomes a no-op.
}
function syncLog(entry) {
    try {
        const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
        appendFileSync(syncLogPath, line);
    }
    catch {
        // Swallow all errors — logging must never break the caller.
    }
}
function defaultSpawnFn(cmd, args, opts) {
    const result = spawnSync(cmd, args, opts);
    return {
        status: result.status,
        stdout: result.stdout ? String(result.stdout) : '',
        stderr: result.stderr ? String(result.stderr) : '',
    };
}
function parseRemoteIid(stdout, kind) {
    const trimmed = stdout.trim();
    if (kind === 'github') {
        // gh issue create returns a URL like https://github.com/owner/repo/issues/42
        const match = trimmed.match(/\/issues\/(\d+)/);
        if (match)
            return parseInt(match[1], 10);
    }
    else {
        // glab issue create returns a URL like https://gitlab.com/owner/repo/-/issues/42
        const match = trimmed.match(/\/issues\/(\d+)/);
        if (match)
            return parseInt(match[1], 10);
    }
    return null;
}
function isFailure(r) {
    return r.ok === false;
}
async function createOnBackend(backend, opts, spawnFn) {
    const { title, body, labels = [] } = opts;
    const kind = backend === 'gh' ? 'github' : 'gitlab';
    const spawnOpts = { timeout: 5000, encoding: 'utf8' };
    if (opts._cwd) {
        spawnOpts.cwd = opts._cwd;
    }
    let cmd;
    let args;
    if (backend === 'gh') {
        cmd = 'gh';
        args = ['issue', 'create', '--title', title, '--body', body];
        for (const label of labels) {
            args.push('--label', label);
        }
    }
    else {
        cmd = 'glab';
        args = ['issue', 'create', '--title', title, '--description', body];
        for (const label of labels) {
            args.push('--label', label);
        }
    }
    try {
        const result = spawnFn(cmd, args, spawnOpts);
        if (result.status !== 0) {
            syncLog({
                event: 'issue_create_failed',
                backend,
                issueId: opts.issueId,
                stderr: result.stderr,
                exit_code: result.status,
            });
            return {
                ok: false,
                reason: 'non_zero_exit',
                backend,
                stderr: result.stderr,
                stdout: result.stdout,
                exit_code: result.status ?? undefined,
            };
        }
        const remote_iid = parseRemoteIid(result.stdout, kind);
        if (remote_iid === null) {
            syncLog({
                event: 'issue_create_parse_failed',
                backend,
                issueId: opts.issueId,
                stdout: result.stdout,
            });
            return {
                ok: false,
                reason: 'parse_failed',
                backend,
                stdout: result.stdout,
                message: `could not parse remote issue id from "${cmd} ${args.join(' ')}" output`,
            };
        }
        return { remote_iid, remote_kind: kind };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        syncLog({
            event: 'issue_create_error',
            backend,
            issueId: opts.issueId,
            error: message,
        });
        return {
            ok: false,
            reason: 'spawn_error',
            backend,
            message,
        };
    }
}
export async function syncIssueCreate(opts) {
    const spawnFn = opts._spawnFn ?? defaultSpawnFn;
    const backend = opts._backend;
    if (!backend) {
        return {
            ok: false,
            reason: 'no_backend',
            backend: null,
            message: 'no remote backend configured (issue_sync key resolved to null)',
        };
    }
    syncLog({
        kind: 'issue_sync_active',
        backend,
        issue_id: opts.issueId,
        title: opts.title,
    });
    if (backend === 'gh') {
        return createOnBackend('gh', opts, spawnFn);
    }
    if (backend === 'glab') {
        return createOnBackend('glab', opts, spawnFn);
    }
    if (backend === 'both') {
        const ghResult = await createOnBackend('gh', opts, spawnFn);
        if (!isFailure(ghResult))
            return ghResult;
        return createOnBackend('glab', opts, spawnFn);
    }
    return {
        ok: false,
        reason: 'no_backend',
        backend: null,
        message: `unrecognised backend "${backend}"`,
    };
}
export { isFailure as isSyncFailure };
export async function syncIssueClose(opts) {
    const spawnFn = opts._spawnFn ?? defaultSpawnFn;
    const { remote_iid, remote_kind } = opts;
    const spawnOpts = { timeout: 5000, encoding: 'utf8' };
    if (opts._cwd) {
        spawnOpts.cwd = opts._cwd;
    }
    let cmd;
    let args;
    if (remote_kind === 'github') {
        cmd = 'gh';
        args = ['issue', 'close', String(remote_iid)];
    }
    else {
        cmd = 'glab';
        args = ['issue', 'close', String(remote_iid)];
    }
    try {
        const result = spawnFn(cmd, args, spawnOpts);
        if (result.status !== 0) {
            syncLog({
                event: 'issue_close_failed',
                remote_kind,
                remote_iid,
                stderr: result.stderr,
                exit_code: result.status,
            });
            return {
                ok: false,
                reason: 'non_zero_exit',
                stderr: result.stderr,
                stdout: result.stdout,
                exit_code: result.status ?? undefined,
            };
        }
        return { ok: true };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        syncLog({
            event: 'issue_close_error',
            remote_kind,
            remote_iid,
            error: message,
        });
        return { ok: false, reason: 'spawn_error', message };
    }
}
//# sourceMappingURL=issue_sync.js.map