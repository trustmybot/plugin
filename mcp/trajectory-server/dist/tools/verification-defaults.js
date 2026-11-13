// GH 2570: a repo's .config/tmb/verification-defaults.json {"version":1,"commands":["..."]},
// read at the cut base, appends its commands to every task_provision / task_retry / task_reopen /
// task_update_spec verification[] (the last two since GH 2866). A repo without one gets candidates
// proposed from its recorded root env profile (GH 2866: /onboard, scan_run, provision hints).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitUnanswered, runGit } from '../utils/git-run.js';
import { resolveCutBase } from '../utils/git-refs.js';
import { repoTargetBase } from '../utils/repo-paths.js';
import { effectiveCommands } from './env.js';
export const VERIFICATION_DEFAULTS_FILE = '.config/tmb/verification-defaults.json';
function gitFailure(res) {
    return res.error?.message.split('\n')[0] || (res.stderr ?? '').trim().split('\n')[0] || `git exited ${res.status}`;
}
function parseDefaults(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (e) {
        return { error: `not valid JSON: ${e.message}` };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'must be a JSON object {"version":1,"commands":[...]}' };
    }
    const { version, commands } = parsed;
    if (version !== 1)
        return { error: `version must be 1, got ${JSON.stringify(version) ?? 'none'}` };
    if (!Array.isArray(commands) || commands.length === 0 || !commands.every((c) => typeof c === 'string' && c.trim() !== '')) {
        return { error: 'commands must be a non-empty array of non-empty strings' };
    }
    return { commands: commands };
}
// The file as committed at `ref`; the working tree never counts. No repo, no
// ref or no file at a resolving ref means no defaults.
export function readVerificationDefaults(repoPath, ref) {
    if (!repoPath || !ref)
        return { commands: [] };
    const shown = runGit(repoPath, ['show', `${ref}:${VERIFICATION_DEFAULTS_FILE}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (gitUnanswered(shown))
        return { error: `git show failed: ${gitFailure(shown)}` };
    if (shown.status === 0)
        return parseDefaults(shown.stdout);
    const head = runGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (gitUnanswered(head) || head.status !== 0)
        return { error: `git cannot resolve ${ref}: ${gitFailure(shown)}` };
    return { commands: [] };
}
export function appendVerificationDefaults(verification, defaults) {
    const present = new Set(verification);
    const added = [];
    for (const command of defaults) {
        if (present.has(command))
            continue;
        present.add(command);
        added.push(command);
    }
    return { verification: [...verification, ...added], added };
}
export function verificationDefaultsResult(tool, ref, problem) {
    const message = `${tool}: ${VERIFICATION_DEFAULTS_FILE} at ${ref ?? '(no ref)'} is invalid: ${problem}. ` +
        `Fix the file on the base branch (format {"version":1,"commands":["..."]}) or remove it. Nothing was written.`;
    return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: 'verification_defaults_invalid', message, ref, file: VERIFICATION_DEFAULTS_FILE }) }],
    };
}
const PROPOSED_CATEGORIES = ['lint', 'typecheck', 'test'];
export const NO_ENV_PROFILE_NOTE = "no root env profile is recorded for this repo: run env_detect, resolve its commands and record them with env_record, then ask again";
// The lint, typecheck and test commands of the repo's recorded root profiles,
// in that category order, each command once.
export function proposeVerificationDefaults(db, repo) {
    const rows = db.all(`SELECT * FROM repo_env WHERE repo = ? AND package_path = '.' ORDER BY ecosystem`, [repo]);
    if (rows.length === 0)
        return { candidates: [], reason: 'no_env_profile' };
    const profiles = rows.map((row) => effectiveCommands(row.commands_json, row.overrides_json));
    const seen = new Set();
    const candidates = [];
    for (const category of PROPOSED_CATEGORIES) {
        for (const profile of profiles) {
            for (const { command, source } of profile[category]) {
                if (seen.has(command))
                    continue;
                seen.add(command);
                candidates.push({ command, category, source });
            }
        }
    }
    return { candidates };
}
// Where task_provision reads the repo's defaults: the cut base of its PR target.
export function verificationDefaultsBaseRef(db, repo, repoPath) {
    return resolveCutBase(repoPath, repoTargetBase(db, repoPath, repo))?.ref ?? null;
}
// readVerificationDefaults answers { commands: [] } at a resolving ref only when
// the file is absent: a present file needs a non-empty commands list.
export function verificationDefaultsMissing(repoPath, ref, defaults) {
    return repoPath !== null && ref !== null && !('error' in defaults) && defaults.commands.length === 0;
}
export function verificationDefaultsMissingField(repoPath, ref, defaults) {
    if (!verificationDefaultsMissing(repoPath, ref, defaults))
        return {};
    return {
        verification_defaults_missing: `${ref} has no ${VERIFICATION_DEFAULTS_FILE}, so no repo checks were appended; run /onboard to set them from the env profile.`,
    };
}
export function verificationDefaultsHint(db, repo, repoPath) {
    const ref = verificationDefaultsBaseRef(db, repo, repoPath);
    if (ref === null || !verificationDefaultsMissing(repoPath, ref, readVerificationDefaults(repoPath, ref)))
        return null;
    const { candidates } = proposeVerificationDefaults(db, repo);
    return candidates.length > 0 ? { repo, ref, candidates } : null;
}
const sameCommands = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);
// Writes the defaults file into the repo's working tree, never over a file
// with other commands, and never commits: task_provision reads it at `ref`.
export function writeVerificationDefaults(repo, repoPath, ref, commands) {
    const path = join(repoPath, VERIFICATION_DEFAULTS_FILE);
    let written = false;
    const result = (commit_needed, message, refused = false) => ({
        repo,
        path,
        commands,
        written,
        refused,
        commit_needed,
        message,
    });
    if (existsSync(path)) {
        const current = parseDefaults(readFileSync(path, 'utf8'));
        if ('error' in current || !sameCommands(current.commands, commands)) {
            return result(false, `${VERIFICATION_DEFAULTS_FILE} already exists with other content and was left unchanged; edit or remove it, then apply again.`, true);
        }
    }
    else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify({ version: 1, commands }, null, 2)}\n`);
        written = true;
    }
    const atBase = ref === null ? null : readVerificationDefaults(repoPath, ref);
    if (atBase !== null && !('error' in atBase) && sameCommands(atBase.commands, commands)) {
        return result(false, `${VERIFICATION_DEFAULTS_FILE} is already committed on ${ref}.`);
    }
    return result(true, `${VERIFICATION_DEFAULTS_FILE} takes effect once it is committed to the PR target${ref ? ` (${ref})` : ''}: task_provision reads it there, not from the working tree.`);
}
//# sourceMappingURL=verification-defaults.js.map