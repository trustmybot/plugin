import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason, liveCliBlockedMessage } from '../utils/live-cli-guard.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginName } from '../db.js';
function resolveLogDir() {
    if (process.env.TMB_SYNC_LOG_DIR)
        return process.env.TMB_SYNC_LOG_DIR;
    return join(homedir(), '.claude', resolvePluginName(process.env), 'logs');
}
const logDir = resolveLogDir();
const syncLogPath = join(logDir, 'issue-sync.log');
try {
    mkdirSync(logDir, { recursive: true });
}
catch {
    // Log dir creation failed; logging becomes a no-op.
}
function syncLog(entry) {
    const currentLogPath = process.env.TMB_SYNC_LOG_DIR
        ? join(process.env.TMB_SYNC_LOG_DIR, 'issue-sync.log')
        : syncLogPath;
    try {
        const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
        appendFileSync(currentLogPath, line);
    }
    catch {
        // Swallow all errors — logging must never break the caller.
    }
}
function defaultSpawnFn(cmd, args, opts) {
    const blockReason = liveCliBlockReason();
    if (blockReason) {
        const message = liveCliBlockedMessage(blockReason, cmd, args);
        syncLog({ event: 'live_cli_blocked', cmd, args, reason: blockReason });
        return { status: null, stdout: '', stderr: message };
    }
    const result = spawnSync(cmd, args, opts);
    return {
        status: result.status,
        stdout: result.stdout ? String(result.stdout) : '',
        stderr: result.stderr ? String(result.stderr) : '',
    };
}
function parseRemoteIid(stdout, _kind) {
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        const urlMatch = trimmed.match(/https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)\/-?\/?(?:issues|work_items)\/(\d+)/);
        if (urlMatch) {
            const host = urlMatch[1];
            const repoPath = urlMatch[2];
            const iid = parseInt(urlMatch[3], 10);
            return { iid, host, repoPath };
        }
    }
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (/^#\d+$/.test(trimmed)) {
            const iid = parseInt(trimmed.slice(1), 10);
            return { iid, host: '', repoPath: '' };
        }
    }
    return null;
}
function extractRemoteHostAndRepo(remoteUrl) {
    if (!remoteUrl)
        return null;
    const httpMatch = remoteUrl.match(/https?:\/\/([^/]+)\/([^/]+(?:\/[^/]+)+?)(?:\.git)?$/);
    if (httpMatch)
        return { host: httpMatch[1], repoPath: httpMatch[2] };
    const sshMatch = remoteUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
    if (sshMatch)
        return { host: sshMatch[1], repoPath: sshMatch[2] };
    return null;
}
async function readBackVerify(backend, iid, spawnFn, spawnOpts, repoSlug) {
    try {
        let result;
        if (backend === 'gh') {
            const args = ['issue', 'view', String(iid), '--json', 'number,url'];
            if (repoSlug)
                args.push('--repo', repoSlug);
            result = spawnFn('gh', args, spawnOpts);
        }
        else {
            const args = ['issue', 'view', String(iid)];
            if (repoSlug)
                args.push('-R', repoSlug);
            result = spawnFn('glab', args, spawnOpts);
        }
        if (result.status !== 0) {
            return { ok: false, reason: 'read_back_non_zero_exit' };
        }
        if (backend === 'gh') {
            let parsed;
            try {
                parsed = JSON.parse(result.stdout);
            }
            catch {
                return { ok: false, reason: 'read_back_parse_failed' };
            }
            if (parsed.url && parsed.url.includes('/pull/')) {
                return { ok: false, reason: 'read_back_is_pr' };
            }
        }
        return { ok: true };
    }
    catch (e) {
        return { ok: false, reason: 'read_back_error' };
    }
}
// Extract the `owner/repo` slug (the `--repo` / `-R` argument value) from a
// configured remote URL, including the host so gh/glab target the exact repo
// rather than inferring it from process.cwd(). Returns null when the URL can't
// be parsed (the caller then omits the flag and falls back to _cwd).
export function repoSlugFromRemoteUrl(remoteUrl) {
    const parsed = extractRemoteHostAndRepo(remoteUrl);
    if (!parsed)
        return null;
    const repoPath = parsed.repoPath.replace(/\.git$/, '');
    return `${parsed.host}/${repoPath}`;
}
// Fetch the remote label taxonomy for a backend (one probe per create, no
// persistent cache — #36). Returns the set of existing label names, or null
// when the taxonomy can't be determined (probe failed / unparseable) so the
// caller falls back to passing every requested label through unchanged rather
// than stripping them all.
async function fetchRemoteLabelNames(backend, spawnFn, spawnOpts, repoSlug) {
    try {
        let result;
        if (backend === 'gh') {
            const args = ['label', 'list', '--json', 'name'];
            if (repoSlug)
                args.push('--repo', repoSlug);
            result = spawnFn('gh', args, spawnOpts);
        }
        else {
            const args = ['label', 'list', '-F', 'json'];
            if (repoSlug)
                args.push('-R', repoSlug);
            result = spawnFn('glab', args, spawnOpts);
        }
        if (result.status !== 0)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(result.stdout);
        }
        catch {
            return null;
        }
        if (!Array.isArray(parsed))
            return null;
        const names = new Set();
        for (const entry of parsed) {
            if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
                names.add(entry.name);
            }
        }
        return names;
    }
    catch {
        return null;
    }
}
// Verify a remote issue exists before adopting its iid onto a local row (#36).
// gh: `gh issue view <iid> --repo <slug> --json number,title,state` — a PR iid
// makes `gh issue view` exit non-zero, so PRs are rejected implicitly. glab:
// `glab issue view <iid> -R <slug>`, status-only (matching the close/read-back
// path, which never parses glab JSON). Returns { ok:false, reason } on any
// failure so the caller can surface a named error and create nothing.
export async function verifyRemoteIssue(backend, iid, opts = {}) {
    const spawnFn = opts.spawnFn ?? defaultSpawnFn;
    const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
    if (opts.cwd)
        spawnOpts.cwd = opts.cwd;
    try {
        let result;
        if (backend === 'gh') {
            const args = ['issue', 'view', String(iid), '--json', 'number,title,state'];
            if (opts.repoSlug)
                args.push('--repo', opts.repoSlug);
            result = spawnFn('gh', args, spawnOpts);
        }
        else {
            const args = ['issue', 'view', String(iid)];
            if (opts.repoSlug)
                args.push('-R', opts.repoSlug);
            result = spawnFn('glab', args, spawnOpts);
        }
        if (result.status !== 0)
            return { ok: false, reason: 'not_found_or_error' };
        if (backend === 'gh') {
            let parsed;
            try {
                parsed = JSON.parse(result.stdout);
            }
            catch {
                return { ok: false, reason: 'parse_failed' };
            }
            if (typeof parsed.number !== 'number')
                return { ok: false, reason: 'parse_failed' };
        }
        return { ok: true };
    }
    catch {
        return { ok: false, reason: 'spawn_error' };
    }
}
function isFailure(r) {
    return r.ok === false;
}
async function createOnBackend(backend, opts, spawnFn) {
    const { title, body, labels = [], milestone } = opts;
    const kind = backend === 'gh' ? 'github' : 'gitlab';
    const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
    if (opts._cwd) {
        spawnOpts.cwd = opts._cwd;
    }
    // Label pre-validation (#36): split the requested labels against the remote's
    // actual taxonomy and create with only the valid subset, so one unknown label
    // no longer fails the whole create. When the taxonomy can't be fetched, pass
    // every label through unchanged (prior behaviour). An empty valid subset still
    // creates the issue with no labels. The full requested set stays on the local
    // row (the caller persists it) — this only shapes the remote command.
    let effectiveLabels = labels;
    let unknownLabels = [];
    if (labels.length > 0) {
        const known = await fetchRemoteLabelNames(backend, spawnFn, spawnOpts, opts._repoSlug);
        if (known !== null) {
            effectiveLabels = labels.filter((l) => known.has(l));
            unknownLabels = labels.filter((l) => !known.has(l));
            if (unknownLabels.length > 0) {
                syncLog({
                    event: 'issue_create_labels_filtered',
                    backend,
                    issueId: opts.issueId,
                    unknown: unknownLabels,
                    kept: effectiveLabels,
                });
            }
        }
    }
    let cmd;
    let args;
    if (backend === 'gh') {
        cmd = 'gh';
        args = ['issue', 'create', '--title', title, '--body', body];
        if (opts._repoSlug) {
            args.push('--repo', opts._repoSlug);
        }
        for (const label of effectiveLabels) {
            args.push('--label', label);
        }
        if (milestone) {
            args.push('--milestone', milestone);
        }
    }
    else {
        cmd = 'glab';
        args = ['issue', 'create', '--title', title, '--description', body];
        if (opts._repoSlug) {
            args.push('-R', opts._repoSlug);
        }
        for (const label of effectiveLabels) {
            args.push('--label', label);
        }
        if (milestone) {
            args.push('--milestone', milestone);
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
        const parsed = parseRemoteIid(result.stdout, kind);
        if (parsed === null) {
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
        if (opts._remoteUrl && parsed.host) {
            const configured = extractRemoteHostAndRepo(opts._remoteUrl);
            if (configured) {
                const hostMismatch = parsed.host !== configured.host;
                const repoMismatch = parsed.repoPath.replace(/\.git$/, '') !== configured.repoPath.replace(/\.git$/, '');
                if (hostMismatch || repoMismatch) {
                    syncLog({
                        event: 'issue_create_verify_failed',
                        backend,
                        issueId: opts.issueId,
                        reason: 'host_repo_mismatch',
                        parsed_host: parsed.host,
                        parsed_repo: parsed.repoPath,
                        configured_host: configured.host,
                        configured_repo: configured.repoPath,
                        stdout: result.stdout,
                    });
                    return {
                        ok: false,
                        reason: 'verify_failed',
                        backend,
                        stdout: result.stdout,
                        message: `remote iid host/repo mismatch: got ${parsed.host}/${parsed.repoPath}, expected ${configured.host}/${configured.repoPath}`,
                    };
                }
            }
        }
        const verifyResult = await readBackVerify(backend, parsed.iid, spawnFn, spawnOpts, opts._repoSlug);
        if (!verifyResult.ok) {
            syncLog({
                event: 'issue_create_verify_failed',
                backend,
                issueId: opts.issueId,
                reason: verifyResult.reason,
                iid: parsed.iid,
                stdout: result.stdout,
            });
            return {
                ok: false,
                reason: 'verify_failed',
                backend,
                stdout: result.stdout,
                message: `read-back verify failed for iid ${parsed.iid}: ${verifyResult.reason}`,
            };
        }
        syncLog({
            event: 'issue_create_success',
            backend,
            issueId: opts.issueId,
            iid: parsed.iid,
            stdout: result.stdout,
        });
        return {
            remote_iid: parsed.iid,
            remote_kind: kind,
            unknown_labels: unknownLabels.length > 0 ? unknownLabels : undefined,
        };
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
    return {
        ok: false,
        reason: 'no_backend',
        backend: null,
        message: `unrecognised backend "${backend}" — use issue_create for dual-backend creates`,
    };
}
export { isFailure as isSyncFailure };
export async function syncIssueClose(opts) {
    const spawnFn = opts._spawnFn ?? defaultSpawnFn;
    const { remote_iid, remote_kind } = opts;
    const spawnOpts = { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' };
    if (opts._cwd) {
        spawnOpts.cwd = opts._cwd;
    }
    let cmd;
    let args;
    if (remote_kind === 'github') {
        cmd = 'gh';
        args = ['issue', 'close', String(remote_iid)];
        if (opts._repoSlug) {
            args.push('--repo', opts._repoSlug);
        }
    }
    else {
        cmd = 'glab';
        args = ['issue', 'close', String(remote_iid)];
        if (opts._repoSlug) {
            args.push('-R', opts._repoSlug);
        }
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