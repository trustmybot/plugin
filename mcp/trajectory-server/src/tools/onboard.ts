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
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_STANDALONE_MARKER,
  canonicalExisting,
  claudeDbCounts,
  claudeProjectRootOfDb,
  claudeStateDir,
  isPathWithin,
  isStandaloneClaudeDb,
  otherClaudeDbs,
  resolveClaudeSessionDir,
  type OtherClaudeDb,
} from '../platform.js';
import { insertAudit } from './audit.js';
import { SUBPROCESS_TIMEOUT_MS, AUTH_PROBE_TIMEOUT_MS } from '../utils/timeouts.js';
import { liveCliBlockReason } from '../utils/live-cli-guard.js';
import { classifyUrl } from '../utils/classify-url.js';
import type { Provider } from '../utils/classify-url.js';
import { repoRowPath, resolveSoleRepoPath } from '../utils/repo-paths.js';
import { remotesView, repoRemotes, upsertRepoRemotes, type RemoteProvider } from '../repos/remotes.js';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TrajectoryDB } from '../db.js';
import { requireRoles } from '../middleware/agent-scope.js';
import {
  removeProjectEnforcementShim,
  writeProjectEnforcementShim,
} from './onboard-hooks-shim.js';
import {
  isSshRemote,
  removeProjectSandbox,
  sandboxRecommended,
  writeProjectSandbox,
  type SandboxRecord,
} from './onboard-sandbox.js';
import { scanWorkspace, type Recommendation, type WorkspaceScan } from './onboard-scan.js';

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

// Whether a branch ref exists in the repo at `cwd`. Mirrors the hooks'
// rev-parse --verify probe (resolve-repo.sh): a missing ref means that repo
// cannot run a model whose long-lived target is that branch.
function branchExists(cwd: string, branch: string): boolean {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    encoding: 'utf8',
    timeout: 3000,
  });
  return r.status === 0;
}

