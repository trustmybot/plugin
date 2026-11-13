/**
 * `cli.js heal-mcp-cache` (GH 1692): interactive remediation for the CC plugin
 * MCP-config cache bug (issue #2888), ported from the former maintenance
 * shell script. Bundled into dist/cli.js, so it runs from the plugin cache
 * with node built-ins only.
 *
 * Three independent recovery steps:
 *   Step A — clear per-project `disabledMcpServers["plugin:tmb:trajectory-server"]`
 *            entries from ~/.claude.json. CC writes this flag when a user
 *            disables an MCP server through CC's UI; it persists across plugin
 *            re-enable, plugin updates, full CC restarts, and rm -rf .claude/.
 *            The plugin cannot read or write this — CC-owned state.
 *   Step C — cache GC (#602): prune stale cached versions under
 *            ~/.claude/plugins/cache/<owner>/<plugin>/<version>, keeping only
 *            the ACTIVE (from installed_plugins.json) + the single PREVIOUS
 *            version. The active version is never removed.
 *   Step B — nuke ~/.claude/plugins/cache/<marketplace-owner>/ + remove plugin entries
 *            from installed_plugins.json. The Mode A recovery doctrine for
 *            CC's plugin-cache bug.
 *
 * Each mutating step has its own y/N prompt. Step A is the lighter, more common
 * fix and defaults to y; Step C prunes conservatively; Step B is the most
 * aggressive and defaults to N. End of input at a prompt exits 1.
 * Pass --dry-run to preview every step: each prints what it would do, no
 * prompt is shown and nothing is written.
 * Idempotent: re-runs see nothing to do and exit 0.
 * Run from a terminal: inside Claude Code (CLAUDE_PROJECT_DIR or
 * CLAUDE_PLUGIN_ROOT set) it refuses and changes nothing.
 *
 * Exit 0 on success or a skipped step, 1 when refused, when no tmb install is
 * found or at end of input, 2 on an unknown channel or several installed
 * channels without --channel.
 */
