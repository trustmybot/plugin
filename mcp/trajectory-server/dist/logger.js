import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeLogDir } from './platform.js';
/**
 * Create a logger bound to one runtime context's log directory.
 *
 * Directory creation belongs here, not in runtime-context resolution, so
 * resolving and validating paths remains side-effect free.
 */
export function createProjectLogger(opts) {
    let logDirReady = false;
    try {
        mkdirSync(opts.logDir, { recursive: true });
        logDirReady = true;
    }
    catch {
        // Log dir creation failed; both log functions become no-ops.
    }
    const serverLogPath = join(opts.logDir, 'mcp-server.log');
    const sqlLogPath = join(opts.logDir, 'sql.log');
    const serverLog = (entry) => {
        if (!logDirReady)
            return;
        try {
            const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
            appendFileSync(serverLogPath, line);
        }
        catch {
            // Swallow all errors — logging must never break the server.
        }
    };
    const sqlLog = opts.sqlEnabled === true
        ? (entry) => {
            if (!logDirReady)
                return;
            try {
                const line = JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n';
                appendFileSync(sqlLogPath, line);
            }
            catch {
                // Swallow all errors.
            }
        }
        : () => { };
    return Object.freeze({
        logDir: opts.logDir,
        serverLog,
        serverLogSync: serverLog,
        sqlLog,
    });
}
let defaultLogger = null;
function getDefaultLogger() {
    if (defaultLogger === null) {
        defaultLogger = createProjectLogger({
            logDir: resolveClaudeLogDir(),
            sqlEnabled: process.env['TMB_DEBUG_SQL'] === '1',
        });
    }
    return defaultLogger;
}
/**
 * Backward-compatible Claude singleton exports. The singleton is lazy so a
 * Codex caller that supplies explicit logger dependencies can import the DB
 * module without reading Claude metadata or creating ~/.claude state.
 */
export function serverLog(entry) {
    getDefaultLogger().serverLog(entry);
}
export const serverLogSync = serverLog;
export function sqlLog(entry) {
    getDefaultLogger().sqlLog(entry);
}
//# sourceMappingURL=logger.js.map