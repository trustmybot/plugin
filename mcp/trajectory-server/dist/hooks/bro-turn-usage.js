/**
 * Stop hook (GH 1692), the port of scripts/hooks/bro-turn-usage.sh: the
 * session's one bro agent_runs row (task_id and issue_id NULL) rewritten with
 * the sums of the transcript's main-loop assistant usage, inserted when
 * absent, in one tmb_db_write transaction. The transcript reduction follows
 * the .sh's jq program value for value: lines grouped by message id in jq's
 * order (last usage wins, tool_use blocks summed), numbers floored and
 * printed as jq prints them, the model with the most tokens, and no write
 * when jq would have stopped on an error. Bypass:
 * TMB_DISABLE_BRO_TURN_USAGE_HOOK=1. It never denies; a failed write is one
 * stderr line. After a written row it runs the tool-output-size recorder on
 * the session row (GH 1957), fail-open.
 *
 * Divergence: the .sh exits 0 without jq or the sqlite3 CLI; this gate needs
 * neither (node:sqlite writes the row).
 */
import { readFileSync, statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { dbWrite } from './lib/audit.js';
import { dbLocation, dbPath, sqlQuote, stripTrailingNewlines } from './lib/db.js';
import { byteCompare, commandSubstitution } from './lib/host.js';
import { jsonStream, jsonValues } from './lib/jq.js';
import { jqRawText, posixDirname } from './lib/project-env.js';
import { toolOutputSize } from './tool-output-size.js';
export const GATE_NAME = 'bro-turn-usage';
const ISO = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.([0-9]+))?Z\n?$/;
const STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const MODEL_STRIP = /[^A-Za-z0-9._:@/[\]-]/gu;
const DBL_MAX = Number.MAX_VALUE;
class JqError extends Error {
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function index(value, key) {
    if (value === null || value === undefined)
        return null;
    if (typeof value !== 'object' || Array.isArray(value))
        throw new JqError(`Cannot index with ${key}`);
    const v = value[key];
    return v === undefined ? null : v;
}
function truthy(v) {
    return v !== null && v !== undefined && v !== false;
}
/** `jq -r '.<key> // <fallback>'` over every value of <text>, as `$(...)` captures it. */
export function jqKeyOr(text, key, fallback) {
    const out = [];
    for (const value of jsonValues(text)) {
        try {
            const v = index(value, key);
            out.push(truthy(v) ? jqRawText(v) : fallback);
        }
        catch (e) {
            if (!(e instanceof JqError))
                throw e;
        }
    }
    return stripTrailingNewlines(out.join('\n'));
}
function typeRank(v) {
    if (v === null)
        return 0;
    if (v === false)
        return 1;
    if (v === true)
        return 2;
    if (typeof v === 'number')
        return 3;
    if (typeof v === 'string')
        return 4;
    return Array.isArray(v) ? 5 : 6;
}
/** jq's total order of JSON values. */
export function jqCompare(a, b) {
    const ra = typeRank(a);
    const rb = typeRank(b);
    if (ra !== rb)
        return ra - rb;
    if (ra === 3)
        return a < b ? -1 : a > b ? 1 : 0;
    if (ra === 4)
        return byteCompare(a, b);
    if (ra === 5) {
        const x = a;
        const y = b;
        for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
            const c = jqCompare(x[i], y[i]);
            if (c !== 0)
                return c;
        }
        return x.length - y.length;
    }
    if (ra === 6) {
        const x = a;
        const y = b;
        const kx = Object.keys(x).sort(byteCompare);
        const ky = Object.keys(y).sort(byteCompare);
        const c = jqCompare(kx, ky);
        if (c !== 0)
            return c;
        for (const k of kx) {
            const d = jqCompare(x[k], y[k]);
            if (d !== 0)
                return d;
        }
    }
    return 0;
}
/** jq's number literal clamp: JSON.parse's ±Infinity is ±DBL_MAX in jq. */
function jqNumber(v) {
    return v === Infinity ? DBL_MAX : v === -Infinity ? -DBL_MAX : v;
}
/** `n`: a number ≥ 0 floored, anything else 0. */
function n(v) {
    return typeof v === 'number' && jqNumber(v) >= 0 ? Math.floor(jqNumber(v)) : 0;
}
/** `tostring` of an integer-valued double as jq 1.7 prints it (shortest digits, exponent past 15 padding zeros). */
export function jqIntText(x) {
    if (Object.is(x, -0))
        return '-0';
    if (!Number.isFinite(x))
        return x > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308';
    if (x === 0)
        return '0';
    const sign = x < 0 ? '-' : '';
    const [mant, exp] = Math.abs(x).toExponential().split('e');
    const digits = mant.replace('.', '');
    const decpt = Number(exp) + 1;
    if (decpt > digits.length + 15 || decpt <= -4) {
        const e = Number(exp);
        const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        return `${sign}${m}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
    }
    if (decpt >= digits.length)
        return `${sign}${digits}${'0'.repeat(decpt - digits.length)}`;
    return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}
function iso(v) {
    if (typeof v !== 'string')
        return null;
    const m = ISO.exec(v);
    if (m === null)
        return null;
    return `${m[1]}.${`${m[3] ?? ''}000`.slice(0, 3)}Z`;
}
function model(v) {
    return typeof v === 'string' && !v.startsWith('<') ? v.replace(MODEL_STRIP, '') : '';
}
function add(values) {
    return values.reduce((s, v) => s + v);
}
function toolUses(message) {
    let content = index(message, 'content');
    if (!truthy(content))
        content = [];
    if (!Array.isArray(content))
        return 0;
    let count = 0;
    for (const block of content)
        if (index(block, 'type') === 'tool_use')
            count += 1;
    return count;
}
function reduce(values) {
    const main = values.filter((v) => {
        if (v === null || typeof v !== 'object' || Array.isArray(v))
            return false;
        const o = v;
        return !truthy(o.isSidechain) && o.message !== undefined && o.message !== null;
    });
    const stamps = main.map((v) => iso(v.timestamp)).filter((s) => s !== null);
    const entries = [];
    main.forEach((v, i) => {
        const message = v.message;
        const usage = index(message, 'usage');
        if (usage === null)
            return;
        const mid = index(message, 'id');
        const id = truthy(mid) ? mid : truthy(v.uuid) ? v.uuid : `line-${i}`;
        const ts = iso(v.timestamp);
        const m = model(index(message, 'model'));
        const tu = toolUses(message);
        if (ts !== null)
            entries.push({ id, u: usage, m, tu });
    });
    const sorted = [...entries].sort((a, b) => jqCompare(a.id, b.id));
    const groups = [];
    for (const e of sorted) {
        const g = groups.at(-1);
        if (g !== undefined && jqCompare(g[0].id, e.id) === 0)
            g.push(e);
        else
            groups.push([e]);
    }
    const rows = groups.map((g) => {
        const lastEntry = g[g.length - 1];
        const u = lastEntry.u;
        return {
            ti: n(index(u, 'input_tokens')),
            to: n(index(u, 'output_tokens')),
            cr: n(index(u, 'cache_read_input_tokens')),
            cc: n(index(u, 'cache_creation_input_tokens')),
            tu: add(g.map((e) => e.tu)),
            m: lastEntry.m,
        };
    });
    const byModel = new Map();
    for (const r of rows) {
        if (r.m === '')
            continue;
        const tok = r.ti + r.to + r.cr + r.cc;
        byModel.set(r.m, byModel.has(r.m) ? byModel.get(r.m) + tok : tok);
    }
    const ranked = [...byModel.entries()].sort((a, b) => jqCompare([-a[1], a[0]], [-b[1], b[0]]));
    if (ranked.length === 0 || !(add(rows.map((r) => r.to)) > 0))
        return null;
    const sorted2 = [...stamps].sort(byteCompare);
    return {
        first: sorted2[0],
        last: sorted2[sorted2.length - 1],
        tokensIn: jqIntText(add(rows.map((r) => r.ti))),
        tokensOut: jqIntText(add(rows.map((r) => r.to))),
        cacheRead: jqIntText(add(rows.map((r) => r.cr))),
        cacheCreation: jqIntText(add(rows.map((r) => r.cc))),
        toolUses: jqIntText(add(rows.map((r) => r.tu))),
        model: ranked[0][0],
    };
}
/** The .sh's jq reduction of a transcript, null where it prints nothing (or stops on an error). */
export function turnUsage(transcript) {
    const { values, complete } = jsonStream(transcript);
    if (!complete)
        return null;
    try {
        return reduce(values);
    }
    catch (e) {
        if (e instanceof JqError)
            return null;
        throw e;
    }
}
/** tmb_plugin_version: `.version // empty` of the manifest. */
export function pluginVersion(env) {
    const root = env.CLAUDE_PLUGIN_ROOT ?? '';
    const manifest = `${root}/.claude-plugin/plugin.json`;
    if (root === '' || !isFile(manifest))
        return '';
    let text;
    try {
        text = readFileSync(manifest, 'utf8');
    }
    catch {
        return '';
    }
    const out = [];
    for (const value of jsonValues(text)) {
        try {
            const v = index(value, 'version');
            if (truthy(v))
                out.push(jqRawText(v));
        }
        catch (e) {
            if (!(e instanceof JqError))
                throw e;
        }
    }
    return stripTrailingNewlines(out.join('\n'));
}
function usageValid(u) {
    return (STAMP.test(u.first) &&
        STAMP.test(u.last) &&
        [u.tokensIn, u.tokensOut, u.cacheRead, u.cacheCreation, u.toolUses].every((v) => /^[0-9]+$/.test(v)));
}
export function usageSql(db, sessionId, u, env) {
    const projectRoot = posixDirname(posixDirname(posixDirname(db)));
    const rootSql = dbLocation(projectRoot, env) === db ? `'${sqlQuote(projectRoot)}'` : 'NULL';
    const version = pluginVersion(env);
    const versionSql = version !== '' ? `'${sqlQuote(version)}'` : 'NULL';
    const session = sqlQuote(sessionId);
    const sessionRow = `agent_type = 'bro' AND task_id IS NULL AND session_id = '${session}'`;
    const duration = `MAX(0, CAST(ROUND((julianday('${u.last}') - julianday('${u.first}')) * 86400000) AS INTEGER))`;
    const model = `'${u.model}'`;
    return `
UPDATE agent_runs
   SET tokens_in             = ${u.tokensIn},
       tokens_out            = ${u.tokensOut},
       cache_read_tokens     = ${u.cacheRead},
       cache_creation_tokens = ${u.cacheCreation},
       tool_uses             = ${u.toolUses},
       started_at            = '${u.first}',
       completed_at          = '${u.last}',
       duration_ms           = ${duration},
       usage_source          = 'transcript',
       model                 = ${model},
       host                  = 'claude',
       root_dir              = COALESCE(${rootSql}, root_dir),
       exit_reason           = 'completed'
 WHERE ${sessionRow};

INSERT INTO agent_runs (agent_type, task_id, issue_id, session_id, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, started_at, completed_at, duration_ms,
                        usage_source, model, host, root_dir, exit_reason, plugin_version)
SELECT 'bro', NULL, NULL, '${session}', ${u.tokensIn}, ${u.tokensOut}, ${u.cacheRead}, ${u.cacheCreation}, ${u.toolUses},
       '${u.first}', '${u.last}', ${duration}, 'transcript', ${model}, 'claude', ${rootSql}, 'completed',
       ${versionSql}
 WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE ${sessionRow});
`;
}
export const broTurnUsage = (payload, env) => {
    if ((env.TMB_DISABLE_BRO_TURN_USAGE_HOOK ?? '0') === '1')
        return ALLOW;
    const db = dbPath(env) ?? '';
    if (db === '' || !isFile(db))
        return ALLOW;
    const input = commandSubstitution(payload);
    const sessionId = jqKeyOr(input, 'session_id', '');
    const transcript = jqKeyOr(input, 'transcript_path', '');
    if (sessionId === '' || transcript === '' || !isFile(transcript))
        return ALLOW;
    let text;
    try {
        text = readFileSync(transcript, 'utf8');
    }
    catch {
        return ALLOW;
    }
    const usage = turnUsage(text);
    if (usage === null || !usageValid(usage))
        return ALLOW;
    const r = dbWrite(db, usageSql(db, sessionId, usage, env), { env, caller: GATE_NAME });
    if (!r.ok) {
        process.stderr.write(`${r.error}\n`);
    }
    else {
        try {
            toolOutputSize(payload, { ...env, TMB_STOP_AGENT_TYPE: 'bro', TMB_STOP_SESSION_ID: sessionId });
        }
        catch {
            // The recorder never fails the gate.
        }
    }
    return { stdout: r.stdout, code: 0 };
};
//# sourceMappingURL=bro-turn-usage.js.map