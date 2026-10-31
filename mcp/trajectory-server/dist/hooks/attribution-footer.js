/**
 * PostToolUse hook (#601, GH 1692), the port of
 * scripts/hooks/attribution-footer.sh: after `gh pr create`, `gh issue
 * create`, `glab mr create` or `glab issue create` succeeds, reads the new
 * artifact's body and writes it back carrying exactly the TMB footer. Best
 * effort: a missing CLI, a failed read or no URL in the response is a no-op.
 *
 * Decisions and the bodies written are the .sh's; the hook also runs with no
 * jq on PATH, and grep's `[:alnum:]` under a UTF-8 locale is Unicode's
 * letters and decimal digits as node knows them.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { jqCompact, jsonStream } from './lib/jq.js';
import { awkSpace, grepAlnum, grepMultibyte, grepSpace, JqError, jqIndex, jqPath, jqRawLines, jqRawOr, jqTruthy, shellCapture, wellFormed, } from './lib/lint-shell.js';
import { jqRawText } from './lib/project-env.js';
import { cmdCwd } from './lib/repo.js';
export const GATE_NAME = 'attribution-footer';
export const TMB_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code), powered by [Bro](https://github.com/trustmybot/plugin)';
const KINDS = [
    { cli: 'gh', group: 'pr', urlPath: '/pull/' },
    { cli: 'gh', group: 'issue', urlPath: '/issues/' },
    { cli: 'glab', group: 'mr', urlPath: '/-/merge_requests/' },
    { cli: 'glab', group: 'issue', urlPath: '/-/issues/' },
];
/** normalize_footer of the .sh: bare Claude Code footer lines dropped, the TMB footer appended once. */
export function normalizeFooter(body, env = process.env) {
    const text = shellCapture(body);
    const kept = text === ''
        ? []
        : text.split('\n').filter((l) => !(l.includes('🤖 Generated with [Claude Code]') && !l.includes('powered by Bro')));
    const stripped = shellCapture(kept.map((l) => `${l}\n`).join(''));
    if (stripped !== '' && stripped.split('\n').some((l) => l.includes(TMB_FOOTER)))
        return stripped;
    const blank = new RegExp(`^[${awkSpace(env)}]*$`, 'u');
    const lines = stripped === '' ? [] : stripped.split('\n');
    let last = lines.length;
    while (last > 0 && blank.test(lines[last - 1]))
        last -= 1;
    const trimmed = shellCapture(lines.slice(0, last).map((l) => `${l}\n`).join(''));
    return trimmed === '' ? TMB_FOOTER : `${trimmed}\n\n${TMB_FOOTER}`;
}
/** `command -v <name>`: the first executable file of that name on PATH. */
function onPath(name, env) {
    for (const dir of (env.PATH ?? '').split(':')) {
        const file = `${dir === '' ? '.' : dir}/${name}`;
        try {
            if (!statSync(file).isFile())
                continue;
            accessSync(file, constants.X_OK);
            return file;
        }
        catch {
            continue;
        }
    }
    return null;
}
function run(file, args, repoDir, env) {
    const r = spawnSync(file, args, { cwd: repoDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 30 });
    return { stdout: r.stdout ?? '', ok: r.error === undefined && r.status === 0 };
}
/** `jq -r '.description // ""'` over glab's JSON, null when jq exits non-zero (pipefail ends the hook). */
function glabDescription(json) {
    const { values, complete } = jsonStream(json);
    const lines = [];
    let failed = false;
    for (const value of values) {
        try {
            const v = jqIndex(value, 'description');
            lines.push(wellFormed(jqRawText(jqTruthy(v) ? v : '')));
            failed = false;
        }
        catch (e) {
            if (!(e instanceof JqError))
                throw e;
            failed = true;
        }
    }
    if (!complete || failed)
        return null;
    return shellCapture(lines.join('\n'));
}
/** `jq -r '.tool_response | if type == "string" then . else tojson end'`. */
function toolResponse(payload) {
    return jqRawLines(payload, (value) => {
        const response = jqPath('tool_response')(value);
        return typeof response === 'string' ? response : jqCompact(response ?? null);
    });
}
function created(command, kind, multibyte) {
    const edge = `[^${grepAlnum(multibyte)}_-]`;
    const space = `[${grepSpace(multibyte)}]+`;
    const re = new RegExp(`(^|${edge})${kind.cli}${space}${kind.group}${space}create(${edge}|$)`, 'u');
    return command.split('\n').some((line) => re.test(line));
}
/** `grep -oE 'https://[^[:space:]"]+<path>[0-9]+' | grep -oE '[0-9]+$' | head -n1`. */
function artifactNumber(response, kind, multibyte) {
    const re = new RegExp(`https://[^${grepSpace(multibyte)}"]+${kind.urlPath}([0-9]+)`, 'u');
    for (const line of response.split('\n')) {
        const m = re.exec(line);
        if (m)
            return m[1];
    }
    return '';
}
export const attributionFooter = (payload, env) => {
    if (jqRawOr(payload, [jqPath('tool_name')]) !== 'Bash')
        return ALLOW;
    const command = jqRawOr(payload, [jqPath('tool_input', 'command')]);
    const response = toolResponse(payload);
    if (command === '')
        return ALLOW;
    const multibyte = grepMultibyte(env);
    const kind = KINDS.find((k) => created(command, k, multibyte));
    if (kind === undefined)
        return ALLOW;
    const number = artifactNumber(response, kind, multibyte);
    if (number === '')
        return ALLOW;
    const cli = onPath(kind.cli, env);
    if (cli === null)
        return ALLOW;
    const repoDir = cmdCwd(command, payload, env);
    let orig;
    if (kind.cli === 'gh') {
        const view = run(cli, [kind.group, 'view', number, '--json', 'body', '-q', '.body'], repoDir, env);
        if (!view.ok)
            return ALLOW;
        orig = shellCapture(view.stdout);
    }
    else {
        const view = run(cli, [kind.group, 'view', number, '-F', 'json'], repoDir, env);
        const description = view.ok ? glabDescription(view.stdout) : null;
        if (description === null)
            return ALLOW;
        orig = description;
    }
    const updated = shellCapture(normalizeFooter(orig, env));
    if (updated === orig)
        return ALLOW;
    const write = kind.cli === 'gh'
        ? [kind.group, 'edit', number, '--body', updated]
        : [kind.group, 'update', number, '--description', updated];
    run(cli, write, repoDir, env);
    return ALLOW;
};
//# sourceMappingURL=attribution-footer.js.map