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
    db.run(`INSERT INTO plugin_config (key, value_json)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, [key, JSON.stringify(value)]);
}
function readOnboardedFlag(db) {
    // #2876: onboarded state is a plugin_config marker now, not its own table.
    // value_json is JSON-encoded — `"true"` is the canonical truthy value.
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = 'onboarded'`);
    if (!row?.value_json)
        return false;
    try {
        return JSON.parse(row.value_json) === true;
    }
    catch {
        return false;
    }
}
function deriveProtectedBranches(branchingModel, prTarget) {
    if (branchingModel === 'gitflow') {
        const set = new Set(['main', prTarget]);
        return Array.from(set);
    }
    return [prTarget];
}
function derivePrTargetDefault(branchingModel) {
    // gitflow → 'dev' (most common modern variant; GitLab Flow + many repos).
    // Users on classic Git Flow with 'develop' override via the AUQ option or
    // re-onboard later. Picked over 'develop' as the default because real-world
    // surveys (2026-05) show 'dev' as the more frequent long-lived integration
    // branch name across the active GitLab/GitHub ecosystem.
    return branchingModel === 'gitflow' ? 'dev' : 'main';
}
const BRANCHING_DESCRIPTIONS = {
    'github-flow': 'One long-lived branch (main). Each task gets its own short-lived branch off main; you open a PR back to main when it\'s ready. No release branches. Suitable for continuous deploys.',
    gitflow: 'Two long-lived branches (main + dev). Daily work merges into the integration branch (commonly named "dev" — older repos may name it "develop"); release branches are cut from there and merged into main when shipping. Hotfixes go straight to main. Suitable for versioned releases.',
};
// Name is intentionally NOT a built question — it's free-text input that
// AUQ's radio model fits poorly (the auto-rendered "Other" field clutters
// the picker with 3 effective options when only 2 are conceptually offered:
// "Anonymous" or "type your name"). The skill body asks Name in plain prose
// and feeds the parsed answer straight to `onboard_apply`. See commands/onboard.md.
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
    options.push({ label: 'main', description: 'Most common default.' }, { label: 'dev', description: 'Common for GitLab Flow + modern Git Flow variants.' }, { label: 'develop', description: 'Classic Git Flow convention.' });
    // First-run pre-select by branching_model: github-flow → main, gitflow → dev.
    // 'develop' is offered as a secondary option for classic Git Flow repos.
    // master / older targets aren't offered as labeled options (rare in modern
    // projects). Users who actually need master/release/etc. type it via Other.
    let default_index = 0;
    if (!isReonboard) {
        const want = branchingModel === 'gitflow' ? 'dev' : 'main';
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
function remoteQuestion(origin_kind, gh_installed, glab_installed, _isReonboard, _currentRemotes) {
    // multiSelect: pick one or both checkboxes (no separate "Both" option).
    // Keep options don't apply on a multiSelect — re-onboard users just check
    // whichever providers they want; submitting unchanged is a valid no-op
    // outcome, but the answer set is the new state.
    const options = [
        {
            label: gh_installed ? 'GitHub' : 'GitHub (CLI not installed)',
            description: 'github.com or GitHub Enterprise.',
            disabled: !gh_installed,
        },
        {
            label: glab_installed ? 'GitLab' : 'GitLab (CLI not installed)',
            description: 'gitlab.com or self-hosted GitLab.',
            disabled: !glab_installed,
        },
    ];
    // Pre-select via probe.origin_kind.
    let default_index = 0;
    const want = origin_kind === 'github' ? 'GitHub' : origin_kind === 'gitlab' ? 'GitLab' : null;
    if (want) {
        const idx = options.findIndex((o) => o.label === want || o.label.startsWith(want + ' '));
        if (idx >= 0 && !options[idx].disabled)
            default_index = idx;
    }
    return {
        question: 'Which remote(s) does this project use?',
        header: 'Remote',
        multiSelect: true,
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
            description: 'Persist all /onboard answers in a single transaction. Server derives pr_target / protected_branches from branching_model when not explicitly set, sets remotes=[] + issue_sync="off" for local shape, and recomputes protected_branches whenever branching_model or pr_target changes. Also writes the identity row at id=1 as the "onboarded" marker so future cold restarts skip the auto-fire trigger.',
            inputSchema: {
                type: 'object',
                properties: {
                    shape: { type: 'string', enum: ['local', 'remote'] },
                    branching_model: {
                        type: 'string',
                        enum: ['github-flow', 'gitflow'],
                        description: 'Optional on local first-run (defaults to github-flow).',
                    },
                    pr_target: { type: 'string' },
                    remote: {
                        type: 'array',
                        items: { type: 'string', enum: ['github', 'gitlab'] },
                        description: 'Required when shape=remote. Array of provider IDs (multiSelect AUQ answer). Single-element ["github"] or ["gitlab"], or ["github","gitlab"] for dual-host. Ignored on local.',
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
            const onboarded = readOnboardedFlag(db);
            // first_run is signalled by identity row absence. The row is a pure
            // onboarded marker — bro doesn't store names or any other identity
            // attributes, so row presence alone suppresses the auto-fire trigger
            // on cold restart (#95).
            const first_run = !onboarded;
            return ok({
                first_run,
                current: {
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
            // Re-onboard means /onboard already ran in this project — identity row exists.
            const isReonboard = readOnboardedFlag(db);
            const currentBranching = readConfig(db, 'branching_model');
            const currentPrTarget = readConfig(db, 'pr_target');
            const currentRemotes = readConfig(db, 'remotes');
            const currentSync = readConfig(db, 'issue_sync');
            const cwd = dbPath ? dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '') : process.cwd();
            const git = probeGit(cwd || process.cwd());
            const gh = probeCli('gh');
            const glab = probeCli('glab');
            // Name is asked separately as a prose prompt (not AUQ — see comment
            // on the deleted nameQuestion). onboard_get_questions only returns
            // multiple-choice questions where AUQ's radio model is the right fit.
            const questions = [];
            if (round === 'main') {
                if (shape === 'remote' || isReonboard) {
                    // Local re-onboard adds Branching so the Human can change models.
                    // Local first-run skips Branching entirely (silent default).
                    questions.push(branchingQuestion(currentBranching, isReonboard));
                }
                if (shape === 'remote') {
                    questions.push(prTargetQuestion(currentPrTarget, currentBranching, isReonboard));
                    questions.push(remoteQuestion(git.origin_kind, gh.installed, glab.installed, isReonboard, currentRemotes));
                }
                // shape=local + first-run yields questions=[] — skill skips AUQ Round 2.
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
                const rawRemote = args['remote'];
                // Accept array (canonical, post-multiSelect) or string (legacy/single).
                let remoteList;
                if (Array.isArray(rawRemote)) {
                    remoteList = rawRemote.filter((s) => typeof s === 'string');
                }
                else if (typeof rawRemote === 'string') {
                    remoteList = [rawRemote];
                }
                else {
                    throw new Error("'remote' is required when shape='remote'");
                }
                if (remoteList.length === 0) {
                    throw new Error("'remote' must include at least one of 'github' / 'gitlab' when shape='remote'");
                }
                for (const r of remoteList) {
                    if (r !== 'github' && r !== 'gitlab') {
                        throw new Error(`remote entries must be 'github' or 'gitlab' (got '${r}')`);
                    }
                }
                issue_sync = args['issue_sync'] ?? 'off';
                if (issue_sync !== 'auto' && issue_sync !== 'off') {
                    throw new Error(`issue_sync must be 'auto' or 'off' (got '${String(issue_sync)}')`);
                }
                const cwd = dbPath ? dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '') : process.cwd();
                const git = probeGit(cwd || process.cwd());
                const findUrl = (p) => git.detected_remotes.find((r) => r.provider === p)?.url ?? '';
                // Stable order: github first, then gitlab. The first entry uses
                // name='origin'; if both are present the second uses provider name.
                const wantedGh = remoteList.includes('github');
                const wantedGl = remoteList.includes('gitlab');
                if (wantedGh)
                    remotes.push({ name: 'origin', provider: 'github', url: findUrl('github') });
                if (wantedGl) {
                    remotes.push({
                        name: wantedGh ? 'gitlab' : 'origin',
                        provider: 'gitlab',
                        url: findUrl('gitlab'),
                    });
                }
            }
            const protected_branches = deriveProtectedBranches(branching_model, pr_target);
            const now = nowISO();
            db.transaction(() => {
                // Mark project as onboarded via plugin_config (#2876). The legacy
                // `identity` table is dropped by `migrateDropIdentityTable` in
                // db.ts on next boot; this writer no longer touches it.
                writeConfig(db, 'onboarded', true);
                writeConfig(db, 'branching_model', branching_model);
                writeConfig(db, 'pr_target', pr_target);
                writeConfig(db, 'protected_branches', protected_branches);
                writeConfig(db, 'remotes', remotes);
                writeConfig(db, 'issue_sync', issue_sync);
            });
            return ok({
                ok: true,
                applied: {
                    onboarded: true,
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