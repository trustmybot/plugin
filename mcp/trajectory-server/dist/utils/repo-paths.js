import { dirname, join } from 'node:path';
export function resolveDefaultRepoPath(db, dbPath) {
    if (!dbPath)
        return undefined;
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'tmb_default_repo'`);
    if (!row?.value_json)
        return undefined;
    let defaultRepo;
    try {
        defaultRepo = JSON.parse(row.value_json);
    }
    catch {
        return undefined;
    }
    if (typeof defaultRepo !== 'string' || defaultRepo.length === 0)
        return undefined;
    const workspaceRoot = dirname(dirname(dirname(dbPath)));
    return join(workspaceRoot, defaultRepo);
}
//# sourceMappingURL=repo-paths.js.map