// The repo's real default branch — same resolution order as the hooks'
// tmb_repo_default_branch (resolve-repo.sh): origin/HEAD's target → first of
// main/master/dev that exists → the checked-out HEAD → 'main'.
function repoDefaultBranch(cwd: string): string {
  const opts = { encoding: 'utf8' as const, timeout: 3000 };
  const head = spawnSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], opts);
  if (head.status === 0) {
    const b = (head.stdout ?? '').trim().replace(/^origin\//, '');
    if (b) return b;
  }
  for (const cand of ['main', 'master', 'dev']) {
    const r = spawnSync('git', ['-C', cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${cand}`], opts);
    if (r.status === 0) return cand;
  }
  const cur = spawnSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'], opts);
  if (cur.status === 0) {
    const b = (cur.stdout ?? '').trim();
    if (b) return b;
  }
  return 'main';
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

// Read the four repo-scoped policy keys from the repos table and its
// repo_remotes rows — the sole source of truth (#980). The first row is the
// representative sample the `applied` payload and the workspace PR-target Keep
// option read; rows may differ after per-repo applies.
// Returns null for each field on an empty repos table or a NULL column.
function readRepoPolicy(db: TrajectoryDB): {
  branching_model: string | null;
  pr_target: string | null;
  protected_branches: unknown;
  remote_list: Array<{ name: string; provider: string; url: string }> | null;
} {
  const row = db.get<{
    name: string;
    target_branch: string | null;
    branching_model: string | null;
    protected_branches: string | null;
  }>(
    `SELECT name, target_branch, branching_model, protected_branches
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
    remote_list: row ? remotesView(repoRemotes(db, row.name)) : null,
  };
}

interface RepoPolicyRow {
  name: string;
  target_branch: string | null;
  branching_model: string | null;
  recommendation: Recommendation | null;
}

function parseStoredRecommendation(json: string | null): Recommendation | null {
  if (!json) return null;
  try {
    const rec = (JSON.parse(json) as { recommendation?: Recommendation | null }).recommendation;
    return rec && typeof rec === 'object' && Array.isArray(rec.evidence) ? rec : null;
  } catch {
    return null;
  }
}

// Read one repos row by name for the per-repo onboard path. Returns null when
// no such repo is registered — callers surface a validation error so the
// per-repo path never writes blind.
function readRepoRow(db: TrajectoryDB, repo: string): RepoPolicyRow | null {
  const row = db.get<Omit<RepoPolicyRow, 'recommendation'> & { onboard_scan: string | null }>(
    `SELECT name, target_branch, branching_model, onboard_scan FROM repos WHERE name = ?`,
    [repo],
  );
  if (!row) return null;
  const { onboard_scan, ...policy } = row;
  return { ...policy, recommendation: parseStoredRecommendation(onboard_scan) };
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
  recommended?: boolean;
}

interface BuiltQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  // 0-based index of the option the caller should preselect.
  default_index: number;
  evidence: string[];
  recommended_reason: string | null;
}

interface Advice {
  evidence: string[];
  reason: string | null;
  wire: string | null;
}

const NO_ADVICE: Advice = { evidence: [], reason: null, wire: null };

const BRANCHING_DESCRIPTIONS = {
  'github-flow': 'One main branch; every change is a short branch plus a pull request.',
  gitflow: 'Two long-lived branches; daily work lands on dev, releases go to main.',
};

const HOST_NAMES: Record<RemoteProvider, string> = { github: 'GitHub', gitlab: 'GitLab', other: 'another host' };

function keepOption(current: string | null, show: boolean): QuestionOption | null {
  return show && current !== null ? { label: `Keep "${current}"`, description: 'No change.', wire: KEEP_SENTINEL } : null;
}

function assemble(
  keep: QuestionOption | null,
  choices: QuestionOption[],
  advice: Advice,
  fallbackWire: string | null,
): Pick<BuiltQuestion, 'options' | 'default_index' | 'evidence' | 'recommended_reason'> {
  const at = advice.wire === null ? -1 : choices.findIndex((o) => o.wire === advice.wire && !o.disabled);
  const ordered = at < 0 ? choices : [{ ...choices[at]!, recommended: true }, ...choices.filter((_, i) => i !== at)];
  const options = keep ? [keep, ...ordered] : ordered;
  let default_index = 0;
  if (!keep && at < 0 && fallbackWire !== null) {
    default_index = Math.max(0, options.findIndex((o) => o.wire === fallbackWire && !o.disabled));
  }
  return { options, default_index, evidence: advice.evidence, recommended_reason: advice.reason };
}

function scanSummaryLine(scan: WorkspaceScan): string {
  const n = scan.summary.repo_count;
  const parts: string[] = [];
  for (const host of ['github', 'gitlab', 'other'] as const) {
    const count = scan.repos.filter((r) => r.remotes.some((x) => x.host === host)).length;
    if (count > 0) parts.push(`${count} ${count === 1 ? 'pushes' : 'push'} to ${HOST_NAMES[host]}`);
  }
  const none = scan.repos.filter((r) => r.remotes.length === 0).length;
  if (none > 0) parts.push(`${none} ${none === 1 ? 'has' : 'have'} no remote`);
  return `Found ${n} git ${n === 1 ? 'repository' : 'repositories'} under this folder; ${parts.join(', ')}.`;
}

function shapeAdvice(scan: WorkspaceScan, origin_kind: Provider | null): Advice {
  if (scan.summary.repo_count === 0) return NO_ADVICE;
  const evidence = [scanSummaryLine(scan)];
  if (scan.repos.every((r) => r.remotes.length === 0)) {
    return { evidence, reason: 'no repository has a remote, so there is nothing to push to', wire: 'local' };
  }
  if (origin_kind === 'github' || origin_kind === 'gitlab') {
    return { evidence, reason: `this project's origin remote is on ${HOST_NAMES[origin_kind]}`, wire: 'remote' };
  }
  return { evidence, reason: null, wire: null };
}

function workspaceRecommendation(scan: WorkspaceScan): Recommendation | null {
  if (scan.summary.repo_count === 1) return scan.repos[0]?.recommendation ?? null;
  if (!scan.summary.uniform) return null;
  const recs = scan.repos.flatMap((r) => (r.recommendation ? [{ name: r.name, rec: r.recommendation }] : []));
  const first = recs[0];
  if (!first) return null;
  return {
    ...first.rec,
    reason: `all ${recs.length} repositories send their changes to ${first.rec.pr_target}`,
    evidence: recs.map(({ name, rec }) => `${name}: ${rec.evidence[0] ?? rec.reason}`),
  };
}

// High confidence picks the options; low confidence still shows the facts
// and the reason but keeps today's defaults; none shows nothing.
function branchingAdvice(rec: Recommendation | null): { branching: Advice; prTarget: Advice } {
  if (!rec || rec.confidence === 'none') return { branching: NO_ADVICE, prTarget: NO_ADVICE };
  const pick = rec.confidence === 'high';
  return {
    branching: { evidence: rec.evidence, reason: rec.reason, wire: pick ? rec.branching_model : null },
    prTarget: { evidence: rec.evidence, reason: rec.reason, wire: pick ? rec.pr_target : null },
  };
}

function shapeQuestion(origin_kind: Provider | null, advice: Advice): BuiltQuestion {
  const choices: QuestionOption[] = [
    {
      label: 'Remote-tracked',
      description: 'Work is pushed to GitHub or GitLab, with pull requests and synced issues.',
      wire: 'remote',
    },
    {
      label: 'Local-only',
      description: 'Nothing leaves this computer. Pull requests and issue sync are off.',
      wire: 'local',
    },
  ];
  const probeDefault = origin_kind === 'github' || origin_kind === 'gitlab' ? 'remote' : 'local';
  return {
    question: 'Does this project push to GitHub or GitLab, or stay on this computer?',
    header: 'Shape',
    multiSelect: false,
    ...assemble(null, choices, advice, probeDefault),
  };
}

function branchingQuestion(currentModel: string | null, isReonboard: boolean, advice: Advice): BuiltQuestion {
  const choices: QuestionOption[] = [
    { label: 'GitHub Flow', description: BRANCHING_DESCRIPTIONS['github-flow'], wire: 'github-flow' },
    { label: 'Git Flow', description: BRANCHING_DESCRIPTIONS.gitflow, wire: 'gitflow' },
  ];
  return {
    question: 'How does your team branch?',
    header: 'Branching',
    multiSelect: false,
    ...assemble(keepOption(currentModel, isReonboard), choices, advice, 'github-flow'),
  };
}

function prTargetQuestion(
  currentTarget: string | null,
  branchingModel: string | null,
  isReonboard: boolean,
  advice: Advice,
): BuiltQuestion {
  const choices: QuestionOption[] = [
    { label: 'main', description: 'Changes go straight into main.', wire: 'main' },
    { label: 'dev', description: 'Changes go into dev first; main gets them at release time.', wire: 'dev' },
    { label: 'develop', description: 'Same as dev, for repositories that call that branch develop.', wire: 'develop' },
  ];
  if (advice.wire !== null && !choices.some((o) => o.wire === advice.wire)) {
    choices.push({
      label: advice.wire,
      description: `Changes go into ${advice.wire}, the branch this repository already uses.`,
      wire: advice.wire,
    });
  }
  // First run without a recommendation: github-flow → main, gitflow → dev.
  // Any other branch is typed via Other.
  const fallback = isReonboard ? null : branchingModel === 'gitflow' ? 'dev' : 'main';
  return {
    question: 'Which branch should your pull requests go into?',
    header: 'PR target',
    multiSelect: false,
    ...assemble(keepOption(currentTarget, isReonboard), choices, advice, fallback),
  };
}

function remoteAdvice(origin_kind: Provider | null, scan: WorkspaceScan): Advice {
  if (origin_kind === 'github' || origin_kind === 'gitlab') {
    return { evidence: [`The origin remote is on ${HOST_NAMES[origin_kind]}.`], reason: null, wire: origin_kind };
  }
  const hosts = scan.summary.hosts.filter((h): h is 'github' | 'gitlab' => h === 'github' || h === 'gitlab');
  if (hosts.length === 1) {
    const host = hosts[0]!;
    return { evidence: [`Every repository with a remote pushes to ${HOST_NAMES[host]}.`], reason: null, wire: host };
  }
  return NO_ADVICE;
}

function remoteQuestion(gh_installed: boolean, glab_installed: boolean, advice: Advice): BuiltQuestion {
  // multiSelect: pick one or both checkboxes (no separate "Both" option).
  // Keep options don't apply on a multiSelect — re-onboard users just check
  // whichever providers they want; the answer set is the new state.
  const choices: QuestionOption[] = [
    {
      label: gh_installed ? 'GitHub' : 'GitHub (CLI not installed)',
      description: 'github.com or a company GitHub server.',
      wire: 'github',
      disabled: !gh_installed,
    },
    {
      label: glab_installed ? 'GitLab' : 'GitLab (CLI not installed)',
      description: 'gitlab.com or a self-hosted GitLab server.',
      wire: 'gitlab',
      disabled: !glab_installed,
    },
  ];
  return {
    question: 'Where is this project hosted? Pick one or both.',
    header: 'Remote',
    multiSelect: true,
    ...assemble(null, choices, advice, null),
  };
}

function issueSyncQuestion(
  currentSync: string | null,
  isReonboard: boolean,
  auth: { gh_authed: boolean; glab_authed: boolean },
): BuiltQuestion {
  const authed = auth.gh_authed || auth.glab_authed;
  const signedIn = [auth.gh_authed ? 'GitHub (gh)' : null, auth.glab_authed ? 'GitLab (glab)' : null].filter(
    (s): s is string => s !== null,
  );
  const choices: QuestionOption[] = [
    {
      label: 'Auto — sync to the remote you picked',
      description: authed
        ? 'New issues also appear on GitHub or GitLab.'
        : 'Not signed in to gh or glab yet; syncing starts once you sign in.',
      wire: 'auto',
    },
    {
      label: 'Off — issues stay on this computer',
      description: 'Nothing is posted to GitHub or GitLab.',
      wire: 'off',
    },
  ];
  const advice: Advice = authed
    ? { evidence: [`Signed in to ${signedIn.join(' and ')}.`], reason: 'you are signed in, so new issues can be posted right away', wire: 'auto' }
    : { evidence: ['Not signed in to gh or glab.'], reason: null, wire: null };
  return {
    question: 'Copy new issues to GitHub or GitLab too?',
    header: 'Issue sync',
    multiSelect: false,
    ...assemble(keepOption(currentSync, isReonboard), choices, advice, 'auto'),
  };
}

function sandboxQuestion(
  current: string | null,
  isReonboard: boolean,
  remoteUrls: readonly string[],
  platform: NodeJS.Platform,
): BuiltQuestion {
  const keep = keepOption(current, isReonboard);
  const recommended = keep === null && sandboxRecommended(remoteUrls, platform);
  const ssh = remoteUrls.some(isSshRemote);
  const no: QuestionOption = {
    label: 'No',
    description: "Bash keeps Claude Code's defaults; TMB's own write guard still applies.",
    wire: 'no',
  };
  const yes: QuestionOption = {
    label: recommended ? SANDBOX_YES_RECOMMENDED : 'Yes',
    description:
      'Bash can only write inside this project and the model cache, and can only reach GitHub, the npm registry and your HTTPS git remotes.' +
      (platform === 'darwin' ? " gh needs macOS's TLS trust service, which slightly weakens isolation." : '') +
      (ssh ? ' Git over SSH bypasses the sandbox proxy, so your SSH remote fails: switch it to HTTPS.' : ''),
    wire: 'yes',
  };
  const advice: Advice = {
    evidence: ssh ? ['A git remote uses SSH, which the sandbox cannot reach.'] : [],
    reason: recommended ? 'the sandbox was tested on this platform and your git remotes use HTTPS' : null,
    wire: recommended ? 'yes' : null,
  };
  return {
    question:
      "Turn on Claude Code's Bash sandbox? Writes .claude/settings.local.json in this project: sandbox.enabled, sandbox.filesystem.allowWrite, sandbox.network.allowedDomains, sandbox.enableWeakerNetworkIsolation (macOS only), env.npm_config_cache and env.BUN_INSTALL_CACHE_DIR. When TMB creates that file in a git work tree, it also adds it to .gitignore.",
    header: 'Sandbox',
    multiSelect: false,
    ...assemble(keep, [no, yes], advice, 'no'),
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
  { label: 'Off — issues stay on this computer', description: '', wire: 'off' },
];

const HEADLESS_OPTIONS: QuestionOption[] = [
  { label: 'No', description: '', wire: 'no' },
  { label: 'Yes', description: '', wire: 'yes' },
];

const SANDBOX_YES_RECOMMENDED = 'Yes (Recommended)';

const SANDBOX_OPTIONS: QuestionOption[] = [
  ...HEADLESS_OPTIONS,
  { label: SANDBOX_YES_RECOMMENDED, description: '', wire: 'yes' },
];

export interface OnboardShimEnv {
  pluginRoot?: string | null;
  /** The platform the sandbox question and block are built for (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** The session directory the DB walk started from (default `CLAUDE_PROJECT_DIR`, else cwd). */
  sessionDir?: string;
}

export interface OnboardNesting {
  session_dir: string;
  project_root: string;
  /** The session directory lies strictly below the project root. */
  nested: boolean;
  other_dbs: OtherClaudeDb[];
}

// ---- Tool definitions ----------------------------------------------------

export function onboardTools(db: TrajectoryDB, dbPath = '', shimEnv: OnboardShimEnv = {}): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'onboard_state_get',
      description:
        'Read onboard state: first-run flag, current plugin_config, git/CLI probe (origin URL → provider, gh/glab auth), and nesting {session_dir, project_root, nested, other_dbs:[{path, issues, tasks, empty}]} for Round 0. Call once before AskUserQuestion.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'onboard_get_questions',
      description:
        'Build AUQ-ready question objects for one /onboard round. Applies Keep options, disabled CLI options, probe defaults. Each option carries wire — pass option.wire (or label) to onboard_apply. Each question carries evidence[] and recommended_reason to show above it.',
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
            enum: ['shape', 'main', 'sync', 'sandbox'],
            description:
              "'shape' = Round 1 (project shape — Local-only vs Remote-tracked; probe-derived default_index). 'main' = Round 2 questions (branching, plus pr_target/remote on remote shape). 'sync' = Round 3 (remote shape only — issue_sync). 'sandbox' = sandbox_enforcement (any shape; a fresh onboard defaults to Yes only on the platform where the recorded sandbox network probe passed and when no remote is SSH, else No; re-onboard defaults to Keep).",
          },
          repo: {
            type: 'string',
            description:
              "Optional. Scope the branching + pr_target questions to a single repos row (a Keep option appears only for a field that repo has stored). Only valid with round='main', for either shape. Must match an existing repos.name. Omit for workspace-wide questions.",
          },
        },
        required: ['round'],
      },
    },
    {
      name: 'onboard_apply',
      description:
        'Persist /onboard answers in one transaction. Derives pr_target + protected_branches from branching_model, writes onboarded marker. Accepts wire values or human-readable labels (case-insensitive). Keep options omit the key. Round 0: standalone=true alone makes the nested session dir its own project; remove_stray_dbs (alone or with shape) deletes empty stray DBs. headless_enforcement alone (after onboarding) turns headless enforcement on or off on request.',
      inputSchema: {
        type: 'object',
        properties: {
          shape: {
            type: 'string',
            enum: ['local', 'remote'],
            description:
              'Required for the onboarding answers. Omit only for a Round-0-only call (standalone, or remove_stray_dbs alone) or for headless_enforcement alone on an onboarded project.',
          },
          standalone: {
            type: 'boolean',
            description:
              "Round 0 'Make <subdir> its own TMB project': creates <session_dir>/.claude/<plugin>/standalone and a fresh trajectory DB there, then the Human restarts the session. Only when nesting.nested; pass no other answers.",
          },
          remove_stray_dbs: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Round 0: paths from nesting.other_dbs the Human agreed to remove. Each is deleted (with -wal/-shm and its state dir) only when it is still empty (0 issues, 0 tasks) and lies below the project root; the rest are refused and left in place.",
          },
          branching_model: {
            type: 'string',
            enum: ['github-flow', 'gitflow'],
            description:
              'Optional. With repo: written to that repos row. Without repo: seeds only repos rows whose branching_model is unset (default github-flow + the repo\'s default branch); populated rows are never changed.',
          },
          pr_target: { type: 'string' },
          remote: {
            type: 'array',
            items: { type: 'string', enum: ['github', 'gitlab'] },
            description: 'Optional when shape=remote. Array of provider IDs (multiSelect AUQ answer). Single-element ["github"] or ["gitlab"], or ["github","gitlab"] for dual-host. Omitted or empty: each repo\'s GitHub/GitLab remotes are probed from its git tree, with a warning when none has one. Ignored on local.',
          },
          issue_sync: {
            type: 'string',
            enum: ['auto', 'off'],
            description: 'The Round 3 answer when shape=remote; omitted means "off". Always "off" on local.',
          },
          headless_enforcement: {
            type: 'string',
            enum: ['yes', 'no'],
            description:
              "Optional. 'yes' writes TMB's PreToolUse gates into the project's .claude/settings.local.json so they also fire in headless `claude -p` runs; 'no' removes them. Omit to keep the stored answer (default 'no'). Not an /onboard round: set on request, alone (no shape) once the project is onboarded.",
          },
          sandbox_enforcement: {
            type: 'string',
            enum: ['yes', 'no'],
            description:
              "Optional. 'yes' writes Claude Code's Bash sandbox block (sandbox.enabled + filesystem.allowWrite = the project and the model cache + network.allowedDomains = GitHub, the npm registry and each HTTPS remote's host + enableWeakerNetworkIsolation on macOS, plus env npm/bun caches under the project) into the project's .claude/settings.local.json; 'no' removes what TMB wrote. Omit to keep the stored answer (default 'no').",
          },
          repo: {
            type: 'string',
            description:
              "Optional. Scope the write to a single repos row: only that row's target_branch/branching_model/protected_branches are updated; other repos rows, remotes, issue_sync, and the onboarded marker are NOT touched. Must match an existing repos.name. Omit for the workspace-wide apply, which never changes a populated row's branching_model/target_branch/protected_branches.",
          },
        },
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

  const projectRoot = (): string => {
    const fromDb = dbPath.match(/^(.*)\/\.claude\/[^/]+\/trajectory\.db$/);
    if (fromDb && fromDb[1]) return fromDb[1];
    return process.env['CLAUDE_PROJECT_DIR'] || process.cwd();
  };
  // The sandbox block is written only into a real project: one whose
  // trajectory DB path names it (never the server's cwd).
  const sandboxProjectRoot = (): string | null => {
    const fromDb = dbPath.match(/^(.*)\/\.claude\/[^/]+\/trajectory\.db$/);
    return fromDb && fromDb[1] ? fromDb[1] : null;
  };
  // Every remote URL onboard knows: the repo_remotes rows plus the managed
  // repo's own git remotes (a fresh onboard has no rows yet).
  const knownRemoteUrls = (extra: readonly string[] = []): string[] => {
    const rows = db.all<{ url: string }>(`SELECT url FROM repo_remotes`).map((r) => r.url);
    return [...new Set([...rows, ...extra])].filter((u) => u.length > 0);
  };
  const shimOptions = () => ({
    pluginRoot: shimEnv.pluginRoot !== undefined ? shimEnv.pluginRoot : resolvePluginRoot(),
    projectRoot: projectRoot(),
  });

  const resolveHeadless = (raw: string | undefined): { value: string; stored: string; answered: boolean } => {
    const stored = (readConfig(db, 'headless_enforcement') as string | null) ?? 'no';
    let value = stored;
    let answered = false;
    if (raw !== undefined) {
      const resolved = resolveOption(raw, HEADLESS_OPTIONS);
      if (resolved !== KEEP_SENTINEL) {
        value = resolved ?? raw;
        answered = true;
      }
    }
    if (value !== 'yes' && value !== 'no') {
      throw new Error(`headless_enforcement must be 'yes' or 'no' (got '${value}')`);
    }
    return { value, stored, answered };
  };

  // Headless enforcement is opt-in: 'yes' writes the shim into the project's
  // .claude/settings.local.json; an explicit 'no' (or a stored 'yes' flipped
  // to 'no') removes it. An apply that leaves the answer unset at 'no'
  // touches nothing. Best-effort — a failure is reported but never fails the
  // apply.
  const applyHeadlessShim = (h: { value: string; stored: string; answered: boolean }): Record<string, unknown> => {
    try {
      if (h.value === 'yes') {
        return { ...writeProjectEnforcementShim({ ...shimOptions(), headlessEnforcement: h.value }) };
      }
      if (h.answered || h.stored === 'yes') return { ...removeProjectEnforcementShim(shimOptions()) };
      return { skipped: 'headless_enforcement_off' };
    } catch (e) {
      return { reason: (e as Error).message };
    }
  };

  // Round 0: where the session sits relative to the project the DB walk
  // resolved, and every other trajectory DB around it. A DB outside the
  // <root>/.claude/<plugin>/ layout (or in memory) has no nesting to report.
  const nesting = (): OnboardNesting => {
    const session_dir = shimEnv.sessionDir ?? resolveClaudeSessionDir();
    const root = claudeProjectRootOfDb(dbPath);
    if (root === null) return { session_dir, project_root: projectRoot(), nested: false, other_dbs: [] };
    const session = canonicalExisting(session_dir);
    const project = canonicalExisting(root);
    return {
      session_dir,
      project_root: root,
      nested: session !== project && isPathWithin(project, session),
      other_dbs: otherClaudeDbs(dbPath, { sessionDir: session_dir }) ?? [],
    };
  };

  const makeStandalone = (): Record<string, unknown> => {
    const where = nesting();
    if (!where.nested) {
      throw new Error(
        `standalone needs a session directory below the project root (session ${where.session_dir}, project ${where.project_root})`,
      );
    }
    const stateDir = claudeStateDir(where.session_dir, basename(dirname(dbPath)));
    const newDb = join(stateDir, 'trajectory.db');
    mkdirSync(stateDir, { recursive: true });
    new TrajectoryDB(newDb, { pluginVersion: null, serverLog: () => {}, sqlLog: () => {} }).close();
    const marker = join(stateDir, CLAUDE_STANDALONE_MARKER);
    writeFileSync(marker, 'This directory is its own TMB project: the trajectory DB walk-up stops here.\n');
    insertAudit(db, {
      issue_id: -1,
      from_node: 'bro',
      event_type: 'project_made_standalone',
      summary: `onboard: ${where.session_dir} is now its own TMB project (left workspace ${where.project_root})`,
      content_json: JSON.stringify({ session_dir: where.session_dir, db_path: newDb, marker }),
    });
    return {
      ok: true,
      standalone: { session_dir: where.session_dir, db_path: newDb, marker },
      restart_required: true,
    };
  };

  const removeStrayDbs = (
    paths: string[],
  ): { removed: string[]; refused: Array<{ path: string; reason: string }> } => {
    const root = claudeProjectRootOfDb(dbPath);
    if (root === null) throw new Error('remove_stray_dbs needs a project trajectory DB (<root>/.claude/<plugin>/trajectory.db)');
    const project = canonicalExisting(root);
    const self = canonicalExisting(dbPath);
    const pluginName = basename(dirname(dbPath));
    const removed: string[] = [];
    const refused: Array<{ path: string; reason: string }> = [];
    const outside = `not below the project root ${root}`;
    const linkOrOutside = (path: string): string | null => {
      for (let p = path; dirname(p) !== p; p = dirname(p)) {
        if (canonicalExisting(p) === project) return null;
        if (lstatSync(p).isSymbolicLink()) return `${p} is a symlink`;
      }
      return outside;
    };
    const check = (path: string): { reason: string } | { stateDir: string } => {
      if (!isAbsolute(path)) return { reason: 'not an absolute path' };
      if (!existsSync(path)) return { reason: 'no such file' };
      if (claudeProjectRootOfDb(path) === null || basename(path) !== 'trajectory.db' || basename(dirname(path)) !== pluginName) {
        return { reason: `not a <dir>/.claude/${pluginName}/trajectory.db path` };
      }
      if (canonicalExisting(path) === self) return { reason: 'the current trajectory DB' };
      const link = linkOrOutside(path);
      if (link !== null) return { reason: link };
      const stateDir = realpathSync(dirname(path));
      const strayProject = dirname(dirname(stateDir));
      if (strayProject === project || !isPathWithin(project, strayProject)) return { reason: outside };
      if (isStandaloneClaudeDb(path)) return { reason: 'a standalone TMB project' };
      const { issues, tasks } = claudeDbCounts(path);
      if (issues !== 0 || tasks !== 0) return { reason: `not empty (${issues ?? '?'} issues, ${tasks ?? '?'} tasks)` };
      return { stateDir };
    };
    for (const path of paths) {
      const verdict = check(path);
      if ('reason' in verdict) {
        refused.push({ path, reason: verdict.reason });
        continue;
      }
      const { stateDir } = verdict;
      const file = join(stateDir, basename(path));
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
      rmSync(stateDir, { recursive: true, force: true });
      insertAudit(db, {
        issue_id: -1,
        from_node: 'bro',
        event_type: 'stray_db_removed',
        summary: `onboard: removed the empty stray trajectory DB ${path}`,
        content_json: JSON.stringify({ path, state_dir: stateDir, project_root: root }),
      });
      removed.push(path);
    }
    return { removed, refused };
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
            remotes: policy.remote_list,
            issue_sync: readConfig(db, 'issue_sync'),
            headless_enforcement: readConfig(db, 'headless_enforcement') ?? 'no',
            sandbox_enforcement: readConfig(db, 'sandbox_enforcement') ?? 'no',
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
          nesting: nesting(),
          scan: scanWorkspace(db),
        });
      }),
    ),

    onboard_get_questions: requireRoles(
      'onboard_get_questions',
      ['bro'],
      wrapHandler(async (args) => {
        const shape = args['shape'] as 'local' | 'remote' | undefined;
        const round = args['round'] as 'shape' | 'main' | 'sync' | 'sandbox';
        const repo = args['repo'] as string | undefined;

        const git = probeGit(probeDir());

        if (round === 'shape') {
          return ok({ questions: [shapeQuestion(git.origin_kind, shapeAdvice(scanWorkspace(db), git.origin_kind))] });
        }

        if (round === 'sandbox') {
          const current = readConfig(db, 'sandbox_enforcement') as string | null;
          const detected = git.detected_remotes.map((r) => r.url);
          return ok({
            questions: [sandboxQuestion(current, readOnboardedFlag(db), knownRemoteUrls(detected), shimEnv.platform ?? process.platform)],
          });
        }

        // Per-repo path: branching + pr_target questions seeded from THAT repos
        // row, for either shape. Only valid on round='main'. Each Keep option
        // appears only when that field holds a stored value; the remote
        // provider (git-derived) and issue_sync (global, sync round) stay out
        // of the per-repo path.
        if (repo !== undefined) {
          if (round !== 'main') {
            throw new Error(`repo param is only valid with round='main' (got '${round}')`);
          }
          const repoRow = readRepoRow(db, repo);
          if (!repoRow) {
            throw new Error(`unknown repo '${repo}' — no matching repos row`);
          }
          const advice = branchingAdvice(repoRow.recommendation);
          const repoQuestions: BuiltQuestion[] = [
            branchingQuestion(repoRow.branching_model, repoRow.branching_model !== null, advice.branching),
            prTargetQuestion(repoRow.target_branch, repoRow.branching_model, repoRow.target_branch !== null, advice.prTarget),
          ];
          return ok({ questions: repoQuestions });
        }

        // Re-onboard means /onboard already ran in this project — identity row exists.
        const isReonboard = readOnboardedFlag(db);
        const policy = readRepoPolicy(db);
        const currentBranching = policy.branching_model;
        const currentPrTarget = policy.pr_target;
        const currentSync = readConfig(db, 'issue_sync') as string | null;

        const gh = probeCli('gh');
        const glab = probeCli('glab');

        const questions: BuiltQuestion[] = [];

        if (round === 'main') {
          const scan = scanWorkspace(db);
          const advice = branchingAdvice(workspaceRecommendation(scan));
          if (shape === 'remote' || isReonboard) {
            // Local re-onboard adds Branching so the Human can change models.
            // Local first-run skips Branching entirely (silent default).
            questions.push(branchingQuestion(currentBranching, isReonboard, advice.branching));
          }
          if (shape === 'remote') {
            questions.push(prTargetQuestion(currentPrTarget, currentBranching, isReonboard, advice.prTarget));
            questions.push(remoteQuestion(gh.installed, glab.installed, remoteAdvice(git.origin_kind, scan)));
          }
          // shape=local + first-run yields questions=[] — skill skips AUQ Round 2.
        } else if (round === 'sync') {
          if (shape !== 'remote') {
            throw new Error(`round='sync' only valid for shape='remote' (got '${String(shape)}')`);
          }
          questions.push(issueSyncQuestion(currentSync, isReonboard, { gh_authed: gh.authed, glab_authed: glab.authed }));
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
        if ('persona' in args) {
          throw new Error(
            "persona_input_removed: onboard_apply takes no 'persona' input — bro's persona loads from the plugin through its SessionStart and UserPromptSubmit hooks, and TMB never writes the project's CLAUDE.md",
          );
        }
        if (args['standalone'] === true) {
          const others = Object.keys(args).filter((k) => k !== 'standalone' && k !== 'agent' && args[k] !== undefined);
          if (others.length > 0) {
            throw new Error(`standalone=true is applied alone — drop ${others.join(', ')}; the new project onboards after the session restart`);
          }
          return ok(makeStandalone());
        }
        const rawStray = args['remove_stray_dbs'];
        if (rawStray !== undefined && (!Array.isArray(rawStray) || rawStray.some((p) => typeof p !== 'string'))) {
          throw new Error('remove_stray_dbs must be an array of DB paths from nesting.other_dbs');
        }
        const strayPaths = rawStray as string[] | undefined;
        if (strayPaths !== undefined && args['shape'] === undefined) {
          return ok({ ok: true, stray_dbs: removeStrayDbs(strayPaths) });
        }
        if (args['shape'] === undefined && args['headless_enforcement'] !== undefined) {
          const others = Object.keys(args).filter(
            (k) => k !== 'headless_enforcement' && k !== 'agent' && args[k] !== undefined,
          );
          if (others.length > 0) {
            throw new Error(`headless_enforcement without shape is applied alone — drop ${others.join(', ')}, or pass shape for the full apply`);
          }
          if (!readOnboardedFlag(db)) {
            throw new Error('headless_enforcement alone needs an onboarded project — run /onboard first');
          }
          const headless = resolveHeadless(args['headless_enforcement'] as string);
          writeConfig(db, 'headless_enforcement', headless.value);
          return ok({
            ok: true,
            applied: { headless_enforcement: headless.value, headless_shim: applyHeadlessShim(headless) },
          });
        }

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

        // The workspace apply fills only repos rows whose branching_model is
        // still NULL; the per-repo apply above owns every populated row.
        // Explicit values seed those NULL rows; Keep resolves against the
        // representative row.
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
          if (branching_model !== undefined && branching_model !== 'github-flow' && branching_model !== 'gitflow') {
            throw new Error(`branching_model must be 'github-flow' or 'gitflow' (got '${branching_model}')`);
          }
        }

        const rawPrTarget = args['pr_target'] as string | undefined;
        let pr_target: string | undefined;
        if (rawPrTarget !== undefined) {
          const resolved = resolveOption(rawPrTarget, PR_TARGET_OPTIONS);
          if (resolved === KEEP_SENTINEL) {
            pr_target = readRepoPolicy(db).pr_target ?? derivePrTargetDefault(branching_model ?? 'github-flow');
          } else {
            pr_target = resolved ?? rawPrTarget;
          }
        }

        let remotes: Array<{ name: string; provider: Provider; url: string }> = [];
        let issue_sync: 'auto' | 'off' = 'off';
        let warning: string | undefined;
        let remoteList: string[] = [];
        if (shape === 'remote') {
          const rawRemote = args['remote'];
          // Accept array (canonical, post-multiSelect) or string (legacy/single).
          if (Array.isArray(rawRemote)) {
            remoteList = rawRemote.filter((s): s is string => typeof s === 'string');
          } else if (typeof rawRemote === 'string') {
            remoteList = [rawRemote];
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
        }

        // Build the chosen-provider remotes from a given repo's own git tree;
        // with no `remote` answer, every GitHub/GitLab remote that tree has.
        // Stable order: github first, then gitlab. The first entry uses
        // name='origin'; if both are present the second uses the provider name.
        const remotesForPath = (
          path: string,
        ): Array<{ name: string; provider: Provider; url: string }> => {
          const detected = probeGit(path).detected_remotes;
          const findUrl = (p: Provider): string => detected.find((r) => r.provider === p)?.url ?? '';
          const wanted =
            remoteList.length > 0 ? remoteList : (['github', 'gitlab'] as const).filter((p) => findUrl(p).length > 0);
          const out: Array<{ name: string; provider: Provider; url: string }> = [];
          const wantedGh = wanted.includes('github');
          const wantedGl = wanted.includes('gitlab');
          if (wantedGh) out.push({ name: 'origin', provider: 'github', url: findUrl('github') });
          if (wantedGl) {
            out.push({ name: wantedGh ? 'gitlab' : 'origin', provider: 'gitlab', url: findUrl('gitlab') });
          }
          return out;
        };

        // The `applied` payload reflects the managed (probe) repo's resolution
        // for backward compatibility with the single-repo summary that callers
        // already consume.
        if (shape === 'remote') {
          remotes = remotesForPath(probeDir());
          // Defensive: if the origin remote's URL is still blank after the
          // probe, issue-sync will silently skip (blank_remote_url). Surface a
          // warning so the operator can fix the repo's git remote rather than
          // discover the silent skip later (#675).
          const origin = remotes.find((r) => r.name === 'origin');
          if (origin && origin.url.length === 0) {
            warning = `remote URL not detected for ${origin.provider}; issues will not sync — check the repo's git remote`;
          }
        }

        const headless = resolveHeadless(args['headless_enforcement'] as string | undefined);
        const headless_enforcement = headless.value;

        const rawSandbox = args['sandbox_enforcement'] as string | undefined;
        let sandbox_enforcement = (readConfig(db, 'sandbox_enforcement') as string | null) ?? 'no';
        if (rawSandbox !== undefined) {
          const resolved = resolveOption(rawSandbox, SANDBOX_OPTIONS);
          if (resolved !== KEEP_SENTINEL) sandbox_enforcement = resolved ?? rawSandbox;
        }
        if (sandbox_enforcement !== 'yes' && sandbox_enforcement !== 'no') {
          throw new Error(`sandbox_enforcement must be 'yes' or 'no' (got '${sandbox_enforcement}')`);
        }

        // A NULL row gets the explicit answers, reconciled against its own git
        // tree (#13: a repo without the gitflow target branch falls back to
        // github-flow + its real default branch), else github-flow + its real
        // default branch.
        const seedPolicy = (repoPath: string, inGit: boolean): { model: string; target: string } => {
          const defaultBranch = (): string =>
            inGit ? repoDefaultBranch(repoPath) : derivePrTargetDefault('github-flow');
          if (branching_model === undefined) {
            return { model: 'github-flow', target: pr_target ?? defaultBranch() };
          }
          const target = pr_target ?? derivePrTargetDefault(branching_model);
          if (inGit && branching_model === 'gitflow' && !branchExists(repoPath, target)) {
            return { model: 'github-flow', target: defaultBranch() };
          }
          return { model: branching_model, target };
        };

        let anyRemote = remotes.some((r) => r.url.length > 0);
        db.transaction(() => {
          // Mark project as onboarded via plugin_config (#2876).
          // The legacy `identity` table is dropped by the v1→v2 migration in db.ts on first boot after upgrade.
          writeConfig(db, 'onboarded', true);

          writeConfig(db, 'issue_sync', issue_sync);
          writeConfig(db, 'headless_enforcement', headless_enforcement);
          writeConfig(db, 'sandbox_enforcement', sandbox_enforcement);

          // The repos table is the sole source of truth for the four repo-scoped
          // keys (#980). Populated rows keep their per-repo policy; only NULL
          // rows are seeded. Remotes are probed from each repo's own path so
          // scan-captured per-repo remotes (#979) survive; a repo whose git
          // tree can't be probed gets the managed repo's remotes.
          const rows = db.all<{ name: string; path: string; branching_model: string | null }>(
            `SELECT name, path, branching_model FROM repos`,
          );
          for (const row of rows) {
            let repoPath = row.path;
            let inGit = false;
            try {
              repoPath = repoRowPath(db, row.path);
              inGit = probeGit(repoPath).in_git;
            } catch {
              inGit = false;
            }
            if (row.branching_model === null) {
              let seed: { model: string; target: string };
              try {
                seed = seedPolicy(repoPath, inGit);
              } catch {
                seed = seedPolicy(repoPath, false);
              }
              db.run(
                `UPDATE repos SET target_branch = ?, branching_model = ?, protected_branches = ? WHERE name = ?`,
                [seed.target, seed.model, JSON.stringify(deriveProtectedBranches(seed.model, seed.target)), row.name],
              );
            }
            let effRemotes = shape === 'remote' ? remotes : [];
            if (shape === 'remote' && inGit) {
              try {
                effRemotes = remotesForPath(repoPath);
              } catch {
                effRemotes = remotes;
              }
            }
            if (effRemotes.some((r) => r.url.length > 0)) anyRemote = true;
            upsertRepoRemotes(db, row.name, effRemotes);
          }
        });

        if (shape === 'remote' && !anyRemote && !warning) {
          warning = "no git remote detected on any repo; issues will not sync — check each repo's git remote";
        }

        const managed = readRepoPolicy(db);
        const appliedModel = managed.branching_model ?? branching_model ?? 'github-flow';
        const appliedTarget = managed.pr_target ?? pr_target ?? derivePrTargetDefault(appliedModel);
        const appliedProtected = Array.isArray(managed.protected_branches)
          ? managed.protected_branches
          : deriveProtectedBranches(appliedModel, appliedTarget);

        const headless_shim = applyHeadlessShim(headless);

        // Native sandbox (Tier 0): 'yes' merges the sandbox block (filesystem
        // allowWrite + network allowedDomains) into the project's settings.local.json; 'no' removes exactly what TMB added
        // (plugin_config.sandbox_settings). Best-effort, like the shim.
        let sandbox: Record<string, unknown>;
        try {
          const record = (readConfig(db, 'sandbox_settings') as SandboxRecord | null) ?? null;
          if (sandbox_enforcement === 'yes') {
            const result = writeProjectSandbox({
              projectRoot: sandboxProjectRoot(),
              remoteUrls: knownRemoteUrls(remotes.map((r) => r.url)),
              toolCacheDir: join(dirname(dbPath), 'cache'),
              platform: shimEnv.platform ?? process.platform,
              previous: record,
            });
            if (result.record) writeConfig(db, 'sandbox_settings', result.record);
            sandbox = {
              written: result.written,
              ...(result.settings_path ? { settings_path: result.settings_path } : {}),
              ...(result.allow_write ? { allow_write: result.allow_write } : {}),
              ...(result.allowed_domains ? { allowed_domains: result.allowed_domains } : {}),
              ...(result.env ? { env: result.env } : {}),
              ...(result.weaker_network_isolation !== undefined ? { weaker_network_isolation: result.weaker_network_isolation } : {}),
              ...(result.gitignore_appended !== undefined ? { gitignore_appended: result.gitignore_appended } : {}),
              ...(result.reason ? { reason: result.reason } : {}),
            };
          } else {
            const result = removeProjectSandbox({ projectRoot: sandboxProjectRoot(), record });
            if (result.removed) writeConfig(db, 'sandbox_settings', null);
            sandbox = { ...result };
          }
        } catch (e) {
          sandbox = { reason: (e as Error).message };
        }

        return ok({
          ok: true,
          ...(warning ? { warning } : {}),
          ...(strayPaths !== undefined ? { stray_dbs: removeStrayDbs(strayPaths) } : {}),
          applied: {
            onboarded: true,
            branching_model: appliedModel,
            pr_target: appliedTarget,
            protected_branches: appliedProtected,
            remotes,
            issue_sync,
            headless_enforcement,
            headless_shim,
            sandbox_enforcement,
            sandbox,
            ...(warning ? { warning } : {}),
          },
        });
      }),
    ),
  };

  return { definitions, handlers };
}