import { chmodSync, copyFileSync, lstatSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { pgrepProbe } from './health.js';
const PLUGIN_NAME = 'tmb';
const MCP_SERVER_KEY = 'plugin:tmb:trajectory-server';
const SCOPE_DOC = 'docs/architecture/INSTALL.md#recommended-scope-project-or-local';
class EndOfInput extends Error {
}
function isObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function isDir(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch {
        return false;
    }
}
function readJson(path) {
    try {
        return { ok: true, doc: JSON.parse(readFileSync(path, 'utf8')) };
    }
    catch {
        return { ok: false };
    }
}
function rawText(v) {
    return typeof v === 'string' ? v : JSON.stringify(v);
}
/** One line from stdin, read synchronously; EndOfInput when stdin ends before a newline (bash `read -r` under `set -e`). */
function stdinLines() {
    let pending = Buffer.alloc(0);
    let ended = false;
    const chunk = Buffer.alloc(4096);
    return () => {
        for (;;) {
            const nl = pending.indexOf(10);
            if (nl >= 0) {
                const line = pending.subarray(0, nl).toString('utf8');
                pending = pending.subarray(nl + 1);
                return line;
            }
            if (ended)
                throw new EndOfInput();
            let n = 0;
            try {
                n = readSync(0, chunk, 0, chunk.length, null);
            }
            catch (e) {
                if (e.code === 'EAGAIN') {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
                    continue;
                }
                n = 0;
            }
            if (n === 0)
                ended = true;
            else
                pending = Buffer.concat([pending, chunk.subarray(0, n)]);
        }
    };
}
function isAlpha(c) {
    return /^[A-Za-z]$/.test(c);
}
function isDigit(c) {
    return c !== undefined && c >= '0' && c <= '9';
}
/** gnulib file_prefixlen: the length of s without its trailing `.alpha…` suffixes. */
function filePrefixLen(s) {
    const n = s.length;
    let prefixLen = 0;
    for (let i = 0;;) {
        if (i === n)
            return prefixLen;
        i += 1;
        prefixLen = i;
        while (i + 1 < n && s[i] === '.' && (isAlpha(s[i + 1]) || s[i + 1] === '~')) {
            for (i += 2; i < n && (/^[A-Za-z0-9]$/.test(s[i]) || s[i] === '~'); i += 1)
                ;
        }
    }
}
function order(s, pos, len) {
    if (pos === len)
        return -1;
    const c = s[pos];
    if (isDigit(c))
        return 0;
    if (isAlpha(c))
        return c.charCodeAt(0);
    if (c === '~')
        return -2;
    return c.charCodeAt(0) + 256;
}
/** gnulib verrevcmp over s1[0, len1) and s2[0, len2). */
function verrevcmp(s1, len1, s2, len2) {
    let p1 = 0;
    let p2 = 0;
    while (p1 < len1 || p2 < len2) {
        let firstDiff = 0;
        while ((p1 < len1 && !isDigit(s1[p1])) || (p2 < len2 && !isDigit(s2[p2]))) {
            const c1 = order(s1, p1, len1);
            const c2 = order(s2, p2, len2);
            if (c1 !== c2)
                return c1 - c2;
            p1 += 1;
            p2 += 1;
        }
        while (p1 < len1 && s1[p1] === '0')
            p1 += 1;
        while (p2 < len2 && s2[p2] === '0')
            p2 += 1;
        while (p1 < len1 && p2 < len2 && isDigit(s1[p1]) && isDigit(s2[p2])) {
            if (firstDiff === 0)
                firstDiff = s1.charCodeAt(p1) - s2.charCodeAt(p2);
            p1 += 1;
            p2 += 1;
        }
        if (p1 < len1 && isDigit(s1[p1]))
            return 1;
        if (p2 < len2 && isDigit(s2[p2]))
            return -1;
        if (firstDiff !== 0)
            return firstDiff;
    }
    return 0;
}
/** `sort -V` order: gnulib filevercmp, ties broken bytewise. */
export function versionCompare(a, b) {
    if (a === b)
        return 0;
    if (a === '')
        return -1;
    if (b === '')
        return 1;
    const aPrefix = filePrefixLen(a);
    const bPrefix = filePrefixLen(b);
    let result = verrevcmp(a, aPrefix, b, bPrefix);
    if (result === 0 && !(aPrefix === a.length && bPrefix === b.length))
        result = verrevcmp(a, a.length, b, b.length);
    if (result !== 0)
        return result;
    return a < b ? -1 : 1;
}
/** Subdirectory names in the order bash's trailing-slash glob lists them: each name sorted with its trailing slash. */
function subdirs(dir, followLinks) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => {
        if (followLinks && name.startsWith('.'))
            return false;
        try {
            return (followLinks ? statSync(`${dir}/${name}`) : lstatSync(`${dir}/${name}`)).isDirectory();
        }
        catch {
            return false;
        }
    })
        .sort((a, b) => Buffer.compare(Buffer.from(`${a}/`), Buffer.from(`${b}/`)));
}
function installedChannels(installedJson) {
    if (!isFile(installedJson))
        return [];
    const read = readJson(installedJson);
    if (!read.ok || !isObject(read.doc) || !isObject(read.doc.plugins))
        return [];
    return Object.keys(read.doc.plugins)
        .sort()
        .filter((key) => key.startsWith('tmb@'));
}
function parseArgs(argv) {
    let channel = '';
    let dryRun = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg.startsWith('--channel='))
            channel = arg.slice('--channel='.length);
        else if (arg === '--channel') {
            i += 1;
            if (i < argv.length)
                channel = argv[i];
        }
        else if (arg === '--dry-run')
            dryRun = true;
    }
    return { channel, dryRun };
}
/** jq's `.projects | to_entries | map(select(disabledMcpServers has key)) | .[].key`; any jq error yields none. */
function disabledProjects(config) {
    if (!isObject(config))
        return [];
    const projects = config.projects;
    if (!isObject(projects))
        return [];
    const hits = [];
    for (const [path, value] of Object.entries(projects)) {
        if (value !== null && !isObject(value))
            return [];
        const list = isObject(value) ? value.disabledMcpServers : undefined;
        if (Array.isArray(list) && list.includes(MCP_SERVER_KEY))
            hits.push(path);
    }
    return hits;
}
function utcStamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
function writeJsonAtomically(path, doc) {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(tmp, path);
}
function stepA(io, ask, ccConfig, dryRun) {
    io.out('--- Step A: per-project disabledMcpServers flags in ~/.claude.json ---\n\n');
    if (!isFile(ccConfig)) {
        io.out(`  ${ccConfig} not found — skipping Step A.\n\n`);
        return;
    }
    const read = readJson(ccConfig);
    if (!read.ok || !isObject(read.doc) || !Object.hasOwn(read.doc, 'projects')) {
        io.out(`  No .projects key in ${ccConfig} — skipping Step A.\n\n`);
        return;
    }
    const projects = disabledProjects(read.doc);
    if (projects.length === 0) {
        io.out(`  No projects have ${MCP_SERVER_KEY} in disabledMcpServers.\n`);
        io.out('  No disabled-MCP flags to clear; skipping.\n\n');
        return;
    }
    io.out('  Projects with trajectory-server disabled:\n');
    for (const p of projects)
        io.out(`    ${p}\n`);
    io.out(`\n  Would: for each above, remove "${MCP_SERVER_KEY}" from .projects."<path>".disabledMcpServers\n`);
    io.out('         (preserves every other disabled server + other keys).\n\n');
    if (dryRun) {
        io.out(`  [dry-run] Step A would: back up ${ccConfig} to ${ccConfig}.bak.<timestamp>, then remove "${MCP_SERVER_KEY}" from .projects."<path>".disabledMcpServers for:\n`);
        for (const p of projects)
            io.out(`    ${p}\n`);
        io.out('\n');
        return;
    }
    const answer = ask('  Proceed with Step A? (Y/n) ');
    if (['n', 'N', 'no', 'NO'].includes(answer)) {
        io.out('  Skipped Step A.\n\n');
        return;
    }
    const backup = `${ccConfig}.bak.${utcStamp()}`;
    const st = statSync(ccConfig);
    copyFileSync(ccConfig, backup);
    chmodSync(backup, st.mode & 0o7777);
    utimesSync(backup, st.atime, st.mtime);
    io.out(`  Backup: ${backup}\n`);
    for (const p of projects) {
        const doc = JSON.parse(readFileSync(ccConfig, 'utf8'));
        const current = doc.projects[p].disabledMcpServers;
        doc.projects[p].disabledMcpServers = (Array.isArray(current) ? current : []).filter((s) => s !== MCP_SERVER_KEY);
        writeJsonAtomically(ccConfig, doc);
        io.out(`  Cleaned: ${p}\n`);
    }
    io.out('\n');
}
function activeVersion(installedJson, entry) {
    if (!isFile(installedJson))
        return '';
    const read = readJson(installedJson);
    if (!read.ok || !isObject(read.doc) || !isObject(read.doc.plugins))
        return '';
    const records = read.doc.plugins[entry];
    if (!Array.isArray(records))
        return '';
    for (const r of records) {
        const v = isObject(r) ? r.version : undefined;
        if (v === undefined || v === null || v === 'unknown')
            continue;
        return v === false ? '' : rawText(v);
    }
    return '';
}
function stepC(io, ask, versionsDir, installedJson, entry, dryRun) {
    io.out('--- Step C: cache GC — prune stale cached versions (keep active + previous) ---\n\n');
    let active = activeVersion(installedJson, entry);
    if (!isDir(versionsDir)) {
        io.out(`  No version cache at ${versionsDir} — nothing to GC.\n\n`);
        return;
    }
    const sorted = subdirs(versionsDir, false)
        .filter((name) => isDigit(name[0]))
        .sort(versionCompare);
    if (sorted.length === 0) {
        io.out(`  No semver version dirs under ${versionsDir} — nothing to GC.\n\n`);
        return;
    }
    if (active === '') {
        active = sorted[sorted.length - 1];
        io.out(`  (no active version in installed_plugins — treating highest cached ${active} as active)\n`);
    }
    let previous = '';
    for (const v of sorted)
        if (v !== active && versionCompare(v, active) < 0)
            previous = v;
    const prune = sorted.filter((v) => v !== active && v !== previous);
    io.out(`  cache dir:        ${versionsDir}\n`);
    io.out(`  cached versions:  ${sorted.join(' ')}\n`);
    io.out(`  active (keep):    ${active}\n`);
    io.out(`  previous (keep):  ${previous || '(none)'}\n`);
    if (prune.length === 0) {
        io.out('  Nothing to prune — only active + previous are cached.\n\n');
        return;
    }
    io.out(`\n  Would remove ${prune.length} stale version(s):\n`);
    for (const v of prune)
        io.out(`    rm -rf ${versionsDir}/${v}\n`);
    if (dryRun) {
        io.out(`\n  [dry-run] Step C would: rm -rf${prune.map((v) => ` ${versionsDir}/${v}`).join('')}\n\n`);
        return;
    }
    const answer = ask('\n  Proceed with Step C prune? (Y/n) ');
    if (['n', 'N', 'no', 'NO'].includes(answer)) {
        io.out('  Skipped Step C.\n\n');
        return;
    }
    for (const v of prune) {
        if (v === active || v === '')
            continue;
        rmSync(`${versionsDir}/${v}`, { recursive: true, force: true });
        io.out(`  Removed ${versionsDir}/${v}\n`);
    }
    io.out('\n');
}
function reinstallHint(io, entry, installScope) {
    io.out(`  1. From the project root: claude plugin install ${entry} --scope ${installScope}\n`);
    io.out(`     (scope rule: ${SCOPE_DOC})\n`);
    io.out('  2. Launch Claude Code.\n');
    io.out(`  3. Verify with: tail -1 <project>/.claude/${PLUGIN_NAME}/logs/mcp-health.log\n`);
    io.out('     (expect mcp_alive:true)\n');
}
function jqLength(v) {
    if (Array.isArray(v) || typeof v === 'string')
        return v.length;
    if (isObject(v))
        return Object.keys(v).length;
    if (typeof v === 'number')
        return Math.abs(v);
    return 0;
}
function stepB(io, ask, env, paths, entry, installScope, dryRun) {
    const { cacheDir, installedJson } = paths;
    io.out('--- Step B: plugin cache + installed_plugins.json ---\n\n');
    const cacheExists = isDir(cacheDir);
    const manifestExists = isFile(installedJson);
    let total = 0;
    let matching = 0;
    let recordedScope = '';
    if (manifestExists) {
        const read = readJson(installedJson);
        const plugins = read.ok && isObject(read.doc) ? read.doc.plugins : undefined;
        total = jqLength(plugins);
        if (isObject(plugins) && Object.hasOwn(plugins, entry)) {
            matching = 1;
            const records = plugins[entry];
            if (Array.isArray(records)) {
                const scope = records.map((r) => (isObject(r) ? r.scope : undefined)).find((s) => s !== undefined && s !== null && s !== false);
                if (scope !== undefined)
                    recordedScope = rawText(scope);
            }
        }
    }
    const uninstallScope = recordedScope === 'project' || recordedScope === 'local' ? recordedScope : installScope;
    io.out('Discovered state:\n');
    io.out(`  cache dir:           ${cacheDir} (${cacheExists ? 'yes' : 'no'})\n`);
    if (manifestExists) {
        io.out(`  installed_plugins:   ${installedJson}\n`);
        io.out(`  total entries:       ${total}\n`);
        io.out(`  matching "${entry}": ${matching}\n`);
    }
    else {
        io.out(`  installed_plugins:   ${installedJson} (missing)\n`);
    }
    if (cacheExists) {
        io.out(`\nCache subdirectories under ${cacheDir}:\n`);
        for (const name of subdirs(cacheDir, true)) {
            const versions = subdirs(`${cacheDir}/${name}`, true);
            io.out(`  ${name}: ${versions.length > 0 ? versions.join(' ') : '(empty)'}\n`);
        }
    }
    const { count } = pgrepProbe(env);
    io.out(count === '-1' ? '\ntrajectory-server processes: unknown (pgrep missing)\n' : `\ntrajectory-server processes: ${count}\n`);
    if (!cacheExists && matching === 0) {
        io.out(`\n  Nothing to nuke — cache dir already gone and no ${entry} entry in installed_plugins.json.\n`);
        io.out('  Skipping Step B.\n\n');
        io.out('Done. To reinstall:\n');
        reinstallHint(io, entry, installScope);
        return 0;
    }
    const jqDel = `jq "del(.plugins["${entry}"])" ${installedJson}`;
    io.out('\nDry-run — would remove:\n');
    if (cacheExists)
        io.out(`  rm -rf ${cacheDir}\n`);
    if (matching > 0)
        io.out(`  ${jqDel}   (${matching} entries)\n`);
    if (dryRun) {
        io.out(`\n[dry-run] Step B would:${cacheExists ? ` rm -rf ${cacheDir};` : ''}${matching > 0 ? ` ${jqDel}` : ''}\n`);
        io.out('\n--dry-run: nothing was changed. Re-run without --dry-run to apply.\n');
        return 0;
    }
    const answer = ask('\nProceed with Step B (cache nuke)? (y/N) ');
    if (!['y', 'Y', 'yes', 'YES'].includes(answer)) {
        io.out('\nSkipped Step B. Manual recovery options:\n');
        io.out('  1. claude --plugin-dir <plugin-source-path>   (cache-bust via inline)\n');
        io.out(`  2. From the project root: claude plugin uninstall ${entry} --scope ${uninstallScope}, then reinstall with: claude plugin install ${entry} --scope ${installScope}\n`);
        io.out(`     (scope rule: ${SCOPE_DOC})\n`);
        io.out('  3. Re-run this script and answer y to Step B.\n');
        return 0;
    }
    if (cacheExists) {
        rmSync(cacheDir, { recursive: true, force: true });
        io.out(`Removed ${cacheDir}\n`);
    }
    if (matching > 0) {
        const doc = JSON.parse(readFileSync(installedJson, 'utf8'));
        delete doc.plugins[entry];
        writeJsonAtomically(installedJson, doc);
        io.out(`Removed ${matching} entries from ${installedJson}\n`);
    }
    io.out('\nDone. To reinstall:\n');
    reinstallHint(io, entry, installScope);
    return 0;
}
export function healMcpCache(argv, env, io) {
    if ((env.CLAUDE_PROJECT_DIR ?? '') !== '' || (env.CLAUDE_PLUGIN_ROOT ?? '') !== '') {
        io.err('Refusing to run inside Claude Code: this script edits ~/.claude.json\n');
        io.err('(which Claude Code reads on every prompt) and the plugins cache.\n');
        io.err('Quit Claude Code first, then run it from a regular terminal.\n');
        return 1;
    }
    const home = env.HOME ?? homedir();
    const installedJson = `${home}/.claude/plugins/installed_plugins.json`;
    const ccConfig = `${home}/.claude.json`;
    const detected = installedChannels(installedJson);
    const { channel, dryRun } = parseArgs(argv);
    let entry;
    if (channel !== '') {
        if (channel === 'stable')
            entry = 'tmb@trustmybot';
        else if (channel === 'rc' || channel === 'dev')
            entry = `tmb@trustmybot-${channel}`;
        else {
            io.err(`Unknown channel: ${channel}\n`);
            io.err('Pass --channel stable|rc|dev.\n');
            return 2;
        }
    }
    else if (detected.length === 1) {
        entry = detected[0];
    }
    else if (detected.length > 1) {
        io.err(`Multiple tmb channels installed: ${detected.join(' ')}\n`);
        io.err('Pass --channel stable|rc|dev to choose.\n');
        return 2;
    }
    else {
        io.err(`No tmb installation found in ${installedJson}\n`);
        io.err('Pass --channel stable|rc|dev to specify explicitly.\n');
        return 1;
    }
    const owner = entry.slice(entry.indexOf('@') + 1);
    const cacheDir = `${home}/.claude/plugins/cache/${owner}`;
    const installScope = owner === 'trustmybot' ? 'project' : 'local';
    const readLine = stdinLines();
    const ask = (prompt) => {
        io.out(prompt);
        return readLine().replace(/^[ \t]+|[ \t]+$/g, '');
    };
    io.out('=== TMB MCP-cache heal — issue #2888 ===\n\n');
    try {
        stepA(io, ask, ccConfig, dryRun);
        stepC(io, ask, `${cacheDir}/${PLUGIN_NAME}`, installedJson, entry, dryRun);
        return stepB(io, ask, env, { cacheDir, installedJson }, entry, installScope, dryRun);
    }
    catch (e) {
        if (e instanceof EndOfInput)
            return 1;
        throw e;
    }
}
//# sourceMappingURL=heal-mcp-cache.js.map