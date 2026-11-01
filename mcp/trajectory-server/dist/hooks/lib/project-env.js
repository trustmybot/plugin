/**
 * The project-environment half of scripts/hooks/lib/query-task.sh (GH 1692):
 * the state host dir, the DB filename, the plugin name and the paths the .sh
 * reads from CLAUDE_PROJECT_DIR, HOME and the shell's working directory, each
 * resolved from the `env` a caller passes (process.env in a gate).
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { stringifyInOrder } from './jq-key-order.js';
export const TMB_STATE_HOST_DIR = '.claude';
export const TMB_DB_FILENAME = 'trajectory.db';
const DEFAULT_PLUGIN_NAME = 'tmb';
/** `dirname` as macOS prints it: "" → ".", "a/" → ".", "//a" → "/". */
export function posixDirname(path) {
    if (path === '')
        return '.';
    let p = path.replace(/\/+$/, '');
    if (p === '')
        return '/';
    const slash = p.lastIndexOf('/');
    if (slash < 0)
        return '.';
    p = p.slice(0, slash).replace(/\/+$/, '');
    return p === '' ? '/' : p;
}
/** `basename` as macOS prints it: "/" → "/", "a//" → "a", "" → "". */
export function posixBasename(path) {
    if (path === '')
        return '';
    const p = path.replace(/\/+$/, '');
    if (p === '')
        return '/';
    return p.slice(p.lastIndexOf('/') + 1);
}
/** jq -r's rendering of a non-null JSON value. */
export function jqRawText(value) {
    if (typeof value === 'string')
        return value;
    if (value !== null && typeof value === 'object')
        return stringifyInOrder(value, 2);
    return String(value);
}
/** tmb_plugin_name: `.name // "tmb"` of $CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json, else "tmb". */
export function pluginName(env = process.env) {
    const root = env.CLAUDE_PLUGIN_ROOT ?? '';
    return root === '' ? DEFAULT_PLUGIN_NAME : manifestName(`${root}/.claude-plugin/plugin.json`);
}
/**
 * tmb_resolve_plugin_name (scripts/lib/resolve-plugin-name.sh): as
 * pluginName, except that an unset or empty CLAUDE_PLUGIN_ROOT reads
 * /.claude-plugin/plugin.json.
 */
export function resolvePluginName(env = process.env) {
    return manifestName(`${env.CLAUDE_PLUGIN_ROOT ?? ''}/.claude-plugin/plugin.json`);
}
/** What a `$(...)` capture holds of <text>: NUL bytes dropped, trailing newlines stripped. */
export function commandSubstitution(text) {
    return text.replace(/\0/g, '').replace(/\n+$/, '');
}
function manifestName(manifest) {
    let text;
    try {
        if (!statSync(manifest).isFile())
            return DEFAULT_PLUGIN_NAME;
        text = readFileSync(manifest, 'utf8');
    }
    catch {
        return DEFAULT_PLUGIN_NAME;
    }
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return DEFAULT_PLUGIN_NAME;
        const name = parsed.name;
        return name === undefined || name === null || name === false ? DEFAULT_PLUGIN_NAME : jqRawText(name);
    }
    catch {
        return DEFAULT_PLUGIN_NAME;
    }
}
/** CLAUDE_PROJECT_DIR, or "" when unset. */
export function claudeProjectDir(env = process.env) {
    return env.CLAUDE_PROJECT_DIR ?? '';
}
/** $HOME, or "" when unset. */
export function homeDir(env = process.env) {
    return env.HOME ?? '';
}
function sameDir(a, b) {
    try {
        return realpathSync(a) === realpathSync(b);
    }
    catch {
        return false;
    }
}
/**
 * bash's `pwd`: the logical $PWD when it names the current directory, else
 * the physical one.
 */
export function shellPwd(env = process.env) {
    const cwd = process.cwd();
    const pwd = env.PWD ?? '';
    return pwd !== '' && isAbsolute(pwd) && sameDir(pwd, cwd) ? pwd : cwd;
}
/** <project>/.claude/<plugin>: the state dir a project's DB lives in. */
export function stateDirFor(root, env = process.env) {
    return `${root}/${TMB_STATE_HOST_DIR}/${pluginName(env)}`;
}
/** The install root: the ancestor of this module holding .claude-plugin/plugin.json. */
export function installRoot(fromDir) {
    let dir = fromDir;
    for (;;) {
        try {
            if (statSync(join(dir, '.claude-plugin', 'plugin.json')).isFile())
                return dir;
        }
        catch {
            /* keep walking */
        }
        const parent = posixDirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Whether LC_ALL / LC_CTYPE / LANG name an installed macOS UTF-8 locale
 * (en_US.UTF-8, UTF-8), under which wc and sed work on code points, not bytes.
 */
export function ctypeUtf8(env = process.env) {
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || 'C';
    return /(^|\.)utf-?8$/i.test(locale) && !locale.includes('/') && existsSync(`/usr/share/locale/${locale}/LC_CTYPE`);
}
const LOCALE_CATEGORIES = ['LC_COLLATE', 'LC_CTYPE', 'LC_MESSAGES', 'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME'];
function localeInstalled(name, category) {
    if (name === 'C' || name === 'POSIX')
        return true;
    return !name.includes('/') && existsSync(`/usr/share/locale/${name}/${category}`);
}
/**
 * Whether a macOS tool that calls setlocale(LC_ALL, "") (grep) runs with a
 * UTF-8 LC_CTYPE: every category's locale (LC_ALL, else LC_<category>, else
 * LANG, else C) must be installed, or the whole call fails and the tool runs
 * in C. A bare `LC_ALL=UTF-8` names a locale with only LC_CTYPE, so grep runs
 * in C under it.
 */
export function setlocaleUtf8(env = process.env) {
    const pick = (category) => env.LC_ALL || env[category] || env.LANG || 'C';
    if (!LOCALE_CATEGORIES.every((category) => localeInstalled(pick(category), category)))
        return false;
    return /(^|\.)utf-?8$/i.test(pick('LC_CTYPE'));
}
//# sourceMappingURL=project-env.js.map