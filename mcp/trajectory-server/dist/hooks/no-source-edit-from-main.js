/**
 * PreToolUse gate (GH 1692), the port of scripts/hooks/no-source-edit-from-main.sh.
 *
 * Rule 1, Edit / Write / MultiEdit / NotebookEdit outside a task worktree, in
 * a TMB project: allowed for a target under .claude/worktrees/, under a
 * scratch root, in a dir outside every git repo or in an unregistered repo,
 * on the docs / config allowlist, or by a swe; denied otherwise. The plugin's
 * own enforcement surfaces (scripts/hooks/, hooks/hooks.json of the repo whose
 * manifest names the running plugin) are denied even for a swe.
 * TMB_ALLOW_SOURCE_EDIT=1 lifts Rule 1. A DB that cannot be read denies.
 *
 * Rule 2, Bash, with or without a DB: a write the cmd-analysis analyzer finds
 * to a prompt-surface path outside a worktree is denied for every identity.
 *
 * Decisions and deny text are the .sh's, with these exceptions (decision 703):
 *   - GH 1796: the target and the scratch roots (.claude/<plugin>/scratch/ and
 *     /tmp/claude-<uid>, as containment-guard's harnessTmp admits it) are
 *     compared canonically, so a write under /private/tmp/claude-<uid> on
 *     macOS, where /tmp links to /private/tmp, is allowed; the .sh allows only
 *     a raw .claude/<plugin>/scratch/ path, and denies a scratch file whose
 *     parent dir does not exist yet.
 *   - It needs neither jq nor the sqlite3 CLI: without jq the .sh reads no
 *     tool name and allows everything; without sqlite3 it skips the
 *     registration check and guards an unregistered repo.
 *   - The analyzer's never-judged targets (`$(parse)`, `$(computed)`,
 *     `$(unproven)`, which the .sh's analyzer never prints) are
 *     containment-guard's to deny, not Rule 2's.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOW } from './gate.js';
import { harnessTmp, NEVER_JUDGED } from './containment-guard.js';
import { isPromptSurfacePath, payloadCwd, writePaths } from './cmd-analysis/index.js';
import { pathCanonical } from './lib/agent-context.js';
import { dbPath, dbState, denyDbUnavailable, gateRead, GATE_READ_ERROR, haveSqlite, projectRoot, realdir, stripTrailingNewlines } from './lib/db.js';
import { isDir } from './lib/git.js';
import { jqAlternatives, jqCompact } from './lib/jq.js';
import { installRoot, pluginName, posixBasename, posixDirname, TMB_STATE_HOST_DIR } from './lib/project-env.js';
import { repoGitRoot, repoNameForRoot } from './lib/repo.js';
import { agentRole } from './lib/role.js';
export const GATE_NAME = 'no-source-edit-from-main';
const JUDGED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const BASH_REASON = 'BLOCKED: Bash write-forms targeting prompt-surface files (agents/*.md, skills/*/SKILL.md, commands/*.md, templates/*.md, CLAUDE.md, CODEX/CURSOR/GEMINI.md) are denied from the main checkout for every agent identity. Sanctioned route: spawn an SWE task (prompt_bearing=1) for intentional prompt edits. Reads (cat/grep/sed -n) are always allowed.';
const SURFACE_REASON = "BLOCKED: enforcement surfaces (scripts/hooks/ and hooks/hooks.json) of the plugin's own source repo are only editable through task worktrees — spawn an SWE task. Main-checkout edits to these paths are denied regardless of file type.";
function sourceReason(env) {
    return `BLOCKED: source edits from the main checkout are denied. Normal route: use tmb_planning → task_create_batch to spawn SWE in an isolated worktree. If the worktree-create step failed (e.g. WorktreeCreate input had no .branch field), SWE running with agent_type='swe' is auto-permitted to edit in-place (non-isolated mode). For a bro emergency hotfix, set TMB_ALLOW_SOURCE_EDIT=1 in the PROCESS environment at launch time — setting it in a shell rc file has no effect on an already-running session. Scratch scripts and notes belong in ${scratchDir(env)}/ (or /tmp/claude-<uid>), which are always writable.`;
}
function scratchDir(env) {
    return `${TMB_STATE_HOST_DIR}/${pluginName(env)}/scratch`;
}
const ALLOWED_BASENAMES = new Set([
    'LICENSE',
    '.gitignore',
    '.gitattributes',
    '.editorconfig',
    '.npmignore',
    '.dockerignore',
    'CHANGELOG',
    'CHANGELOG.md',
    'README',
    'README.md',
]);
function capture(text) {
    return stripTrailingNewlines(text.replace(/\0/g, ''));
}
function field(input, ...paths) {
    return capture(jqAlternatives(input, paths));
}
function deny(reason) {
    const decision = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
    return { stdout: `${jqCompact(decision)}\n`, code: 0 };
}
function dbDenied(env) {
    return { stdout: `${denyDbUnavailable(GATE_NAME, env)}\n`, code: 0 };
}
/** The bash case pattern pair `*\/<dir>/*|<dir>/*`. */
function hasDir(path, dir) {
    return path.includes(`/${dir}/`) || path.startsWith(`${dir}/`);
}
function inWorktreeDir(path) {
    return hasDir(path, '.claude/worktrees');
}
/** `*\/../*|../*|*\/..|*\/scripts/hooks/*|scripts/hooks/*`: a path the scratch allowance never covers. */
function scratchExcluded(path) {
    return path.includes('/../') || path.startsWith('../') || path.endsWith('/..') || hasDir(path, 'scripts/hooks');
}
function under(path, dir) {
    return dir !== '' && path.startsWith(`${dir.endsWith('/') ? dir.slice(0, -1) : dir}/`);
}
/**
 * The scratch allowance: the raw target under .claude/<plugin>/scratch/, as the
 * .sh has it, or (GH 1796) its canonical path under .claude/<plugin>/scratch/ or
 * under the canonical /tmp/claude-<uid>.
 */
