import { spawnSync } from 'node:child_process';
export function detectAvailable() {
    const check = (cmd, args) => {
        try {
            const result = spawnSync(cmd, args, { timeout: 5000, encoding: 'utf8' });
            return result.status === 0;
        }
        catch {
            return false;
        }
    };
    return {
        gh: check('gh', ['auth', 'status']),
        glab: check('glab', ['auth', 'status']),
    };
}
export function detectPreferred() {
    try {
        const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
            timeout: 5000,
            encoding: 'utf8',
        });
        if (result.status !== 0)
            return null;
        const url = (result.stdout ?? '').trim();
        if (url.includes('github.com'))
            return 'gh';
        if (url.includes('gitlab.com'))
            return 'glab';
        return null;
    }
    catch {
        return null;
    }
}
export function resolveBackend(configValue) {
    if (configValue === 'off')
        return 'off';
    if (configValue === 'gh')
        return 'gh';
    if (configValue === 'glab')
        return 'glab';
    if (configValue === 'both')
        return 'both';
    // 'auto' — detect at runtime
    const available = detectAvailable();
    if (!available.gh && !available.glab)
        return null;
    const preferred = detectPreferred();
    if (preferred === 'gh' && available.gh)
        return 'gh';
    if (preferred === 'glab' && available.glab)
        return 'glab';
    // No origin preference — use whichever is available (gh preferred)
    if (available.gh)
        return 'gh';
    if (available.glab)
        return 'glab';
    return null;
}
//# sourceMappingURL=backend.js.map