/**
 * SessionStart hook (GH 1692), the port of scripts/hooks/mcp-health-check.sh:
 * samples pgrep for this plugin's trajectory-server, adds the once-per-session
 * install-scope notice and the duplicate-copies warning, and appends one
 * forensic line to <state dir>/logs/mcp-health.log. It never denies.
 *
 * Divergence: the .sh exits 0 silently without jq; this gate needs no jq.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { dbPath, stateDir, stripTrailingNewlines } from './lib/db.js';
import { commandOnPath, commandSubstitution, sleepSeconds } from './lib/host.js';
import { duplicateDisableCmds, duplicateInstalls, duplicateNames, installPluginName, installVersion, projectInstalls, userInstalls, } from './lib/install.js';
import { jqAlternatives, jqCompact, jsonValues } from './lib/jq.js';
import { jqRawText, posixDirname } from './lib/project-env.js';
export const GATE_NAME = 'mcp-health-check';
const DEFAULT_SAMPLES = 3;
const LOG_ROTATE_BYTES = 1_048_576;
const NOTICE_MAX_AGE_MIN = 1440;
const MAX_TEST_INT = 2n ** 63n - 1n;
export const NOT_DETECTED = 'trajectory-server not detected yet at SessionStart; if a trajectory tool returns is_error, load tmb_recovery §B';
/** `jq -r '.hook_event_name // .hookEventName // .event // "unknown"'`, "" → "unknown". */
export function eventName(input) {
    const out = [];
    for (const value of jsonValues(input)) {
        if (value === null)
            out.push('unknown');
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            continue;
        const v = value;
        const hit = [v.hook_event_name, v.hookEventName, v.event].find((x) => x !== undefined && x !== null && x !== false);
        out.push(hit === undefined ? 'unknown' : jqRawText(hit));
    }
    return stripTrailingNewlines(out.join('\n')) || 'unknown';
}
/** TMB_MCP_HEALTH_SAMPLES: digits, else 3; a count `[ -lt ]` cannot read samples nothing. */
export function sampleCount(raw) {
    const v = raw === undefined ? String(DEFAULT_SAMPLES) : raw;
    if (!/^[0-9]+$/.test(v))
        return DEFAULT_SAMPLES;
    if (BigInt(v) > MAX_TEST_INT)
        return 0;
    return Number(v);
}
function pgrepLines(pattern, env) {
    const r = spawnSync('pgrep', ['-f', pattern], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (r.stdout ?? '').split('\n').length - 1;
}
function samplePgrep(env) {
    if (!commandOnPath('pgrep', env))
        return { count: -1, taken: 0 };
    const samples = sampleCount(env.TMB_MCP_HEALTH_SAMPLES);
    const interval = env.TMB_MCP_HEALTH_INTERVAL_S ?? '1.2';
    const root = env.CLAUDE_PLUGIN_ROOT ?? '';
    const pattern = root !== '' ? `${root}/mcp/trajectory-server/dist/index.js` : 'trajectory-server/dist/index.js';
    let count = 0;
    let taken = 0;
    while (taken < samples) {
        if (taken > 0)
            sleepSeconds(interval);
        taken += 1;
        count = pgrepLines(pattern, env);
        if (count > 0)
            break;
    }
    return { count, taken };
}
function noticeMarker(sessionId, env) {
    if (sessionId === '' || sessionId.includes('/') || sessionId.startsWith('.'))
        return '';
    const dir = stateDir(env);
    return dir === null ? '' : `${dir}/sessions/${sessionId}.install-notice`;
}
/** `find <dir> -maxdepth 1 -type f -name '*.install-notice' -mmin +1440 -delete`. */
function pruneNotices(dir, now) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (!name.endsWith('.install-notice'))
            continue;
        const path = `${dir}/${name}`;
        try {
            const st = statSync(path);
            if (!st.isFile())
                continue;
            if (Math.ceil((now - st.mtimeMs) / 60_000) > NOTICE_MAX_AGE_MIN)
                rmSync(path, { force: true });
        }
        catch {
            /* gone */
        }
    }
}
function installNotice(event, sessionId, env) {
    const user = userInstalls(env)[0];
    if (user === undefined)
        return '';
    const project = projectInstalls(env)[0];
    const root = env.CLAUDE_PLUGIN_ROOT ?? '';
    let notice = project !== undefined
        ? `TMB: user-scope TMB v${installVersion(user)} ignored — project install v${installVersion(project)} in use.`
        : `TMB installed at user scope; \`--scope project\` is recommended (see ${root !== '' ? `${root}/` : ''}docs/reference/INSTALL.md).`;
    const marker = noticeMarker(sessionId, env);
    if (marker !== '' && existsSync(marker)) {
        notice = '';
    }
    else if (marker !== '' && event === 'SessionStart') {
        const dir = posixDirname(marker);
        try {
            mkdirSync(dir, { recursive: true });
            pruneNotices(dir, Date.now());
            writeFileSync(marker, '');
        }
        catch {
            /* mkdir -p failed or marker unwritable */
        }
    }
    return notice;
}
function duplicateWarning(env) {
    const rows = duplicateInstalls(env.CLAUDE_PROJECT_DIR ?? '', env);
    if (rows.length === 0)
        return '';
    return `TMB WARNING: ${rows.length} copies of the ${installPluginName(env)} plugin are enabled for this project (${duplicateNames(rows)}). Claude Code registers the hooks of only one of them (which one is not documented) and skips the other's with a plugin load error, so TMB's gates may be missing while its MCP tools still work. Remedy: keep one copy and disable the others from the project root, one of: ${duplicateDisableCmds(rows, env)}; then fully quit and relaunch Claude Code.`;
}
function utcStamp(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function appendLog(event, sessionId, sample, env) {
    const dir = stateDir(env);
    if (dir === null)
        return;
    const logs = `${dir}/logs`;
    try {
        mkdirSync(logs, { recursive: true });
    }
    catch {
        return;
    }
    const log = `${logs}/mcp-health.log`;
    try {
        const st = statSync(log);
        if (st.isFile() && st.size > LOG_ROTATE_BYTES)
            renameSync(log, `${log}.1`);
    }
    catch {
        /* no log yet */
    }
    const line = jqCompact({
        ts: utcStamp(new Date()),
        event,
        mcp_alive: sample.count > 0 ? true : sample.count === 0 ? false : null,
        pgrep_count: sample.count,
        samples: sample.taken,
        session_id: sessionId,
        db_path: dbPath(env) ?? '',
    });
    try {
        appendFileSync(log, `${line}\n`);
    }
    catch {
        /* unwritable log */
    }
}
export const mcpHealthCheck = (payload, env) => {
    const input = commandSubstitution(payload);
    const event = eventName(input);
    const sessionId = stripTrailingNewlines(jqAlternatives(input, [['session_id'], ['sessionId']]));
    const sample = samplePgrep(env);
    let context = sample.count === 0 ? NOT_DETECTED : '';
    for (const part of [installNotice(event, sessionId, env), duplicateWarning(env)]) {
        if (part !== '')
            context = context !== '' ? `${context}\n\n${part}` : part;
    }
    appendLog(event, sessionId, sample, env);
    if (context === '' || event !== 'SessionStart')
        return ALLOW;
    return {
        stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })}\n`,
        code: 0,
    };
};
//# sourceMappingURL=mcp-health-check.js.map