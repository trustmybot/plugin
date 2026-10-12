import { spawnSync } from 'node:child_process';
import { SUBPROCESS_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason } from '../utils/live-cli-guard.js';
import { classifyUrl } from '../utils/classify-url.js';
let _availabilityCache = null;
export function resetAvailabilityCache() {
    _availabilityCache = null;
}
export function detectAvailable(_spawnFn) {
    if (_spawnFn === undefined && _availabilityCache !== null) {
        return _availabilityCache;
    }
    const check = (cmd, args) => {
        try {
            if (_spawnFn) {
                const result = _spawnFn(cmd, args);
                return result.status === 0;
            }
            if (liveCliBlockReason())
                return false;
            const result = spawnSync(cmd, args, { timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8' });
            return result.status === 0;
        }
        catch {
            return false;
        }
    };
    const result = {
        gh: check('gh', ['auth', 'status']),
        glab: check('glab', ['auth', 'status']),
    };
    if (_spawnFn === undefined) {
        _availabilityCache = result;
    }
    return result;
}
export function detectPreferred() {
    try {
        const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
            timeout: SUBPROCESS_TIMEOUT_MS,
            encoding: 'utf8',
        });
        if (result.status !== 0)
            return null;
        const url = (result.stdout ?? '').trim();
        const provider = classifyUrl(url);
        if (provider === 'github')
            return 'gh';
        if (provider === 'gitlab')
            return 'glab';
        return null;
    }
    catch {
        return null;
    }
}
function remoteSyncEnvDisabled() {
    const v = process.env.TMB_DISABLE_REMOTE_SYNC;
    return v === '1' || v?.toLowerCase() === 'true';
}
export function resolveBackend(configValue, repoRemotes, hasSpawnFn = false, availability) {
    if (!hasSpawnFn && remoteSyncEnvDisabled()) {
        return null;
    }
    if (configValue === 'off')
        return 'off';
    if (configValue === 'gh')
        return 'gh';
    if (configValue === 'glab')
        return 'glab';
    if (configValue === 'both')
        return 'both';
    // 'auto' — derive the decision from the issue repo's configured remotes
    // (repo_remotes), gated only by a CLI-availability check that confirms the
    // chosen CLI is installed/authed. No process.cwd() git probe.
    const available = availability ?? detectAvailable();
    const ghUsable = (repoRemotes?.github ?? false) && available.gh;
    const glUsable = (repoRemotes?.gitlab ?? false) && available.glab;
    if (ghUsable && glUsable)
        return 'both';
    if (ghUsable)
        return 'gh';
    if (glUsable)
        return 'glab';
    return null;
}
function readIssueSyncConfig(db) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'issue_sync'`);
    if (!row)
        return 'off';
    try {
        return String(JSON.parse(row.value_json));
    }
    catch {
        return 'off';
    }
}
// The one kill-switch every server-side remote write consults. The env var wins
// over everything, including an injected spawn: a disabled workspace reaches no
// remote. `repoRemotes` is the issue repo's configured providers; `spawnFn`,
// when injected, also answers the gh/glab availability probe of 'auto'.
export function remoteSyncGate(db, opts = {}) {
    if (remoteSyncEnvDisabled())
        return { enabled: false, reason: 'env_disabled' };
    const config = readIssueSyncConfig(db);
    if (config === 'off')
        return { enabled: false, reason: 'issue_sync_off' };
    const explicit = config === 'gh' || config === 'glab' || config === 'both';
    const availability = explicit ? undefined : detectAvailable(opts.spawnFn);
    const backend = resolveBackend(config, opts.repoRemotes ?? null, true, availability);
    if (backend === null || backend === 'off')
        return { enabled: false, reason: 'no_backend' };
    return { enabled: true };
}
//# sourceMappingURL=backend.js.map