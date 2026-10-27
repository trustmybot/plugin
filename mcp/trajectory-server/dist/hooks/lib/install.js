/**
 * TypeScript port of the install readers of scripts/hooks/lib/resolve-install.sh
 * (GH 1692): this plugin's installs recorded in installed_plugins.json, by
 * scope, and the enabled copies of it that apply to a project. The .sh's jq
 * filters keep jq 1.7's stream semantics (each JSON value of a file runs on
 * its own; an index error ends that value's rows), its rows stay @tsv-escaped
 * as `read -r` leaves them, and its sorts compare bytes (LC_ALL=C order).
 */
import { readFileSync, statSync } from 'node:fs';
import { realdir, stripTrailingNewlines } from './db.js';
import { byteCompare } from './host.js';
import { jsonStream } from './jq.js';
import { homeDir, pluginName, posixBasename } from './project-env.js';
const DEFAULT_NAME = 'tmb';
class JqError extends Error {
}
/** _tmb_install_plugin_name: the manifest's `.name`, else "tmb". */
export function installPluginName(env = process.env) {
    return stripTrailingNewlines(pluginName(env)) || DEFAULT_NAME;
}
function configDir(env) {
    return env.CLAUDE_CONFIG_DIR || `${homeDir(env)}/.claude`;
}
/** tmb_installed_json. */
export function installedJson(env = process.env) {
    return env.TMB_INSTALLED_JSON || `${configDir(env)}/plugins/installed_plugins.json`;
}
/** _tmb_canonical_dir: `cd <dir> && pwd -P`, else <dir> as given. */
export function canonicalDir(dir) {
    return realdir(dir);
}
function isDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function readText(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
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
function field(value, fallback) {
    return typeof value === 'string' && value !== '' ? value : fallback;
}
/** jq's @tsv escaping of one field. */
export function tsvEscape(text) {
    return text.replace(/[\\\t\n\r]/g, (c) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[c] ?? c);
}
/** `(.plugins // {}) | to_entries[] | select(.key | startswith(<prefix>))`, entry by entry. */
function* pluginEntries(doc, prefix) {
    let plugins = index(doc, 'plugins');
    if (plugins === null || plugins === false)
        plugins = {};
    if (Array.isArray(plugins)) {
        if (plugins.length > 0)
            throw new JqError('startswith on a number');
        return;
    }
    if (typeof plugins !== 'object')
        throw new JqError('has no keys');
    for (const [key, value] of Object.entries(plugins)) {
        if (key.startsWith(prefix))
            yield [key, value];
    }
}
/** `.value[]?`: an object's values or an array's elements, nothing for anything else. */
function elements(value) {
    if (Array.isArray(value))
        return value;
    if (value !== null && typeof value === 'object')
        return Object.values(value);
    return [];
}
/** Runs <rows> on each JSON value of <path>, keeping the rows a value gave before an index error. */
function jqRows(path, rows) {
    const text = readText(path);
    if (text === null)
        return [];
    const out = [];
    for (const doc of jsonStream(text).values) {
        try {
            rows(doc, (row) => out.push(row));
        }
        catch (e) {
            if (!(e instanceof JqError))
                throw e;
        }
    }
    return out;
}
/** tmb_install_candidates: every install of this plugin whose installPath is a dir. */
export function installCandidates(env = process.env) {
    const json = installedJson(env);
    try {
        if (!statSync(json).isFile())
            return [];
    }
    catch {
        return [];
    }
    const prefix = `${installPluginName(env)}@`;
    const raw = jqRows(json, (doc, push) => {
        for (const [, value] of pluginEntries(doc, prefix)) {
            for (const e of elements(value)) {
                push([
                    field(index(e, 'scope'), 'user'),
                    field(index(e, 'projectPath'), '-'),
                    field(index(e, 'installPath'), '-'),
                    field(index(e, 'installedAt'), '-'),
                    field(index(e, 'version'), '-'),
                ].map(tsvEscape));
            }
        }
    });
    const out = [];
    for (const [scope, project, install, at, version] of raw) {
        if (install === '-' || !isDir(install))
            continue;
        out.push({ scope, project: project === '-' ? project : canonicalDir(project), install, at, version });
    }
    return out;
}
function rowLine(r) {
    return [r.scope, r.project, r.install, r.at, r.version].join('\t');
}
/** `sort -t$'\t' -k4,4r`: installedAt descending, then the whole line ascending. */
function newestFirst(rows) {
    return [...rows].sort((a, b) => byteCompare(b.at, a.at) || byteCompare(rowLine(a), rowLine(b)));
}
/** tmb_project_installs: project/local installs for CLAUDE_PROJECT_DIR, newest first. */
export function projectInstalls(env = process.env) {
    const project = env.CLAUDE_PROJECT_DIR ?? '';
    if (project === '')
        return [];
    const here = canonicalDir(project);
    return newestFirst(installCandidates(env).filter((r) => (r.scope === 'project' || r.scope === 'local') && r.project === here));
}
/** tmb_user_installs: user-scope installs, newest first. */
export function userInstalls(env = process.env) {
    return newestFirst(installCandidates(env).filter((r) => r.scope === 'user'));
}
/** The mcp-health-check notice's install_version: the version, else the installPath's basename. */
export function installVersion(row) {
    return row.version !== '' && row.version !== '-' ? row.version : posixBasename(row.install);
}
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
/** The merged enabledPlugins of the user, project and local settings files, later files winning. */
function enabledPlugins(here, env) {
    const merged = {};
    for (const file of [`${configDir(env)}/settings.json`, `${here}/.claude/settings.json`, `${here}/.claude/settings.local.json`]) {
        for (const part of jqRows(file, (doc, push) => {
            let v = index(doc, 'enabledPlugins');
            if (v === null || v === false)
                v = {};
            push(isObject(v) ? v : {});
        })) {
            for (const [k, v] of Object.entries(part)) {
                delete merged[k];
                merged[k] = v;
            }
        }
    }
    return merged;
}
/** tmb_duplicate_installs <project>: the enabled copies applying to <project>, when there are two or more. */
export function duplicateInstalls(project, env = process.env) {
    if (project === '')
        return [];
    const name = installPluginName(env);
    const here = canonicalDir(project);
    const on = enabledPlugins(here, env);
    const prefix = `${name}@`;
    const raw = jqRows(installedJson(env), (doc, push) => {
        for (const [key, value] of pluginEntries(doc, prefix)) {
            if (on[key] !== true)
                continue;
            for (const e of elements(value)) {
                push([
                    key,
                    field(index(e, 'scope'), 'user'),
                    field(index(e, 'projectPath'), '-'),
                    field(index(e, 'installPath'), '-'),
                    field(index(e, 'version'), '-'),
                ].map(tsvEscape));
            }
        }
    });
    const ranked = [];
    for (const [key, scope, proj, install, version] of raw) {
        let rank = 1;
        if (scope === 'project' || scope === 'local') {
            if (proj === '-' || canonicalDir(proj) !== here)
                continue;
            rank = 0;
        }
        const at = key.indexOf('@');
        const mkt = at < 0 ? key : key.slice(at + 1);
        ranked.push({
            line: [mkt, String(rank), version, install, scope].join('\t'),
            mkt,
            rank,
            row: { marketplace: mkt, version, install, scope },
        });
    }
    ranked.sort((a, b) => byteCompare(a.mkt, b.mkt) || a.rank - b.rank || byteCompare(a.line, b.line));
    const seen = new Set();
    const rows = ranked.filter((r) => !seen.has(r.mkt) && seen.add(r.mkt)).map((r) => r.row);
    return rows.length > 1 ? rows : [];
}
/** tmb_duplicate_installs_names: "a@1.0.1, b@1.0.2". */
export function duplicateNames(rows) {
    return rows.map((r) => `${r.marketplace}@${r.version}`).join(', ');
}
/** tmb_duplicate_installs_disable_cmds: one `claude plugin disable` per copy, at its own scope. */
export function duplicateDisableCmds(rows, env = process.env) {
    const name = installPluginName(env);
    return rows.map((r) => `claude plugin disable ${name}@${r.marketplace} --scope ${r.scope}`).join('; ');
}
//# sourceMappingURL=install.js.map