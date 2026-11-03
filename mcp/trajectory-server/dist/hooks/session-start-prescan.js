/**
 * SessionStart hook (GH 1692), the port of scripts/hooks/session-start-prescan.sh:
 * the deterministic project inventory (plugin version, top-level dirs,
 * stacks, world model state, trajectory DB contracts, git state, open
 * issues, pending tasks, last commits) as additionalContext, plus the cold
 * world model, version skew, duplicate install and leftover user-hook notes.
 * A cold world model with tracked source files starts the deterministic
 * initial scan in the background unless TMB_SKIP_AUTO_PRESCAN=1. Without jq
 * it prints only the Tooling line; any failure exits 0 silently.
 *
 * Divergence: the .sh exits 0 silently without the sqlite3 CLI; this gate
 * reads the DB through node:sqlite.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW } from './gate.js';
import { dbPathAdvisory, dbReadBudget, haveSqlite, projectRoot, realdir, sqliteRo, stripTrailingNewlines } from './lib/db.js';
import { gitRun } from './lib/git.js';
import { byteCompare, commandOnPath } from './lib/host.js';
import { duplicateDisableCmds, duplicateInstalls, installPluginName, legacyHookEntries, legacyHookProjects, LEGACY_USER_HOOKS_DOC, legacyUserHooks, userSettingsJson, } from './lib/install.js';
import { jqCompact, jsonStream } from './lib/jq.js';
import { installRoot, jqRawText, posixBasename, posixDirname } from './lib/project-env.js';
import { localeCollates } from './lib/scope-fence.js';
export const GATE_NAME = 'session-start-prescan';
export const NO_JQ_LINE = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Tooling: jq not found — every TMB gate will deny until it is installed"}}\n';
const SUBDIR_STACKS_MAX = 3;
const TOPLEVEL_MAX = 10;
const WORLD_MODEL_STALE_SECS = 7n * 24n * 3600n;
const DOCTOR_BUDGET_DEFAULT = 1500n;
const DOCTOR_BUDGET_MAX = 3000n;
const NO_PROJECT = '(no project resolves)';
const SOURCE_EXCLUDED = /^(\.claude\/|node_modules\/|dist\/|build\/|\.git\/)/;
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function isDir(path) {
    if (path === '')
        return false;
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function order(s, pos) {
    if (pos === s.length)
        return -1;
    const c = s.charCodeAt(pos);
    if (c >= 48 && c <= 57)
        return 0;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))
        return c;
    if (c === 126)
        return -2;
    return c + 256;
}
function isDigit(s, pos) {
    const c = s.charCodeAt(pos);
    return c >= 48 && c <= 57;
}
function verrevcmp(a, alen, b, blen) {
    let i = 0;
    let j = 0;
    while (i < alen || j < blen) {
        let firstDiff = 0;
        while ((i < alen && !isDigit(a, i)) || (j < blen && !isDigit(b, j))) {
            const ac = order(a.slice(0, alen), i);
            const bc = order(b.slice(0, blen), j);
            if (ac !== bc)
                return ac - bc;
            i += 1;
            j += 1;
        }
        while (i < alen && a[i] === '0')
            i += 1;
        while (j < blen && b[j] === '0')
            j += 1;
        while (i < alen && j < blen && isDigit(a, i) && isDigit(b, j)) {
            if (firstDiff === 0)
                firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
            i += 1;
            j += 1;
        }
        if (i < alen && isDigit(a, i))
            return 1;
        if (j < blen && isDigit(b, j))
            return -1;
        if (firstDiff !== 0)
            return firstDiff;
    }
    return 0;
}
function prefixLen(s) {
    let prefix = 0;
    let i = 0;
    const alnum = (c) => /[A-Za-z0-9~]/.test(c);
    while (i < s.length) {
        i += 1;
        prefix = i;
        while (i + 1 < s.length && s[i] === '.' && /[A-Za-z~]/.test(s[i + 1])) {
            for (i += 2; i < s.length && alnum(s[i]); i += 1)
                ;
        }
    }
    return prefix;
}
/** gnulib filevercmp, which `sort -V` orders by. */
export function filevercmp(a, b) {
    if (a === b)
        return 0;
    if (a === '')
        return -1;
    if (b === '')
        return 1;
    if (a[0] === '.') {
        if (b[0] !== '.')
            return -1;
        const adot = a.length === 1;
        const bdot = b.length === 1;
        if (adot || bdot)
            return Number(bdot) - Number(adot);
        const a2 = a[1] === '.' && a.length === 2;
        const b2 = b[1] === '.' && b.length === 2;
        if (a2 || b2)
            return Number(b2) - Number(a2);
    }
    else if (b[0] === '.') {
        return 1;
    }
    const ap = prefixLen(a);
    const bp = prefixLen(b);
    const onePass = ap === a.length && bp === b.length;
    const r = verrevcmp(a, ap, b, bp);
    return r !== 0 || onePass ? r : verrevcmp(a, a.length, b, b.length);
}
/** `printf '%s\n%s\n' a b | sort -V | tail -1`. */
export function sortVMax(a, b) {
    const r = filevercmp(a, b) || byteCompare(a, b);
    return r > 0 ? a : b;
}
/** A dir's entries as bash's `<dir>/*<suffix>` glob orders them: no dotfiles, the locale's collation, else bytes. */
export function globNames(dir, env, suffix = '') {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const collator = localeCollates(env) ? new Intl.Collator('en') : null;
    const compare = (a, b) => {
        const x = a + suffix;
        const y = b + suffix;
        return (collator ? collator.compare(x, y) : 0) || byteCompare(x, y);
    };
    return names.filter((n) => !n.startsWith('.')).sort(compare);
}
function jqVersion(manifest) {
    let text;
    try {
        text = readFileSync(manifest, 'utf8');
    }
    catch {
        return '';
    }
    const out = [];
    for (const doc of jsonStream(text).values) {
        if (doc === null)
            continue;
        if (typeof doc !== 'object' || Array.isArray(doc))
            break;
        const v = doc.version;
        if (v !== undefined && v !== null && v !== false)
            out.push(jqRawText(v));
    }
    return stripTrailingNewlines(out.join('\n'));
}
function versionSkew(env) {
    const root = env.CLAUDE_PLUGIN_ROOT ?? '';
    const manifest = `${root}/.claude-plugin/plugin.json`;
    if (root === '' || !isFile(manifest))
        return { running: '', newer: '' };
    const running = jqVersion(manifest);
    const versionsDir = posixDirname(root);
    if (running === '' || !isDir(versionsDir))
        return { running, newer: '' };
    let highest = '';
    let names = [];
    try {
        names = readdirSync(versionsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    }
    catch {
        names = [];
    }
    for (const name of names) {
        if (!/^[0-9]/.test(name))
            continue;
        highest = highest === '' ? name : sortVMax(highest, name);
    }
    const newer = highest !== '' && highest !== running && sortVMax(running, highest) === highest ? highest : '';
    return { running, newer };
}
/** `IFS='|' read -r name path`: bash drops one trailing '|' when the rest holds no other. */
export function readPair(line) {
    const bar = line.indexOf('|');
    if (bar < 0)
        return { name: line, path: '' };
    const rest = line.slice(bar + 1);
    const path = rest.endsWith('|') && !rest.slice(0, -1).includes('|') ? rest.slice(0, -1) : rest;
    return { name: line.slice(0, bar), path };
}
function listRepos(db, root, env) {
    const rows = sqliteRo(db, "SELECT name || '|' || path FROM repos WHERE COALESCE(path, '') <> '' ORDER BY name;", env);
    if (rows === '')
        return root === '' ? [] : [readPair(`${posixBasename(root)}|${root}`)];
    return rows.split('\n').map((row) => {
        const { name, path: raw } = readPair(row);
        const path = raw.startsWith('/') ? raw : realdir(`${posixDirname(db)}/${raw}`);
        return readPair(`${name}|${path.endsWith('/') ? path.slice(0, -1) : path}`);
    });
}
function stacksIn(dir) {
    const has = (f) => isFile(`${dir}/${f}`);
    const out = [];
    if (has('package.json'))
        out.push('Node');
    if (has('pyproject.toml') || has('setup.py') || has('requirements.txt'))
        out.push('Python');
    if (has('go.mod'))
        out.push('Go');
    if (has('Cargo.toml'))
        out.push('Rust');
    if (has('Gemfile'))
        out.push('Ruby');
    if (has('composer.json'))
        out.push('PHP');
    return out;
}
function detectStacks(dir, env) {
    const root = stacksIn(dir);
    if (root.length > 0)
        return root.join(' ');
    const labels = [];
    let n = 0;
    for (const name of globNames(dir, env, '/')) {
        const sub = `${dir}/${name}/`;
        if (!isDir(sub))
            continue;
        for (const stack of stacksIn(sub)) {
            n += 1;
            if (n <= SUBDIR_STACKS_MAX)
                labels.push(`${stack} (${name}/)`);
        }
    }
    let s = labels.join(', ');
    if (n > SUBDIR_STACKS_MAX)
        s += `, +${n - SUBDIR_STACKS_MAX} more`;
    return s || '(none detected)';
}
/** `$(git -C <dir> <args> 2>/dev/null || echo <fallback>)`. */
async function gitOr(dir, args, fallback, env) {
    const r = await gitRun(dir, args, env);
    return stripTrailingNewlines(r.code === 0 ? r.stdout : `${r.stdout}${fallback}\n`);
}
function lineCount(text) {
    return text.split('\n').length - 1;
}
/** awk's records of <text>: newline-terminated lines, plus a last unterminated one. */
function records(text) {
    if (text === '')
        return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
function topLevel(root, env) {
    if (root === '' || !isDir(root))
        return NO_PROJECT;
    const names = globNames(root, env).filter((n) => isDir(`${root}/${n}`));
    return names
        .join(' ')
        .split(/[ \t\n]+/)
        .filter((w) => w !== '')
        .slice(0, TOPLEVEL_MAX)
        .join(' ');
}
function relativeAge(raw) {
    const secs = raw < 0n ? 0n : raw;
    if (secs < 60n)
        return 'just now';
    if (secs < 3600n)
        return `${secs / 60n}m ago`;
    if (secs < 86400n)
        return `${secs / 3600n}h ago`;
    return `${secs / 86400n}d ago`;
}
function worldModelLine(wmDirs, sourceFiles, scanRow) {
    const bar = scanRow.indexOf('|');
    const ageText = bar < 0 ? scanRow : scanRow.slice(0, bar);
    const scanned = bar < 0 ? scanRow : scanRow.slice(scanRow.lastIndexOf('|') + 1);
    if (wmDirs === '0')
        return `cold (no scan yet; ${sourceFiles} source files)`;
    if (!/^-?[0-9]+$/.test(ageText))
        return 'stale (last scan unknown) — run /scan';
    const age = BigInt(ageText);
    if (age < WORLD_MODEL_STALE_SECS)
        return `warm (${scanned} files, last scan ${relativeAge(age)})`;
    return `stale (last scan ${relativeAge(age)}) — run /scan`;
}
/** jq 1.7's `tonumber` rendering of a `^[0-9]+([.][0-9]+)?$` string: leading zeros dropped, the fraction kept. */
function decimalLiteral(text) {
    const [int, frac] = text.split('.');
    const whole = int.replace(/^0+(?=.)/, '');
    return frac === undefined ? whole : `${whole}.${frac}`;
}
function paramValue(raw, fallback) {
    const v = raw ?? '';
    if (/^[0-9]+([.][0-9]+)?$/.test(v) && Number(v) > 0)
        return decimalLiteral(v);
    return jqRawText(fallback);
}
/** The data-contract script session-start-prescan.sh builds with jq. */
export function contractScript(contracts, env) {
    const params = [
        ...new Set(contracts.flatMap((c) => (c.params ?? []).map((p) => `.parameter set :${p.name} ${paramValue(env[p.env], p.default)}`))),
    ].sort(byteCompare);
    return [
        "SELECT '__schema|' || COALESCE((SELECT schema_version FROM plugin_meta LIMIT 1), '');",
        ...params,
        ...contracts.map((c) => `SELECT '${c.id}|' || CASE WHEN (${c.sql}) ${c.expect.op} ${jqRawText(c.expect.value)} THEN 'ok' ELSE 'fail' END;`),
    ].join('\n');
}
function doctorBudget(raw) {
    const v = raw || String(DOCTOR_BUDGET_DEFAULT);
    if (!/^[0-9]+$/.test(v))
        return String(DOCTOR_BUDGET_DEFAULT);
    return BigInt(v) > DOCTOR_BUDGET_MAX ? String(DOCTOR_BUDGET_MAX) : v;
}
function doctorState(root, db, env) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(`${root}/scripts/hooks/lib/data-contracts.json`, 'utf8'));
    }
    catch {
        return 'unchecked (no contract list)';
    }
    const contracts = Array.isArray(doc.contracts) ? doc.contracts : [];
    const ids = contracts.flatMap((c) => jqRawText(c.id ?? null).split('\n')).filter((id) => id !== '');
    if (ids.length === 0)
        return 'unchecked (no contract list)';
    const requiredText = doc.schema_version === undefined || doc.schema_version === null || doc.schema_version === false ? '0' : jqRawText(doc.schema_version);
    const required = /^[0-9]+$/.test(requiredText) ? BigInt(requiredText) : 0n;
    const r = dbReadBudget(db, doctorBudget(env.TMB_DOCTOR_BUDGET_MS), contractScript(contracts, env), env);
    if (r.code === 124)
        return 'unchecked (timeout)';
    const lines = r.out.split('\n');
    const storedText = lines.find((l) => l.startsWith('__schema|'))?.slice('__schema|'.length) ?? '';
    const schemaNote = /^[0-9]+$/.test(storedText) && BigInt(storedText) < required
        ? `schema v${storedText} < v${required} — start the trajectory server to migrate`
        : '';
    const failed = [];
    let unchecked = 0;
    for (const id of ids) {
        const hit = lines.find((l) => l === `${id}|ok` || l === `${id}|fail`);
        if (hit === `${id}|ok`)
            continue;
        if (hit === `${id}|fail`)
            failed.push(id);
        else
            unchecked += 1;
    }
    if (failed.length > 0) {
        let state = `${failed.length} contract violation(s) [${failed.join(', ')}] — run trajectory_doctor`;
        if (unchecked > 0)
            state += ` (${unchecked} unchecked${schemaNote ? `: ${schemaNote}` : ''})`;
        else if (schemaNote)
            state += ` (${schemaNote})`;
        return state;
    }
    if (unchecked > 0 || schemaNote)
        return `unchecked (${schemaNote || 'read error'})`;
    return 'healthy';
}
function startInitialScan(invoker, db, env) {
    const child = spawn('node', ['--experimental-sqlite', invoker], {
        env: { ...env, TRAJECTORY_DB_PATH: db },
        detached: true,
        stdio: 'ignore',
    });
    child.on('error', () => undefined);
    child.unref();
}
function coldNote(root, db, env) {
    const invoker = `${root}/scripts/hooks/../maintenance/run-scan-initial.mjs`;
    if ((env.TMB_SKIP_AUTO_PRESCAN ?? '0') !== '1' && isFile(`${root}/scripts/scan.sh`) && isFile(invoker) && commandOnPath('node', env)) {
        startInitialScan(invoker, db, env);
        return 'world model was cold — a deterministic scan is running in the background; re-read world_model_get before planning';
    }
    return 'world model is cold — run /scan before planning so world_model_get has a project map';
}
function pluginRoot() {
    return installRoot(posixDirname(fileURLToPath(import.meta.url))) ?? '';
}
/** The prescan as a function of its env, the plugin root it reads scripts from, and its stderr. */
export async function sessionStartPrescanRun(env, root, stderr) {
    if (!commandOnPath('jq', env))
        return { stdout: NO_JQ_LINE, code: 0 };
    const db = dbPathAdvisory(GATE_NAME, env, (line) => stderr(`${line}\n`));
    if (db === null)
        return ALLOW;
    if (!haveSqlite(env) || !commandOnPath('git', env))
        return ALLOW;
    const skew = versionSkew(env);
    const project = projectRoot(env);
    const repos = listRepos(db, project, env);
    const repoN = repos.length;
    const stacks = [];
    const branches = [];
    const last5 = [];
    for (const { name, path } of repos) {
        if (name === '')
            continue;
        if (!isDir(path)) {
            stacks.push(`${name}: missing (${path})`);
            branches.push(`${name}: missing (${path})`);
            continue;
        }
        stacks.push(`${name}: ${detectStacks(path, env)}`);
        const branch = await gitOr(path, ['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown', env);
        const commits = await gitOr(path, ['rev-list', '--count', 'HEAD'], '0', env);
        const dirty = lineCount((await gitRun(path, ['status', '--porcelain'], env)).stdout);
        branches.push(`${name}: ${branch} (${commits} commits, ${dirty} dirty paths)`);
        const prefix = repoN > 1 ? `  [${name}] ` : '  ';
        const log = records((await gitRun(path, ['log', '--oneline', '-5'], env)).stdout).map((l) => `${prefix}${l}`);
        if (log.length > 0)
            last5.push(log.join('\n'));
    }
    const counts = sqliteRo(db, "SELECT\n  (SELECT COUNT(*) FROM issues WHERE status='open'),\n  (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running'));", env).split('\n')[0];
    const [openIssues = '', pendingTasks = ''] = counts.split('|');
    const wmRaw = sqliteRo(db, 'SELECT COUNT(*) FROM wm_directories;', env);
    const wmDirs = /^[0-9]+$/.test(wmRaw) ? wmRaw : '0';
    let sourceFiles = 0;
    for (const { name, path } of repos) {
        if (name === '' || !isDir(path))
            continue;
        sourceFiles += records((await gitRun(path, ['ls-files'], env)).stdout).filter((l) => !SOURCE_EXCLUDED.test(l)).length;
    }
    const scanRow = sqliteRo(db, "SELECT CAST(strftime('%s','now') - strftime('%s', MAX(last_scanned_at)) AS INTEGER), COALESCE(SUM(file_count), 0) FROM repos;", env);
    const worldModel = worldModelLine(wmDirs, sourceFiles, scanRow);
    const cold = wmDirs === '0' && sourceFiles !== 0 ? coldNote(root, db, env) : '';
    const doctor = doctorState(root, db, env);
    let suffix = cold === '' ? '' : `\n${cold}`;
    if (skew.newer !== '') {
        suffix += `\nnewer plugin version ${skew.newer} is installed but ${skew.running} is still running — fully quit and relaunch Claude Code to apply`;
    }
    const dups = duplicateInstalls(projectRoot(env), env);
    if (dups.length > 0) {
        const marketplaces = dups
            .map((r) => r.marketplace)
            .join(',')
            .replaceAll(',', ', ');
        suffix += `\nPlugin: duplicate ${installPluginName(env)} copies enabled (${marketplaces}) — hooks from one are dropped; keep one and disable the others from the project root (${duplicateDisableCmds(dups, env)}), then fully quit and relaunch Claude Code`;
    }
    const legacy = legacyUserHooks(projectRoot(env), env);
    if (legacy.hooks.length > 0) {
        const projects = legacyHookProjects(legacy.projects);
        suffix += `\nPlugin: ${userSettingsJson(env)} holds ${legacy.hooks.length} pre-1.1.0 TMB hook(s) (${legacyHookEntries(legacy.hooks)}) — they run in every project and can deny what this version allows; the Human removes them by hand, see ${LEGACY_USER_HOOKS_DOC}${projects ? `; projects on TMB < 1.1.0 lose them too: ${projects}` : ''}`;
    }
    const inventory = stripTrailingNewlines([
        '=== Project Inventory (auto, deterministic) ===',
        `Plugin version:    ${skew.running || '(unknown)'}`,
        `Top-level dirs:    ${topLevel(project, env)}`,
        `Stacks detected:   ${stacks.join('; ') || NO_PROJECT}`,
        `World model:       ${worldModel}`,
        `Trajectory DB:     ${doctor}`,
        `Git branch:        ${branches.join('; ') || NO_PROJECT}`,
        `Open issues:       ${openIssues || '0'}`,
        `Pending tasks:     ${pendingTasks || '0'}`,
        'Last 5 commits:',
        last5.join('\n'),
        `================================================${suffix}`,
    ].join('\n'));
    return { stdout: `${jqCompact({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: inventory } })}\n`, code: 0 };
}
export const sessionStartPrescan = async (_payload, env) => {
    try {
        return await sessionStartPrescanRun(env, pluginRoot(), (text) => process.stderr.write(text));
    }
    catch {
        return ALLOW;
    }
};
//# sourceMappingURL=session-start-prescan.js.map