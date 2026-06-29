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
import { existsSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBPROCESS_TIMEOUT_MS, AUTH_PROBE_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason } from '../utils/live-cli-guard.js';
import { classifyUrl } from '../utils/classify-url.js';
import type { Provider } from '../utils/classify-url.js';
import { resolveSoleRepoPath } from '../utils/repo-paths.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { writeUserSettingsEnforcementShim } from './onboard-hooks-shim.js';

// Resolve the installed plugin's source root: prefer CLAUDE_PLUGIN_ROOT (must
// have .claude-plugin/plugin.json), else walk up from this module until that
// manifest is found — correct for both the tsc layout (dist/tools/onboard.js)
// and the esbuild bundle (dist/index.js). Returns null if unresolvable so the
// enforcement shim can skip gracefully.
function resolvePluginRoot(): string | null {
  const env = process.env['CLAUDE_PLUGIN_ROOT'];
  if (env && existsSync(join(env, '.claude-plugin', 'plugin.json'))) return env;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function wrapHandler(fn: Fn): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }
  };
}

// ---- Probe helpers -------------------------------------------------------

interface DetectedRemote {
  name: string;
  provider: Provider;
  url: string;
}

function probeGit(cwd: string): {
  in_git: boolean;
  detected_remotes: DetectedRemote[];
  origin_kind: Provider | null;
} {
  const opts = { encoding: 'utf8' as const, timeout: 3000, cwd };

  const inGitR = spawnSync('git', ['rev-parse', '--show-toplevel'], opts);
  const in_git = inGitR.status === 0;
  if (!in_git) return { in_git: false, detected_remotes: [], origin_kind: null };

  const remotesR = spawnSync('git', ['remote', '-v'], opts);
  const detected_remotes: DetectedRemote[] = [];
  if (remotesR.status === 0) {
    const seen = new Set<string>();
    const lines = (remotesR.stdout ?? '').split('\n');
    for (const line of lines) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
      if (!m) continue;
      const [, name, url] = m;
      if (seen.has(name)) continue;
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

function probeCli(cmd: string): { installed: boolean; authed: boolean } {
  const which = spawnSync('command', ['-v', cmd], { encoding: 'utf8', timeout: AUTH_PROBE_TIMEOUT_MS, shell: true });
  const installed = which.status === 0 && (which.stdout ?? '').trim().length > 0;
  if (!installed) return { installed: false, authed: false };

  if (liveCliBlockReason()) return { installed: true, authed: false };
  const authR = spawnSync(cmd, ['auth', 'status'], { encoding: 'utf8', timeout: SUBPROCESS_TIMEOUT_MS });
  return { installed: true, authed: authR.status === 0 };
}

// ---- DB helpers ----------------------------------------------------------

function readConfig(db: TrajectoryDB, key: string): unknown {
  const row = db.get<{ value_json: string }>(
    `SELECT value_json FROM plugin_config WHERE key = ?`,
    [key],
  );
  if (!row?.value_json) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

function writeConfig(db: TrajectoryDB, key: string, value: unknown): void {
  db.run(
    `INSERT INTO plugin_config (key, value_json)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    [key, JSON.stringify(value)],
  );
}

// Read the four repo-scoped policy keys from the repos table — the sole source
// of truth (#980). onboard applies policy workspace-wide (every repos row gets
// the same values), so the representative first row reflects current state.
// Returns null for each field on an empty repos table or a NULL column.
function readRepoPolicy(db: TrajectoryDB): {
  branching_model: string | null;
  pr_target: string | null;
  protected_branches: unknown;
  remotes: unknown;
} {
  const row = db.get<{
    target_branch: string | null;
    branching_model: string | null;
    protected_branches: string | null;
    remotes: string | null;
  }>(
    `SELECT target_branch, branching_model, protected_branches, remotes
       FROM repos ORDER BY name LIMIT 1`,
  );
  const parseJson = (s: string | null): unknown => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return {
    branching_model: row?.branching_model ?? null,
    pr_target: row?.target_branch ?? null,
    protected_branches: parseJson(row?.protected_branches ?? null),
    remotes: parseJson(row?.remotes ?? null),
  };
}

interface RepoPolicyRow {
  name: string;
  target_branch: string | null;
  branching_model: string | null;
}

// Read one repos row by name for the per-repo onboard path. Returns null when
// no such repo is registered — callers surface a validation error so the
// per-repo path never writes blind.
function readRepoRow(db: TrajectoryDB, repo: string): RepoPolicyRow | null {
  const row = db.get<RepoPolicyRow>(
    `SELECT name, target_branch, branching_model FROM repos WHERE name = ?`,
    [repo],
  );
  return row ?? null;
}

function readOnboardedFlag(db: TrajectoryDB): boolean {
  // value_json is JSON-encoded — `"true"` is the canonical truthy value.
  const row = db.get<{ value_json: string }>(
    `SELECT value_json FROM plugin_config WHERE key = 'onboarded'`,
  );
  if (!row?.value_json) return false;
  try {
    return JSON.parse(row.value_json) === true;
  } catch {
    return false;
  }
}

function deriveProtectedBranches(branchingModel: string, prTarget: string): string[] {
  if (branchingModel === 'gitflow') {
    const set = new Set(['main', prTarget]);
    return Array.from(set);
  }
  return [prTarget];
}

function derivePrTargetDefault(branchingModel: string): string {
  // gitflow → 'dev' (most common modern variant; GitLab Flow + many repos).
  // Users on classic Git Flow with 'develop' override via the AUQ option or
  // re-onboard later. Picked over 'develop' as the default because real-world
  // surveys (2026-05) show 'dev' as the more frequent long-lived integration
  // branch name across the active GitLab/GitHub ecosystem.
  return branchingModel === 'gitflow' ? 'dev' : 'main';
}

// ---- Question builders ---------------------------------------------------

const KEEP_SENTINEL = '__keep__';

interface QuestionOption {
  label: string;
  description: string;
  wire: string;
  disabled?: boolean;
}

interface BuiltQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  // 0-based index of the option the caller should preselect.
  default_index: number;
}

const BRANCHING_DESCRIPTIONS = {
  'github-flow':
    'One long-lived branch (main). Each task gets its own short-lived branch off main; you open a PR back to main when it\'s ready. No release branches. Suitable for continuous deploys.',
  gitflow:
    'Two long-lived branches (main + dev). Daily work merges into the integration branch (commonly named "dev" — older repos may name it "develop"); release branches are cut from there and merged into main when shipping. Hotfixes go straight to main. Suitable for versioned releases.',
};

// Name is intentionally NOT a built question — it's free-text input that
// AUQ's radio model fits poorly (the auto-rendered "Other" field clutters
// the picker with 3 effective options when only 2 are conceptually offered:
// "Anonymous" or "type your name"). The skill body asks Name in plain prose
// and feeds the parsed answer straight to `onboard_apply`. See commands/onboard.md.

function shapeQuestion(origin_kind: Provider | null): BuiltQuestion {
  const options: QuestionOption[] = [
    {
      label: 'Remote-tracked',
      description: 'Pushes to GitHub or GitLab. Issues can mirror to the remote.',
      wire: 'remote',
    },
    {
      label: 'Local-only',
      description: 'No GitHub/GitLab. Issues stay in the local trajectory DB; no PR/MR pushes.',
      wire: 'local',
    },
  ];
  const default_index = origin_kind === 'github' || origin_kind === 'gitlab' ? 0 : 1;
  return {
    question: 'Is this project local-only or remote-tracked?',
    header: 'Shape',
    multiSelect: false,
    options,
    default_index,
  };
}

function branchingQuestion(currentModel: string | null, isReonboard: boolean): BuiltQuestion {
  const options: QuestionOption[] = [];
  if (isReonboard && currentModel !== null) {
    options.push({ label: `Keep "${currentModel}"`, description: 'No change.', wire: KEEP_SENTINEL });
  }
  options.push({
    label: 'GitHub Flow',
    description: BRANCHING_DESCRIPTIONS['github-flow'],
    wire: 'github-flow',
  });
  options.push({
    label: 'Git Flow',
    description: BRANCHING_DESCRIPTIONS.gitflow,
    wire: 'gitflow',
  });
  return {
    question: 'How does your team branch?',
    header: 'Branching',
    multiSelect: false,
    options,
    default_index: 0,
  };
}

function prTargetQuestion(
  currentTarget: string | null,
  branchingModel: string | null,
  isReonboard: boolean,
): BuiltQuestion {
  const options: QuestionOption[] = [];
  if (isReonboard && currentTarget !== null) {
    options.push({ label: `Keep "${currentTarget}"`, description: 'No change.', wire: KEEP_SENTINEL });
  }
  options.push(
    { label: 'main', description: 'Most common default.', wire: 'main' },
    { label: 'dev', description: 'Common for GitLab Flow + modern Git Flow variants.', wire: 'dev' },
    { label: 'develop', description: 'Classic Git Flow convention.', wire: 'develop' },
  );

  // First-run pre-select by branching_model: github-flow → main, gitflow → dev.
  // 'develop' is offered as a secondary option for classic Git Flow repos.
  // master / older targets aren't offered as labeled options (rare in modern
  // projects). Users who actually need master/release/etc. type it via Other.
  let default_index = 0;
  if (!isReonboard) {
    const want = branchingModel === 'gitflow' ? 'dev' : 'main';
    default_index = options.findIndex((o) => o.label === want);
    if (default_index < 0) default_index = 0;
  }
  return {
    question: "What's your PR target branch?",
    header: 'PR target',
    multiSelect: false,
    options,
    default_index,
  };
}

function remoteQuestion(
  origin_kind: Provider | null,
  gh_installed: boolean,
  glab_installed: boolean,
  _isReonboard: boolean,
  _currentRemotes: unknown,
): BuiltQuestion {
  // multiSelect: pick one or both checkboxes (no separate "Both" option).
  // Keep options don't apply on a multiSelect — re-onboard users just check
  // whichever providers they want; submitting unchanged is a valid no-op
  // outcome, but the answer set is the new state.
  const options: QuestionOption[] = [
    {
      label: gh_installed ? 'GitHub' : 'GitHub (CLI not installed)',
      description: 'github.com or GitHub Enterprise.',
      wire: 'github',
      disabled: !gh_installed,
    },
    {
      label: glab_installed ? 'GitLab' : 'GitLab (CLI not installed)',
      description: 'gitlab.com or self-hosted GitLab.',
      wire: 'gitlab',
      disabled: !glab_installed,
    },
  ];

  // Pre-select via probe.origin_kind.
  let default_index = 0;
  const want = origin_kind === 'github' ? 'GitHub' : origin_kind === 'gitlab' ? 'GitLab' : null;
  if (want) {
    const idx = options.findIndex((o) => o.label === want || o.label.startsWith(want + ' '));
    if (idx >= 0 && !options[idx].disabled) default_index = idx;
  }

  return {
    question: 'Which remote(s) does this project use?',
    header: 'Remote',
    multiSelect: true,
    options,
    default_index,
  };
}

function issueSyncQuestion(
  currentSync: string | null,
  isReonboard: boolean,
  authedAtLeastOne: boolean,
): BuiltQuestion {
  const options: QuestionOption[] = [];
  if (isReonboard && currentSync !== null) {
    options.push({ label: `Keep "${currentSync}"`, description: 'No change.', wire: KEEP_SENTINEL });
  }
  options.push({
    label: 'Auto — sync to the remote you picked',
    description: authedAtLeastOne
      ? '`issue_create` mirrors to GitHub/GitLab as well as the local DB.'
      : 'WARNING: no gh/glab auth detected. Sync will retry until you authenticate.',
    wire: 'auto',
  });
  options.push({
    label: 'Off — local DB only',
    description: 'Issues stay in the trajectory DB; no remote mirror.',
    wire: 'off',
  });
  return {
    question: 'Mirror new MCP issues to your remote?',
    header: 'Issue sync',
    multiSelect: false,
    options,
    default_index: 0,
  };
}

// ---- Label → wire resolution -----------------------------------------------

// Resolve a caller-supplied value against a set of options.
// Accepts exact wire values unchanged; falls back to case-insensitive label match.
// KEEP_SENTINEL passed directly is always returned as-is (caller signals omission).
// Returns the wire value, or null if nothing matched.
function resolveOption(value: string, options: QuestionOption[]): string | null {
  if (value === KEEP_SENTINEL) return KEEP_SENTINEL;
  const wire = options.find((o) => o.wire === value);
  if (wire) return wire.wire;
  const byLabel = options.find((o) => o.label.toLowerCase() === value.toLowerCase());
  if (byLabel) return byLabel.wire;
  return null;
}

// Canonical option sets used for label resolution in onboard_apply.
// These mirror the question builders but are static (no per-call logic needed
// for label resolution — the full label set is always the superset).
const BRANCHING_OPTIONS: QuestionOption[] = [
  { label: 'GitHub Flow', description: '', wire: 'github-flow' },
  { label: 'Git Flow', description: '', wire: 'gitflow' },
];

const PR_TARGET_OPTIONS: QuestionOption[] = [
  { label: 'main', description: '', wire: 'main' },
  { label: 'dev', description: '', wire: 'dev' },
  { label: 'develop', description: '', wire: 'develop' },
];

const REMOTE_OPTIONS: QuestionOption[] = [
  { label: 'GitHub', description: '', wire: 'github' },
  { label: 'GitHub (CLI not installed)', description: '', wire: 'github' },
  { label: 'GitLab', description: '', wire: 'gitlab' },
  { label: 'GitLab (CLI not installed)', description: '', wire: 'gitlab' },
];

const ISSUE_SYNC_OPTIONS: QuestionOption[] = [
  { label: 'Auto — sync to the remote you picked', description: '', wire: 'auto' },
  { label: 'Off — local DB only', description: '', wire: 'off' },
];

// ---- Tool definitions ----------------------------------------------------

export function onboardTools(db: TrajectoryDB, dbPath = ''): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'onboard_state_get',
      description:
        'Read onboard state: first-run flag, current plugin_config, and git/CLI probe (origin URL → provider, gh/glab auth). Call once before AskUserQuestion.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'onboard_get_questions',
      description:
        'Build AUQ-ready question objects for one /onboard round. Applies Keep options, disabled CLI options, probe defaults. Each option carries wire — pass option.wire (or label) to onboard_apply.',
      inputSchema: {
        type: 'object',
        properties: {
          shape: {
            type: 'string',
            enum: ['local', 'remote'],
            description: "Project shape from Round 1. Not required when round='shape'.",
          },
          round: {
            type: 'string',
            enum: ['shape', 'main', 'sync'],
            description:
              "'shape' = Round 1 (project shape — Local-only vs Remote-tracked; probe-derived default_index). 'main' = Round 2 questions (branching, plus pr_target/remote on remote shape). 'sync' = Round 3 (remote shape only — issue_sync).",
          },
          repo: {
            type: 'string',
            description:
              "Optional. Scope the branching + pr_target questions to a single repos row (Keep options seed from that repo's target_branch/branching_model). Only valid with round='main', shape='remote'. Must match an existing repos.name. Omit for workspace-wide questions.",
          },
        },
        required: ['round'],
      },
    },
    {
      name: 'onboard_apply',
      description:
        'Persist /onboard answers in one transaction. Derives pr_target + protected_branches from branching_model, writes onboarded marker. Accepts wire values or human-readable labels (case-insensitive). Keep options omit the key.',
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
          repo: {
            type: 'string',
            description:
              "Optional. Scope the write to a single repos row: only that row's target_branch/branching_model/protected_branches are updated; other repos rows, remotes, issue_sync, and the onboarded marker are NOT touched. Must match an existing repos.name. Omit for the workspace-wide apply.",
          },
        },
        required: ['shape'],
      },
    },
  ];

  // The probe must run inside the sole (registered) repo's git tree, not the workspace
  // root. In a multi-repo workspace the trajectory.db lives above the repos,
  // so the stripped workspace path is not a git repo at all (#675) — git
  // probes there report in_git:false and detect no remotes, persisting blank
  // remote URLs that silently disable issue-sync. Prefer the authoritative
  // single-repo path (path-keyed resolution); fall back to the legacy
  // workspace-root derivation only when it can't be resolved.
  const probeDir = (): string => {
    const fromSoleRepo = resolveSoleRepoPath(db);
    if (fromSoleRepo) return fromSoleRepo;
    const workspaceRoot = dbPath
      ? dbPath.replace(/\.claude\/[^/]+\/trajectory\.db$/, '').replace(/\/$/, '')
      : process.cwd();
    return workspaceRoot || process.cwd();
  };

  const handlers: Record<string, Fn> = {
    onboard_state_get: requireRoles(
      'onboard_state_get',
      ['bro'],
      wrapHandler(async () => {
        const git = probeGit(probeDir());
        const gh = probeCli('gh');
        const glab = probeCli('glab');

        const onboarded = readOnboardedFlag(db);
        // first_run is signalled by identity row absence. The row is a pure
        // onboarded marker — bro doesn't store names or any other identity
        // attributes, so row presence alone suppresses the auto-fire trigger
        // on cold restart (#95).
        const first_run = !onboarded;

        const policy = readRepoPolicy(db);
        return ok({
          first_run,
          current: {
            branching_model: policy.branching_model,
            pr_target: policy.pr_target,
            protected_branches: policy.protected_branches,
            remotes: policy.remotes,
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
      }),
    ),

    onboard_get_questions: requireRoles(
      'onboard_get_questions',
      ['bro'],
      wrapHandler(async (args) => {
        const shape = args['shape'] as 'local' | 'remote' | undefined;
        const round = args['round'] as 'shape' | 'main' | 'sync';
        const repo = args['repo'] as string | undefined;

        const git = probeGit(probeDir());

        if (round === 'shape') {
          return ok({ questions: [shapeQuestion(git.origin_kind)] });
        }

        // Per-repo path: branching + pr_target questions seeded from THAT repos
        // row. Only valid on round='main', shape='remote'. The Keep options
        // reflect the repo's current target_branch/branching_model; the remote
        // provider question (git-derived) and issue_sync (global, sync round)
        // stay out of the per-repo path.
        if (repo !== undefined) {
          if (round !== 'main') {
            throw new Error(`repo param is only valid with round='main' (got '${round}')`);
          }
          if (shape !== 'remote') {
            throw new Error(`repo param requires shape='remote' (got '${String(shape)}')`);
          }
          const repoRow = readRepoRow(db, repo);
          if (!repoRow) {
            throw new Error(`unknown repo '${repo}' — no matching repos row`);
          }
          const isReonboardRepo = repoRow.branching_model !== null;
          const repoQuestions: BuiltQuestion[] = [
            branchingQuestion(repoRow.branching_model, isReonboardRepo),
            prTargetQuestion(repoRow.target_branch, repoRow.branching_model, isReonboardRepo),
          ];
          return ok({ questions: repoQuestions });
        }

        // Re-onboard means /onboard already ran in this project — identity row exists.
        const isReonboard = readOnboardedFlag(db);
        const policy = readRepoPolicy(db);
        const currentBranching = policy.branching_model;
        const currentPrTarget = policy.pr_target;
        const currentRemotes = policy.remotes;
        const currentSync = readConfig(db, 'issue_sync') as string | null;

        const gh = probeCli('gh');
        const glab = probeCli('glab');

        const questions: BuiltQuestion[] = [];

        if (round === 'main') {
          if (shape === 'remote' || isReonboard) {
            // Local re-onboard adds Branching so the Human can change models.
            // Local first-run skips Branching entirely (silent default).
            questions.push(branchingQuestion(currentBranching, isReonboard));
          }
          if (shape === 'remote') {
            questions.push(prTargetQuestion(currentPrTarget, currentBranching, isReonboard));
            questions.push(
              remoteQuestion(git.origin_kind, gh.installed, glab.installed, isReonboard, currentRemotes),
            );
          }
          // shape=local + first-run yields questions=[] — skill skips AUQ Round 2.
        } else if (round === 'sync') {
          if (shape !== 'remote') {
            throw new Error(`round='sync' only valid for shape='remote' (got '${String(shape)}')`);
          }
          questions.push(issueSyncQuestion(currentSync, isReonboard, gh.authed || glab.authed));
        } else {
          throw new Error(`unknown round '${String(round)}'`);
        }

        return ok({ questions });
      }),
    ),

    onboard_apply: requireRoles(
      'onboard_apply',
      ['bro'],
      wrapHandler(async (args) => {
        const shape = args['shape'] as 'local' | 'remote';
        if (shape !== 'local' && shape !== 'remote') {
          throw new Error(`shape must be 'local' or 'remote' (got '${shape}')`);
        }

        // Per-repo path: write branching_model + derived protected_branches +
        // target_branch to ONLY this repos row. Other repos rows, remotes,
        // issue_sync, and the onboarded marker are untouched. Keep sentinels
        // read from the repos row, not the global config.
        const repo = args['repo'] as string | undefined;
        if (repo !== undefined) {
          const repoRow = readRepoRow(db, repo);
          if (!repoRow) {
            throw new Error(`unknown repo '${repo}' — no matching repos row`);
          }

          const rawBranchingRepo = args['branching_model'] as string | undefined;
          let branchingRepo: string | undefined;
          if (rawBranchingRepo !== undefined) {
            const resolved = resolveOption(rawBranchingRepo, BRANCHING_OPTIONS);
            if (resolved === KEEP_SENTINEL) {
              branchingRepo = repoRow.branching_model ?? undefined;
            } else if (resolved !== null) {
              branchingRepo = resolved;
            } else {
              branchingRepo = rawBranchingRepo;
            }
          } else {
            branchingRepo = repoRow.branching_model ?? undefined;
          }
          branchingRepo = branchingRepo ?? 'github-flow';
          if (branchingRepo !== 'github-flow' && branchingRepo !== 'gitflow') {
            throw new Error(`branching_model must be 'github-flow' or 'gitflow' (got '${branchingRepo}')`);
          }

          const rawPrTargetRepo = args['pr_target'] as string | undefined;
          let prTargetRepo: string;
          if (rawPrTargetRepo !== undefined) {
            const resolved = resolveOption(rawPrTargetRepo, PR_TARGET_OPTIONS);
            if (resolved === KEEP_SENTINEL) {
              prTargetRepo = repoRow.target_branch ?? derivePrTargetDefault(branchingRepo);
            } else {
              prTargetRepo = resolved ?? rawPrTargetRepo;
            }
          } else {
            prTargetRepo = repoRow.target_branch ?? derivePrTargetDefault(branchingRepo);
          }

          const protectedRepo = deriveProtectedBranches(branchingRepo, prTargetRepo);

          db.run(
            `UPDATE repos SET target_branch = ?, branching_model = ?, protected_branches = ? WHERE name = ?`,
            [prTargetRepo, branchingRepo, JSON.stringify(protectedRepo), repo],
          );

          return ok({
            ok: true,
            applied: {
              repo,
              branching_model: branchingRepo,
              pr_target: prTargetRepo,
              protected_branches: protectedRepo,
            },
          });
        }

        // Resolve branching_model — accept wire value or human-readable label.
        // Keep sentinel → omit (use existing value or local default).
        const rawBranching = args['branching_model'] as string | undefined;
        let branching_model: string | undefined;
        if (rawBranching !== undefined) {
          const resolved = resolveOption(rawBranching, BRANCHING_OPTIONS);
          if (resolved === KEEP_SENTINEL) {
            branching_model = readRepoPolicy(db).branching_model ?? undefined;
          } else if (resolved !== null) {
            branching_model = resolved;
          } else {
            branching_model = rawBranching;
          }
        }
        branching_model = branching_model ?? (shape === 'local' ? 'github-flow' : undefined);
        if (!branching_model) {
          throw new Error('branching_model is required for shape=remote');
        }
        if (branching_model !== 'github-flow' && branching_model !== 'gitflow') {
          throw new Error(`branching_model must be 'github-flow' or 'gitflow' (got '${branching_model}')`);
        }

        // Resolve pr_target — accept wire value or label; Keep → use existing.
        const rawPrTarget = args['pr_target'] as string | undefined;
        let pr_target: string;
        if (rawPrTarget !== undefined) {
          const resolved = resolveOption(rawPrTarget, PR_TARGET_OPTIONS);
          if (resolved === KEEP_SENTINEL) {
            pr_target = readRepoPolicy(db).pr_target ?? derivePrTargetDefault(branching_model);
          } else {
            pr_target = resolved ?? rawPrTarget;
          }
        } else {
          pr_target = derivePrTargetDefault(branching_model);
        }

        let remotes: Array<{ name: string; provider: Provider; url: string }> = [];
        let issue_sync: 'auto' | 'off' = 'off';
        let warning: string | undefined;
        if (shape === 'remote') {
          const rawRemote = args['remote'];
          // Accept array (canonical, post-multiSelect) or string (legacy/single).
          let remoteList: string[];
          if (Array.isArray(rawRemote)) {
            remoteList = rawRemote.filter((s): s is string => typeof s === 'string');
          } else if (typeof rawRemote === 'string') {
            remoteList = [rawRemote];
          } else {
            throw new Error("'remote' is required when shape='remote'");
          }
          if (remoteList.length === 0) {
            throw new Error("'remote' must include at least one of 'github' / 'gitlab' when shape='remote'");
          }
          // Resolve each entry — accept wire value or label.
          remoteList = remoteList.map((r) => {
            const resolved = resolveOption(r, REMOTE_OPTIONS);
            if (resolved !== null) return resolved;
            return r;
          });
          for (const r of remoteList) {
            if (r !== 'github' && r !== 'gitlab') {
              throw new Error(`remote entries must be 'github' or 'gitlab' (got '${r}')`);
            }
          }

          // Resolve issue_sync — accept wire value or label; Keep → use existing.
          const rawSync = args['issue_sync'] as string | undefined;
          if (rawSync !== undefined) {
            const resolved = resolveOption(rawSync, ISSUE_SYNC_OPTIONS);
            if (resolved === KEEP_SENTINEL) {
              issue_sync = ((readConfig(db, 'issue_sync') as string | null) ?? 'off') as 'auto' | 'off';
            } else if (resolved === 'auto' || resolved === 'off') {
              issue_sync = resolved;
            } else {
              issue_sync = (rawSync as 'auto' | 'off') ?? 'off';
            }
          }
          if (issue_sync !== 'auto' && issue_sync !== 'off') {
            throw new Error(`issue_sync must be 'auto' or 'off' (got '${String(issue_sync)}')`);
          }

          const git = probeGit(probeDir());
          const findUrl = (p: Provider): string =>
            git.detected_remotes.find((r) => r.provider === p)?.url ?? '';
          // Stable order: github first, then gitlab. The first entry uses
          // name='origin'; if both are present the second uses provider name.
          const wantedGh = remoteList.includes('github');
          const wantedGl = remoteList.includes('gitlab');
          if (wantedGh) remotes.push({ name: 'origin', provider: 'github', url: findUrl('github') });
          if (wantedGl) {
            remotes.push({
              name: wantedGh ? 'gitlab' : 'origin',
              provider: 'gitlab',
              url: findUrl('gitlab'),
            });
          }

          // Defensive: if the origin remote's URL is still blank after the
          // probe, issue-sync will silently skip (blank_remote_url). Surface a
          // warning so the operator can fix the repo's git remote rather than
          // discover the silent skip later (#675).
          const origin = remotes.find((r) => r.name === 'origin');
          if (origin && origin.url.length === 0) {
            warning = `remote URL not detected for ${origin.provider}; issues will not sync — check the repo's git remote`;
          }
        }

        const protected_branches = deriveProtectedBranches(branching_model, pr_target);

        db.transaction(() => {
          // Mark project as onboarded via plugin_config (#2876).
          // The legacy `identity` table is dropped by the v1→v2 migration in db.ts on first boot after upgrade.
          writeConfig(db, 'onboarded', true);

          writeConfig(db, 'issue_sync', issue_sync);

          // The repos table is the sole source of truth for the four repo-scoped
          // keys (#980). onboard applies workspace-wide, so every repos row gets
          // the same values; issue-scoped sync reads repos.remotes per repo.
          db.run(
            `UPDATE repos SET target_branch = ?, branching_model = ?, protected_branches = ?, remotes = ?`,
            [pr_target, branching_model, JSON.stringify(protected_branches), JSON.stringify(remotes)],
          );
        });

        // Best-effort: write TMB PreToolUse hooks into the user settings.json so
        // enforcement fires in non-interactive `claude -p` runs under a
        // marketplace install (plugin hooks don't fire there). A failure must
        // NOT fail onboarding.
        try {
          writeUserSettingsEnforcementShim({ pluginRoot: resolvePluginRoot(), homeDir: os.homedir() });
        } catch {
          // Shim is best-effort; onboarding still succeeds.
        }

        return ok({
          ok: true,
          ...(warning ? { warning } : {}),
          applied: {
            onboarded: true,
            branching_model,
            pr_target,
            protected_branches,
            remotes,
            issue_sync,
            ...(warning ? { warning } : {}),
          },
        });
      }),
    ),
  };

  return { definitions, handlers };
}