function inScratch(target, input, env) {
    if (scratchExcluded(target))
        return false;
    const scratch = scratchDir(env);
    if (hasDir(target, scratch))
        return true;
    const canonical = capture(pathCanonical(target.startsWith('/') ? target : `${payloadCwd(input, env)}/${target}`));
    if (scratchExcluded(canonical))
        return false;
    return hasDir(canonical, scratch) || under(canonical, harnessTmp(process.getuid?.() ?? 0));
}
function isFile(path) {
    try {
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function manifestName(manifest) {
    try {
        return field(readFileSync(manifest, 'utf8'), ['name']);
    }
    catch {
        return '';
    }
}
/** _target_is_plugin_source_repo: the target's git root carries a manifest named like the running plugin's. */
async function targetIsPluginSourceRepo(target, input, env) {
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT || installRoot(posixDirname(fileURLToPath(import.meta.url))) || '';
    const running = `${pluginRoot}/.claude-plugin/plugin.json`;
    let start;
    if (target.startsWith('/')) {
        start = posixDirname(target);
        while (!isDir(start) && start !== '/')
            start = posixDirname(start);
    }
    else {
        start = posixDirname(`${payloadCwd(input, env)}/${target}`);
    }
    const root = await repoGitRoot(start, env);
    if (root === '')
        return false;
    const repoManifest = `${root}/.claude-plugin/plugin.json`;
    if (!isFile(running) || !isFile(repoManifest))
        return false;
    const runningName = manifestName(running);
    return runningName !== '' && runningName === manifestName(repoManifest);
}
function allowlisted(target) {
    if (/\.(md|markdown|txt|rst)$/.test(target))
        return true;
    if (hasDir(target, 'docs') || hasDir(target, 'templates'))
        return true;
    const base = posixBasename(target);
    if (ALLOWED_BASENAMES.has(base) || base.startsWith('LICENSE.'))
        return true;
    if (target.endsWith('.claude-plugin/plugin.json') || target.endsWith('.claude-plugin/marketplace.json'))
        return true;
    return target.includes('.github/');
}
function isEnforcementSurface(target) {
    return hasDir(target, 'scripts/hooks') || target.endsWith('/hooks/hooks.json') || target === 'hooks/hooks.json';
}
/** `${p#"$root"/}` for the first of <roots> that prefixes <p>. */
function projectRelative(p, roots) {
    for (const root of roots) {
        if (root !== '' && p.startsWith(`${root}/`))
            return p.slice(root.length + 1);
    }
    return p;
}
/** `${word#UNRESOLVED:*:}`, or null for a never-judged marker. */
function judgedPath(word) {
    if (!word.startsWith('UNRESOLVED:'))
        return word;
    const rest = word.slice('UNRESOLVED:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0)
        return word;
    return Object.hasOwn(NEVER_JUDGED, rest.slice(0, colon)) ? null : rest.slice(colon + 1);
}
async function bashRule(input, env) {
    const command = field(input, ['tool_input', 'command']);
    const proj = capture(projectRoot(env));
    const roots = [proj, proj === '' ? '' : realdir(proj)];
    const lines = capture((await writePaths(command, { cwd: payloadCwd(input, env), env })).join('\n')).split('\n');
    for (const line of lines) {
        const path = judgedPath(line);
        if (path === null || path === '')
            continue;
        if (await isPromptSurfacePath(path, '', env) && !inWorktreeDir(projectRelative(path, roots)))
            return deny(BASH_REASON);
    }
    return ALLOW;
}
async function editRule(input, env) {
    const db = dbPath(env, (line) => process.stderr.write(`${line}\n`));
    if (db === null)
        return ALLOW;
    const target = field(input, ['tool_input', 'file_path'], ['tool_input', 'notebook_path']);
    if (target === '' || inWorktreeDir(target) || inScratch(target, input, env))
        return ALLOW;
    if (dbState(env) === 'error')
        return dbDenied(env);
    if (target.startsWith('/')) {
        const dir = posixDirname(target);
        if (haveSqlite(env) && isDir(dir)) {
            const root = await repoGitRoot(dir, env);
            if (root === '')
                return ALLOW;
            if (gateRead(db, 'SELECT COUNT(*) FROM repos;', env) === GATE_READ_ERROR)
                return dbDenied(env);
            if (repoNameForRoot(db, root, env) === '')
                return ALLOW;
        }
    }
    if (isEnforcementSurface(target) && await targetIsPluginSourceRepo(target, input, env))
        return deny(SURFACE_REASON);
    if (allowlisted(target))
        return ALLOW;
    if (agentRole(input) === 'swe')
        return ALLOW;
    return deny(sourceReason(env));
}
export const noSourceEditFromMain = async (payload, env) => {
    const toolName = field(payload, ['tool_name']);
    if (!JUDGED_TOOLS.has(toolName))
        return ALLOW;
    if (toolName === 'Bash')
        return await bashRule(payload, env);
    if ((env.TMB_ALLOW_SOURCE_EDIT ?? '0') === '1')
        return ALLOW;
    return await editRule(payload, env);
};
//# sourceMappingURL=no-source-edit-from-main.js.map