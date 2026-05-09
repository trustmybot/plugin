// Onboard MCP tools (#onboard-redesign) — push the deterministic logic of
// the /onboard slash command (env probe, URL→provider mapping, Keep-option
// computation, atomic persistence) out of skill prose and into TS code.
//
// The skill body becomes orchestration-only:
//   1. state = onboard_state_get()
//   2. AUQ Round 1 (shape) — hardcoded 2 options, no logic
//   3. q = onboard_get_questions(shape, round)
//   4. AUQ Round 2/3 — server-built question objects
//   5. onboard_apply(shape, answers) — single transactional write
//
// All "if probe.origin_kind=github → preselect GitHub", "if first_run drop Keep",
// "github-flow → pr_target=main", "gitflow → protected_branches=[main, develop]"
// rules live here, not in the skill.
import { spawnSync } from 'node:child_process';
import { nowISO } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function wrapHandler(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return {
                content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }],
                isError: true,
            };
        }
    };
}
function classifyUrl(url) {
    if (url.includes('github.com'))
        return 'github';
    // gitlab.com OR self-hosted gitlab.<corp>.<tld>
    if (/(^|\W)gitlab(\.com|\.[a-z0-9-]+\.[a-z]{2,})/i.test(url))
        return 'gitlab';
    if (url.includes('bitbucket.org'))
        return 'bitbucket';
    if (url.includes('codeberg.org'))
        return 'codeberg';
    if (url.includes('dev.azure.com'))
        return 'azuredev';
    return 'other';
}
function probeGit(cwd) {
    const opts = { encoding: 'utf8', timeout: 3000, cwd };
    const inGitR = spawnSync('git', ['rev-parse', '--show-toplevel'], opts);
    const in_git = inGitR.status === 0;
    if (!in_git)
        return { in_git: false, detected_remotes: [], origin_kind: null };
    const remotesR = spawnSync('git', ['remote', '-v'], opts);
    const detected_remotes = [];
    if (remotesR.status === 0) {
        const seen = new Set();
        const lines = (remotesR.stdout ?? '').split('\n');
        for (const line of lines) {
            const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
            if (!m)
                continue;
            const [, name, url] = m;
            if (seen.has(name))
                continue;
            seen.add(name);
            detected_remotes.push({ name, url, provider: classifyUrl(url) });
        }
    }
    const origin = detected_remotes.find((r) => r.name === 'origin');
    return {
        in_git,
        detected_remotes,
        origin_kind: origin ? origin.provider : null,
    };
}
function probeCli(cmd) {
    const which = spawnSync('command', ['-v', cmd], { encoding: 'utf8', timeout: 1000, shell: true });
    const installed = which.status === 0 && (which.stdout ?? '').trim().length > 0;
    if (!installed)
        return { installed: false, authed: false };
    const authR = spawnSync(cmd, ['auth', 'status'], { encoding: 'utf8', timeout: 5000 });
    return { installed: true, authed: authR.status === 0 };
}
// ---- DB helpers ----------------------------------------------------------
function readConfig(db, key) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = ?`, [key]);
    if (!row?.value_json)
        return null;
    try {
        return JSON.parse(row.value_json);
    }
    catch {
        return null;
    }
}
function writeConfig(db, key, value) {
    const now = nowISO();
    db.run(`INSERT INTO plugin_config (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, [key, JSON.stringify(value), now]);
}
function readIdentityState(db) {
    const row = db.get(`SELECT human_name FROM identity WHERE id = 1`);
    if (row === undefined || row === null) {
        return { row_exists: false, human_name: null };
    }
    return { row_exists: true, human_name: row.human_name };
}
function deriveProtectedBranches(branchingModel, prTarget) {
    if (branchingModel === 'gitflow') {
        const set = new Set(['main', prTarget]);
        return Array.from(set);
    }
    return [prTarget];
}
function derivePrTargetDefault(branchingModel) {
    return branchingModel === 'gitflow' ? 'develop' : 'main';
}
const BRANCHING_DESCRIPTIONS = {
    'github-flow': 'One long-lived branch (main). Each task gets its own short-lived branch off main; you open a PR back to main when it\'s ready. No release branches. Suitable for continuous deploys.',
    gitflow: 'Two long-lived branches (main + develop). Daily work merges into develop; release branches are cut from develop and merged into main when shipping. Hotfixes go straight to main. Suitable for versioned releases.',
};
function nameQuestion(currentName, isReonboard) {
    const options = [];
    if (isReonboard) {
        if (currentName !== null) {
            options.push({ label: `Keep "${currentName}"`, description: 'No change.' });
        }
        else {
            // Anonymous identity already exists — Keep means "stay anonymous".
            options.push({ label: 'Keep Anonymous', description: 'No change. Identity stays anonymous.' });
        }
    }
    // AskUserQuestion requires ≥2 explicit options (Other is auto-rendered but
    // doesn't satisfy the minimum). For first-run we always include both:
    options.push({
        label: 'Anonymous',
        description: 'No name stored. Free-floating sessions.',
    });
    options.push({
        label: 'Set my name',
        description: 'Pick "Other" below and type your name (1-32 chars).',
    });
    return {
        question: 'What should I call you?',
        header: 'Your name',
        multiSelect: false,
        options,
        default_index: 0,
    };
}
function branchingQuestion(currentModel, isReonboard) {
    const options = [];
    if (isReonboard && currentModel !== null) {
        options.push({ label: `Keep "${currentModel}"`, description: 'No change.' });
    }
    options.push({
        label: 'GitHub Flow',
        description: BRANCHING_DESCRIPTIONS['github-flow'],
    });
    options.push({
        label: 'Git Flow',
        description: BRANCHING_DESCRIPTIONS.gitflow,
    });
    return {
        question: 'How does your team branch?',
        header: 'Branching',
        multiSelect: false,
        options,
        default_index: 0,
    };
}
function prTargetQuestion(currentTarget, branchingModel, isReonboard) {
    const options = [];
    if (isReonboard && currentTarget !== null) {
        options.push({ label: `Keep "${currentTarget}"`, description: 'No change.' });
    }
    options.push({ label: 'main', description: 'Most common default.' }, { label: 'develop', description: 'Common for Git Flow.' }, { label: 'master', description: 'Older repos.' });
    // First-run pre-select by branching_model: github-flow → main, gitflow → develop.
    let default_index = 0;
    if (!isReonboard) {
        const want = branchingModel === 'gitflow' ? 'develop' : 'main';
        default_index = options.findIndex((o) => o.label === want);
        if (default_index < 0)
            default_index = 0;
    }
    return {
        question: "What's your PR target branch?",
        header: 'PR target',
        multiSelect: false,
        options,
        default_index,
    };
}
function remoteQuestion(origin_kind, gh_installed, glab_installed, isReonboard, currentRemotes) {
    const options = [];
    // Prepend a Keep option on re-onboard if the current remotes resolves to a
    // single canonical provider (github/gitlab/both).
    if (isReonboard && Array.isArray(currentRemotes) && currentRemotes.length > 0) {
        const providers = currentRemotes
            .map((r) => r.provider)
            .filter((p) => typeof p === 'string');
        const uniq = Array.from(new Set(providers));
        let label = null;
        if (uniq.length === 1 && uniq[0] === 'github')
            label = 'Keep "GitHub"';
        else if (uniq.length === 1 && uniq[0] === 'gitlab')
            label = 'Keep "GitLab"';
        else if (uniq.length === 2 && uniq.includes('github') && uniq.includes('gitlab'))
            label = 'Keep "Both"';
        if (label)
            options.push({ label, description: 'No change.' });
    }
    options.push({
        label: gh_installed ? 'GitHub' : 'GitHub (CLI not installed)',
        description: 'github.com or GitHub Enterprise.',
        disabled: !gh_installed,
    });
    options.push({
        label: glab_installed ? 'GitLab' : 'GitLab (CLI not installed)',
        description: 'gitlab.com or self-hosted GitLab.',
        disabled: !glab_installed,
    });
    options.push({
        label: 'Both',
        description: 'Mirrored or dual-host. Issues sync to both.',
        disabled: !(gh_installed && glab_installed),
    });
    // Pre-select via probe.origin_kind.
    let default_index = 0;
    if (!isReonboard) {
        const want = origin_kind === 'github' ? 'GitHub' : origin_kind === 'gitlab' ? 'GitLab' : null;
        if (want) {
            const idx = options.findIndex((o) => o.label === want || o.label.startsWith(want + ' '));
            if (idx >= 0 && !options[idx].disabled)
                default_index = idx;
        }
    }
    return {
        question: 'Which remote does this project use?',
        header: 'Remote',
        multiSelect: false,
        options,
        default_index,
    };
}
function issueSyncQuestion(currentSync, isReonboard, authedAtLeastOne) {
    const options = [];
    if (isReonboard && currentSync !== null) {
        options.push({ label: `Keep "${currentSync}"`, description: 'No change.' });
    }
    options.push({
        label: 'Auto — sync to the remote you picked',
        description: authedAtLeastOne
            ? '`issue_create` mirrors to GitHub/GitLab as well as the local DB.'
            : 'WARNING: no gh/glab auth detected. Sync will retry until you authenticate.',
    });
    options.push({
        label: 'Off — local DB only',
        description: 'Issues stay in the trajectory DB; no remote mirror.',
    });
    return {
        question: 'Mirror new MCP issues to your remote?',
        header: 'Issue sync',
        multiSelect: false,
        options,
        default_index: 0,
    };
}
// ---- Tool definitions ----------------------------------------------------
export function onboardTools(db, dbPath = '') {
    const definitions = [
        {
            name: 'onboard_state_get',
            description: 'Read everything the /onboard slash command needs to render its question set: first-run flag (identity row absent), current plugin_config values, and the silent git/CLI probe (origin URL → provider, gh/glab installed+authed). Bro should call this once before opening AskUserQuestion.',
            inputSchema: { type: 'object', properties: {} },
        },
        {
            name: 'onboard_get_questions',
            description: 'Build the AUQ-ready question objects for one round of /onboard. Server applies all the conditional logic (Keep options on re-onboard, disable unavailable CLI options, pre-select defaults from the probe). Bro feeds the returned options array straight into AskUserQuestion.',
            inputSchema: {
                type: 'object',
                properties: {
                    shape: {
                        type: 'string',
                        enum: ['local', 'remote'],
                        description: 'Project shape from Round 1.',
                    },
                    round: {
                        type: 'string',
                        enum: ['main', 'sync'],
                        description: "'main' = Round 2 questions (name + branching, plus pr_target/remote on remote shape). 'sync' = Round 3 (remote shape only — issue_sync).",
                    },
                },
                required: ['shape', 'round'],
            },
        },
        {
            name: 'onboard_apply',
            description: 'Persist all /onboard answers in a single transaction. Server derives pr_target / protected_branches from branching_model when not explicitly set, sets remotes=[] + issue_sync="off" for local shape, and recomputes protected_branches whenever branching_model or pr_target changes.',
            inputSchema: {
                type: 'object',
                properties: {
                    shape: { type: 'string', enum: ['local', 'remote'] },
                    name: {
                        description: 'Anonymous (anonymous identity), null/omit (no change), or a typed name string.',
                    },
                    branching_model: {
                        type: 'string',
                        enum: ['github-flow', 'gitflow'],
                        description: 'Optional on local first-run (defaults to github-flow).',
                    },
                    pr_target: { type: 'string' },
                    remote: {
                        type: 'string',
                        enum: ['github', 'gitlab', 'both'],
                        description: 'Required when shape=remote. Ignored on local.',
                    },
                    issue_sync: {
                        type: 'string',
                        enum: ['auto', 'off'],
                        description: 'Required when shape=remote. Always "off" on local.',
                    },
                },
                required: ['shape'],
            },
        },
    ];
    const handlers = {
        onboard_state_get: requireRoles('onboard_state_get', ['bro'], wrapHandler(async () => {
            const cwd = dbPath ? dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '') : process.cwd();
            const git = probeGit(cwd || process.cwd());
            const gh = probeCli('gh');
            const glab = probeCli('glab');
            const id = readIdentityState(db);
            // first_run is signalled by *row absence*, not by human_name nullity.
            // An anonymous identity (row present, human_name=NULL) counts as
            // onboarded — its presence is the only thing that suppresses the
            // auto-fire trigger on cold restart (#95).
            const first_run = !id.row_exists;
            return ok({
                first_run,
                current: {
                    human_name: id.human_name,
                    branching_model: readConfig(db, 'branching_model'),
                    pr_target: readConfig(db, 'pr_target'),
                    protected_branches: readConfig(db, 'protected_branches'),
                    remotes: readConfig(db, 'remotes'),
                    issue_sync: readConfig(db, 'issue_sync'),
                },
                probe: {
                    in_git: git.in_git,
                    origin_kind: git.origin_kind,
                    detected_remotes: git.detected_remotes,
                    gh_installed: gh.installed,
                    gh_authed: gh.authed,
                    glab_installed: glab.installed,
                    glab_authed: glab.authed,
                },
            });
        })),
        onboard_get_questions: requireRoles('onboard_get_questions', ['bro'], wrapHandler(async (args) => {
            const shape = args['shape'];
            const round = args['round'];
            const id = readIdentityState(db);
            const human_name = id.human_name;
            // Re-onboard means the identity row exists. Anonymous (row + human_name=NULL)
            // counts as re-onboard — show a "Keep Anonymous" path.
            const isReonboard = id.row_exists;
            const currentBranching = readConfig(db, 'branching_model');
            const currentPrTarget = readConfig(db, 'pr_target');
            const currentRemotes = readConfig(db, 'remotes');
            const currentSync = readConfig(db, 'issue_sync');
            const cwd = dbPath ? dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '') : process.cwd();
            const git = probeGit(cwd || process.cwd());
            const gh = probeCli('gh');
            const glab = probeCli('glab');
            const questions = [];
            if (round === 'main') {
                questions.push(nameQuestion(human_name, isReonboard));
                if (shape === 'remote' || isReonboard) {
                    // Local re-onboard adds Branching so the Human can change models.
                    // Local first-run skips Branching entirely (silent default).
                    questions.push(branchingQuestion(currentBranching, isReonboard));
                }
                if (shape === 'remote') {
                    questions.push(prTargetQuestion(currentPrTarget, currentBranching, isReonboard));
                    questions.push(remoteQuestion(git.origin_kind, gh.installed, glab.installed, isReonboard, currentRemotes));
                }
            }
            else if (round === 'sync') {
                if (shape !== 'remote') {
                    throw new Error(`round='sync' only valid for shape='remote' (got '${shape}')`);
                }
                questions.push(issueSyncQuestion(currentSync, isReonboard, gh.authed || glab.authed));
            }
            else {
                throw new Error(`unknown round '${round}'`);
            }
            return ok({ questions });
        })),
        onboard_apply: requireRoles('onboard_apply', ['bro'], wrapHandler(async (args) => {
            const shape = args['shape'];
            if (shape !== 'local' && shape !== 'remote') {
                throw new Error(`shape must be 'local' or 'remote' (got '${shape}')`);
            }
            const name = args['name'];
            const branching_model = args['branching_model'] ??
                (shape === 'local' ? 'github-flow' : undefined);
            if (!branching_model) {
                throw new Error('branching_model is required for shape=remote');
            }
            if (branching_model !== 'github-flow' && branching_model !== 'gitflow') {
                throw new Error(`branching_model must be 'github-flow' or 'gitflow' (got '${branching_model}')`);
            }
            const pr_target = args['pr_target'] ?? derivePrTargetDefault(branching_model);
            let remotes = [];
            let issue_sync = 'off';
            if (shape === 'remote') {
                const remote = args['remote'];
                if (!remote)
                    throw new Error("'remote' is required when shape='remote'");
                issue_sync = args['issue_sync'] ?? 'off';
                if (issue_sync !== 'auto' && issue_sync !== 'off') {
                    throw new Error(`issue_sync must be 'auto' or 'off' (got '${String(issue_sync)}')`);
                }
                const cwd = dbPath ? dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '') : process.cwd();
                const git = probeGit(cwd || process.cwd());
                const findUrl = (p) => git.detected_remotes.find((r) => r.provider === p)?.url ?? '';
                if (remote === 'github')
                    remotes = [{ name: 'origin', provider: 'github', url: findUrl('github') }];
                else if (remote === 'gitlab')
                    remotes = [{ name: 'origin', provider: 'gitlab', url: findUrl('gitlab') }];
                else
                    remotes = [
                        { name: 'origin', provider: 'github', url: findUrl('github') },
                        { name: 'gitlab', provider: 'gitlab', url: findUrl('gitlab') },
                    ];
            }
            const protected_branches = deriveProtectedBranches(branching_model, pr_target);
            const now = nowISO();
            db.transaction(() => {
                // Identity
                if (name === 'Anonymous') {
                    db.run(`INSERT INTO identity (id, human_name, created_at, updated_at)
               VALUES (1, NULL, ?, ?)
               ON CONFLICT(id) DO UPDATE SET human_name = NULL, updated_at = excluded.updated_at`, [now, now]);
                }
                else if (typeof name === 'string' && name.trim().length > 0) {
                    db.run(`INSERT INTO identity (id, human_name, created_at, updated_at)
               VALUES (1, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET human_name = excluded.human_name, updated_at = excluded.updated_at`, [name.trim(), now, now]);
                }
                // null/undefined name → leave identity untouched (re-onboard "Keep" path).
                writeConfig(db, 'branching_model', branching_model);
                writeConfig(db, 'pr_target', pr_target);
                writeConfig(db, 'protected_branches', protected_branches);
                writeConfig(db, 'remotes', remotes);
                writeConfig(db, 'issue_sync', issue_sync);
            });
            const finalState = readIdentityState(db);
            return ok({
                ok: true,
                applied: {
                    human_name: finalState.human_name,
                    branching_model,
                    pr_target,
                    protected_branches,
                    remotes,
                    issue_sync,
                },
            });
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=onboard.js.map