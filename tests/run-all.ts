// TypeScript port of run-all.sh (GH 1692), the L1-L4 test orchestrator: it builds the payload, then
// runs the L1 lints, the L2 unit suite, the L3 integration suites and the L4 workflow flows behind
// gh/glab/claude stubs, and exits 0 only when every step passes. See tests/README.md for the full
// pyramid; L0 (install-smoke, Docker) and L5/L6 (real CC, token required) run separately.
//
// Usage:
//   node --experimental-strip-types tests/run-all.ts            # L1-L4
//   node --experimental-strip-types tests/run-all.ts --l1-only  # stop after L1 (PR check, GH 2064)
//   node --experimental-strip-types tests/run-all.ts --l1-local # L1 minus its slow-flagged steps and wm-equivalence (swe close, GH 2866)
//   node --experimental-strip-types tests/run-all.ts --l1-changed [--base <ref>]
//     # only the L1 steps whose declared inputs the diff <ref>...HEAD touches (GH 3161); the base falls
//     # back to TMB_LINT_BASE_SHA, and no base, a failing diff or a shared input runs the full L1
//
// TMB_L1_SKIP: space-separated lint basenames whose steps print SKIP instead of running.
// A run started with an empty HOME must end with that HOME holding nothing but .cache/huggingface.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';

/** inputs: the repo-relative globs an L1 step reads, which --l1-changed matches against the diff. */
export type Step = [label: string, argv: string[], inputs?: readonly string[], slow?: true];

/** A changed path matching one of these runs the full L1: every step reads them. */
export const SHARED_INPUTS: readonly string[] = [
  'package.json',
  'bun.lock',
  '**/tsconfig*.json',
  'tests/run-all.ts',
  'tests/l1-lint/**',
  'tests/lib/**',
  '.config/tmb/**',
];

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);
const LIVE_CLIS = ['gh', 'glab', 'claude'];

function out(text: string): void {
  writeSync(1, text);
}

function err(text: string): void {
  writeSync(2, text);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export interface RunArgs {
  l1Only: boolean;
  l1Local: boolean;
  l1Changed: boolean;
  /** The ref after --base, when given. */
  base?: string;
}

/**
 * --l1-only, --l1-local and --l1-changed (first argument) all stop after L1; --l1-local also skips the
 * slow L1 steps, --l1-changed runs only the steps its diff selects.
 */
export function parseArgs(argv: string[]): RunArgs {
  const l1Local = argv[0] === '--l1-local';
  const l1Changed = argv[0] === '--l1-changed';
  const args: RunArgs = { l1Only: l1Local || l1Changed || argv[0] === '--l1-only', l1Local, l1Changed };
  const at = argv.indexOf('--base');
  if (at >= 0 && at + 1 < argv.length) args.base = argv[at + 1];
  return args;
}

/** The L1 steps --l1-local runs: the L1 table minus its slow-flagged steps. */
export function l1LocalSteps(steps: Step[]): Step[] {
  return steps.filter(([, , , slow]) => slow !== true);
}

const DOT_MASK = '\u0001';

function maskDots(s: string): string {
  return s.replace(/(^|\/)\./g, `$1${DOT_MASK}`);
}

/**
 * path.matchesGlob, except that `*` and `**` also match a segment starting with a dot (matchesGlob alone
 * skips them), so `**` matches `.github/x.yml`; the same rule as the close-lint fingerprint's matcher.
 */
export function matchesInput(path: string, glob: string): boolean {
  return matchesGlob(path, glob) || matchesGlob(maskDots(path), maskDots(glob));
}

function touches(changed: readonly string[], globs: readonly string[]): boolean {
  return changed.some((path) => globs.some((glob) => matchesInput(path, glob)));
}

/**
 * The steps whose declared inputs match a changed path, in table order. It fails closed: a null list
 * (no base, or the diff failed) or one touching a shared input returns every step, and a step that
 * declares no inputs is always kept.
 */
export function selectL1Steps(steps: Step[], changed: readonly string[] | null, shared: readonly string[] = SHARED_INPUTS): Step[] {
  if (changed === null || touches(changed, shared)) return steps;
  return steps.filter(([, , inputs]) => inputs === undefined || inputs.length === 0 || touches(changed, inputs));
}

/** The labels of the steps that declare no input globs. */
export function undeclaredInputSteps(steps: Step[]): string[] {
  return steps.filter(([, , inputs]) => inputs === undefined || inputs.length === 0).map(([label]) => label);
}

/** The base --l1-changed diffs against: --base, else TMB_LINT_BASE_SHA; null when neither is set. */
export function changedBase(baseArg: string | undefined, envBase: string | undefined): string | null {
  for (const ref of [baseArg, envBase]) if (ref !== undefined && ref.trim() !== '') return ref.trim();
  return null;
}

/** The paths `git diff <base>...HEAD` changed, renames as delete + add; null when git fails or the base is not a ref. */
export function changedPaths(repo: string, base: string): string[] | null {
  if (base.startsWith('-')) return null;
  const r = spawnSync('git', ['-C', repo, 'diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter((path) => path !== '');
}

/** True when any argv word's last path segment is one of the TMB_L1_SKIP basenames. */
export function l1Skipped(argv: string[], skipList: string | undefined): boolean {
  const skips = (skipList ?? '').split(/\s+/).filter((s) => s !== '');
  return skips.some((skip) => argv.some((arg) => lastSegment(arg) === skip));
}

/** Lint basenames with no step whose argv names tests/l1-lint/<basename>. */
export function unwiredLints(lints: string[], steps: Step[]): string[] {
  const wired = new Set<string>();
  for (const [, argv] of steps) {
    for (const arg of argv) {
      const m = /(?:^|\/)l1-lint\/([^/]+)$/.exec(arg);
      if (m) wired.add(m[1]);
    }
  }
  return lints.filter((lint) => !wired.has(lint));
}

/** Every tests/l1-lint/*.sh and *.test.mjs basename, sorted. */
export function l1LintFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sh') || name.endsWith('.test.mjs'))
    .sort();
}

/** HOME-relative paths other than .cache and the .cache/huggingface subtree. */
export function homeLeaks(relPaths: string[]): string[] {
  return relPaths.filter(
    (p) => p !== '.cache' && p !== '.cache/huggingface' && !p.startsWith('.cache/huggingface/'),
  );
}

/** Every path under root, relative to it, pre-order; links are listed, not followed. */
export function walkTree(root: string, rel = ''): string[] {
  let entries;
  try {
    entries = readdirSync(rel === '' ? root : join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    paths.push(path);
    if (entry.isDirectory() && path !== '.cache/huggingface') paths.push(...walkTree(root, path));
  }
  return paths;
}

/**
 * The mise env for a run scratch dir: state and cache under it, MISE_DATA_DIR (when unset) from the
 * first PATH entry under <x>/mise/installs/, else under the scratch dir, and MISE_CONFIG_DIR (when
 * unset) as <home>/.config/mise when MISE_DATA_DIR is <home>/.local/share/mise and that dir exists.
 */
export function miseEnv(
  env: NodeJS.ProcessEnv,
  runTmp: string,
  isDir: (path: string) => boolean = (path) => existsSync(path) && statSync(path).isDirectory(),
): Record<string, string> {
  const mise: Record<string, string> = {
    MISE_STATE_DIR: join(runTmp, 'mise-state'),
    MISE_CACHE_DIR: join(runTmp, 'mise-cache'),
  };
  let dataDir = env.MISE_DATA_DIR ?? '';
  if (dataDir === '') {
    for (const entry of (env.PATH ?? '').split(delimiter)) {
      const m = /^(.*\/mise)\/installs\/.*/.exec(entry);
      if (m) {
        dataDir = m[1];
        break;
      }
    }
    if (dataDir === '') dataDir = join(runTmp, 'mise-data');
    mise.MISE_DATA_DIR = dataDir;
  }
  const suffix = '/.local/share/mise';
  const miseHome = dataDir.endsWith(suffix) ? dataDir.slice(0, -suffix.length) : dataDir;
  if ((env.MISE_CONFIG_DIR ?? '') === '' && miseHome !== dataDir && isDir(join(miseHome, '.config', 'mise'))) {
    mise.MISE_CONFIG_DIR = join(miseHome, '.config', 'mise');
  }
  return mise;
}

/** Writes the gh/glab/claude stubs into dir: each appends `LIVE-CLI BLOCKED: <cli> <args>` to sentinel and exits 97. */
export function writeStubs(dir: string, sentinel: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sentinel, '');
  for (const cli of LIVE_CLIS) {
    const path = join(dir, cli);
    writeFileSync(
      path,
      [
        '#!/usr/bin/env node',
        "import('node:fs').then(({ appendFileSync }) => {",
        `  appendFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(`LIVE-CLI BLOCKED: ${cli} `)} + process.argv.slice(2).join(' ') + '\\n');`,
        `  process.stderr.write(${JSON.stringify(`tmb test-stub: ${cli} blocked (exit 97)\n`)});`,
        '  process.exit(97);',
        '});',
        '',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
  }
}

// SLOW marks a step measured above 30 s on a dev machine; --l1-local skips it, --l1-only, --l1-changed and CI run it.
const SLOW = true;

// Input globs shared by several steps. A step lists every repo path it reads (fixtures and allowlists sit
// under tests/l1-lint/, a shared input); over-declaring only runs a step more often, under-declaring
// lets a change skip the lint that guards it. A step that reads the whole tree, or git history, uses '**'.
const EVERY = ['**'];
const PROMPTS = ['CLAUDE.md', 'agents/**', 'commands/**', 'skills/**', 'templates/**'];
const DOCS = ['*.md', 'docs/**', ...PROMPTS];
const SERVER = ['mcp/trajectory-server/**'];
const SERVER_SRC = ['mcp/trajectory-server/src/**'];
const SERVER_TESTS = ['mcp/trajectory-server/src/test/**'];
const SCRIPTS = ['scripts/**'];
const AGENTS = ['agents/**', 'templates/agents/**'];
const WORKFLOWS = ['.github/**'];

export function l1Steps(here: string): Step[] {
  const lint = (label: string, file: string, inputs: readonly string[], slow?: true): Step => {
    const argv = ['node', '--test', join(here, 'l1-lint', file)];
    return slow ? [label, argv, inputs, slow] : [label, argv, inputs];
  };
  return [
    lint('L1 lint: agent template line budget', 'agent-line-budget.test.mjs', AGENTS),
    lint('L1 lint: agent frontmatter declares experimental.cacheTtl', 'agent-cache-ttl.test.mjs', AGENTS),
    lint('L1 lint: agent template byte-identity (swe + code-reviewer)', 'agent-template-byte-identity.test.mjs', ['templates/agents/**']),
    lint('L1 lint: local agent overrides retain workflow primitives', 'local-agent-primitives.test.mjs', AGENTS),
    lint('L1 lint: shipped swe/code-reviewer task_brief contract (#300)', 'agent-task-brief-contract.test.mjs', ['agents/**']),
    lint('L1 lint: skill frontmatter + name=dirname', 'skill-frontmatter.test.mjs', ['skills/**']),
    lint('L1 lint: command frontmatter (description + argument-hint)', 'command-frontmatter.test.mjs', ['commands/**']),
    lint('L1 lint: frontmatter values hold no unquoted colon-space', 'frontmatter-plain-scalar.test.mjs', ['agents/**', 'commands/**', 'skills/**']),
    lint('L1 lint: manifest shape (plugin/.mcp/hooks)', 'manifest-shape.test.mjs', ['.claude-plugin/**', '.mcp.json', 'hooks/**']),
    lint('L1 lint: legacy reviewer name only where allowlisted (GH 1641)', 'legacy-reviewer-name.test.mjs', EVERY),
    lint('L1 lint: version sync (3 manifests agree)', 'version-sync.test.mjs', ['.claude-plugin/**', 'mcp/trajectory-server/package.json']),
    // It also reads the branch's commit subjects, which any change carries.
    lint('L1 lint: changelog top section current', 'changelog-current.test.mjs', EVERY),
    lint('L1 lint: build:tsc rebuilds the bundles once (GH 2694)', 'build-tsc-bundles.test.mjs', ['mcp/trajectory-server/package.json']),
    // A link target anywhere in the tree can move or go away.
    lint('L1 lint: link-check (relative md links)', 'link-check.test.mjs', EVERY),
    lint('L1 lint: shellcheck on shell scripts', 'shellcheck-hooks.test.mjs', ['scripts/**', 'tests/**']),
    lint('L1 lint: no tracked shell files outside the allowlist (GH 2662)', 'no-shell-files.test.mjs', ['**/*.sh', '**/*.bash']),
    lint('L1 lint: contributor setup pins Bun and installs missing deps (GH 3151)', 'contributor-setup.test.mjs', ['.bun-version', 'scripts/maintenance/**']),
    lint('L1 lint: no bare mktemp (explicit path template)', 'no-bare-mktemp.test.mjs', ['tests/**', 'scripts/**']),
    lint('L1 lint: no grep -q in L6 chain-manifest pipelines', 'no-grep-q-in-pipelines.test.mjs', ['tests/l5-l6/l6-chain/**']),
    lint('L1 lint: no wall-clock asserts in tests', 'no-wall-clock-asserts.test.mjs', ['tests/**', 'dashboard/test/**', ...SERVER_TESTS]),
    lint('L1 lint: no destructive SQL in migrations', 'no-destructive-sql.test.mjs', SERVER_SRC),
    lint('L1 lint: tsc --noEmit on MCP server + dashboard', 'tsc-noemit.test.mjs', [...SERVER, 'dashboard/**']),
    lint('L1 lint: typescript-eslint against the suppressions baseline', 'eslint.test.mjs', [
      ...SERVER,
      'dashboard/**',
      'eslint.config.mjs',
      'eslint-suppressions.json',
    ]),
    lint('L1 lint: dist entrypoints are esbuild bundles', 'dist-bundles.test.mjs', SERVER),
    lint('L1 lint: bundle whitespace preserves string constants', 'bundle-whitespace-safety.test.mjs', SERVER),
    lint('L1 lint: labels.json triage rule + LABELS.md generated fresh', 'labels.test.mjs', [
      ...WORKFLOWS,
      'docs/contributing/LABELS.md',
      'scripts/maintenance/**',
      ...SERVER,
    ]),
    lint('L1 lint: no generated output tracked in git', 'no-tracked-generated.test.mjs', EVERY),
    lint('L1 lint: bug.yml matches the bug-report FORM_FIELDS', 'bug-form.test.mjs', ['.github/ISSUE_TEMPLATE/**', ...SERVER]),
    lint('L1 lint: new ts/tsx/sh files open with a purpose header', 'purpose-header.test.mjs', ['**/*.ts', '**/*.tsx', '**/*.sh', ...SERVER]),
    lint('L1 lint: shipped skills match builtin seed', 'skill-catalog-sync.test.mjs', ['skills/**', ...SERVER_SRC]),
    lint('L1 lint: ENUMs.md vs code parity', 'enums-stable.test.mjs', ['docs/contributing/ENUMS.md', ...SERVER, ...SCRIPTS]),
    lint('L1 lint: ENUMS.md event table + audit-events.txt generated fresh', 'enums-doc-fresh.test.mjs', [
      'docs/contributing/ENUMS.md',
      ...SERVER,
      ...SCRIPTS,
    ]),
    lint('L1 lint: build generators create scripts/hooks/lib/', 'generators-create-lib-dir.test.mjs', [...SCRIPTS, ...SERVER]),
    lint('L1 lint: ERD.md generated from schema.sql', 'erd-doc-fresh.test.mjs', ['docs/architecture/ERD.md', ...SERVER, 'scripts/maintenance/**']),
    lint('L1 lint: CONFIG_KEYS.md generated from code', 'config-keys-doc-fresh.test.mjs', ['docs/architecture/CONFIG_KEYS.md', ...SERVER, ...SCRIPTS]),
    lint('L1 lint: tool docs list every family + tool', 'tool-families-documented.test.mjs', SERVER),
    lint('L1 lint: no negative directives in prompts', 'no-negative-directives.test.mjs', PROMPTS),
    lint('L1 lint: issue_sync test must mock spawn', 'issue-sync-test-isolation.test.mjs', SERVER_TESTS),
    lint('L1 lint: no audit_append without from_node', 'no-audit-log-without-from-node.test.mjs', PROMPTS),
    lint('L1 lint: no citations in prompts', 'no-citations-in-prompts.test.mjs', PROMPTS),
    lint('L1 lint: no kuzu in prompts', 'no-kuzu-in-prompts.test.mjs', PROMPTS),
    lint('L1 lint: no repository paths in prompts', 'no-repo-paths-in-prompts.test.mjs', PROMPTS),
    lint('L1 lint: explicit paths and git -C in prompts', 'prompt-explicit-paths.test.mjs', PROMPTS),
    lint('L1 lint: no file_registry refs (v7 retirement)', 'no-file-registry-refs.test.mjs', EVERY),
    lint('L1 lint: no audit_append kind= arg', 'no-audit-log-kind.test.mjs', DOCS),
    lint('L1 lint: single audit write path (insertAudit)', 'single-audit-write-path.test.mjs', SERVER_SRC),
    lint('L1 lint: no developer paths in artifacts', 'no-developer-paths.test.mjs', DOCS),
    lint('L1 lint: no stale framing prose', 'stale-framing-prose.test.mjs', DOCS),
    lint('L1 lint: no hardcoded plugin name', 'no-hardcoded-plugin-name.test.mjs', [...SCRIPTS, ...SERVER_SRC]),
    // A referenced file anywhere in the tree can move or go away.
    lint('L1 lint: CI workflow file refs exist', 'ci-workflow-refs-exist.test.mjs', EVERY),
    lint('L1 lint: workflow-run scripts build before importing dist', 'workflow-scripts-no-dist.test.mjs', [...WORKFLOWS, ...SCRIPTS, 'mcp/**']),
    lint('L1 lint: symlink targets all resolve', 'symlink-targets.test.mjs', EVERY),
    lint('L1 lint: hooks.json commands executable', 'hooks-executable.test.mjs', ['hooks/**', ...SCRIPTS, ...SERVER]),
    lint('L1 lint: valid permissionDecision values', 'valid-permission-decisions.test.mjs', ['mcp/trajectory-server/src/hooks/**']),
    lint('L1 lint: no citations of the retired shell gates', 'no-retired-hook-gate-paths.test.mjs', EVERY),
    lint('L1 lint: no directories-table refs', 'no-directories-table-refs.test.mjs', EVERY),
    lint('L1 lint: RAG schema invariants', 'rag-schema-invariants.test.mjs', SERVER_SRC),
    lint('L1 lint: tool-description byte budget', 'tool-description-budget.test.mjs', SERVER),
    lint('L1 lint: dir toolchain allowlist', 'dir-toolchain.test.mjs', ['tests/benchmarks/**']),
    lint('L1 lint: data-contract SQL is read-only', 'gate-read-sql-readonly.test.mjs', [...SERVER, ...SCRIPTS]),
    lint('L1 lint: no direct sqlite3 writes in scripts', 'no-direct-sqlite-write.test.mjs', SCRIPTS),
    lint('L1 lint: every sqlite3 call sets a busy timeout', 'sqlite3-needs-timeout.test.mjs', [...SCRIPTS, 'skills/**', 'hooks/**']),
    lint('L1 lint: one trajectory-DB path rule (no private copies)', 'no-private-db-path.test.mjs', SCRIPTS),
    lint('L1 lint: no writes under the home directory', 'no-home-writes.test.mjs', ['tests/l5-l6/**', ...SERVER_SRC]),
    lint('L1 lint: claude CLI config calls pinned to project scope', 'cli-config-scope.test.mjs', ['**/*.{mjs,js,ts}']),
    lint('L1 lint: no in-session plugin commands prescribed', 'no-in-session-plugin-commands.test.mjs', ['**/*.{md,ts,mjs,js,json,yml}']),
    lint('L1 lint: no hard-coded /tmp writes', 'no-tmp-writes.test.mjs', [...SCRIPTS, 'skills/**', 'agents/**', 'commands/**', ...SERVER_SRC], SLOW),
    ['L1 lint: live-db shim survives a plain parent directory', ['node', '--test', join(here, 'lib', 'live-db-shim.test.mjs')], ['tests/lib/**']],
    lint("L1 lint: no datetime('now') in scripts", 'no-datetime-now-in-hooks.test.mjs', [...SCRIPTS, ...SERVER_SRC]),
    lint('L1 lint: no secrets in tracked source', 'no-secrets-in-source.test.mjs', EVERY),
    lint('L1 lint: main-source-guard + CODEOWNERS present', 'main-guard-files-present.test.mjs', WORKFLOWS),
    lint('L1 lint: no filesystem writes at module load', 'no-module-load-writes.test.mjs', SERVER_SRC),
    lint('L1 lint: scan-forking unit tests pin TRAJECTORY_DB_PATH', 'no-unpinned-scan-in-tests.test.mjs', SERVER_TESTS),
    lint('L1 lint: no .tmp-* scratch dir in the checkout', 'no-scratch-in-tree.test.mjs', EVERY),
    lint('L1 lint: nothing finds the project or a repo from the cwd', 'no-cwd-reads.test.mjs', [...SCRIPTS, 'skills/**', ...SERVER_SRC, 'tests/lib/**']),
    // Each lint's per-file scope must select the same repo files as its whole-tree test.
    lint('L1 lint: per-file L1 lint runner (file-lint.ts)', 'file-lint.test.mjs', EVERY),
    lint('L1 lint: /onboard option wording is plain language', 'onboard-option-wording.test.mjs', ['mcp/trajectory-server/src/tools/**']),
    lint('L1 lint: release-payload workflow safety shape', 'release-payload-workflow.test.mjs', WORKFLOWS),
    lint('L1 lint: dev-build l1 job + CONTRIBUTING.md mention it', 'dev-build-l1-docs.test.mjs', [...WORKFLOWS, 'CONTRIBUTING.md']),
    lint('L1 lint: pr-check runs no full sweep', 'pr-check-full-suite.test.mjs', [...WORKFLOWS, 'CONTRIBUTING.md']),
    // node --test expands the glob itself, so the step runs the same files as pr-check's dashboard job.
    [
      'L1 dashboard: node:test suite (dashboard/test/*.test.mjs)',
      ['node', '--test', join(dirname(here), 'dashboard', 'test', '*.test.mjs')],
      ['dashboard/**', ...SERVER],
    ],
  ];
}

/** The L1 steps after the table and its self-checks: the bench selftest and the wm-equivalence reindex check. */
export function l1TailSteps(here: string): { bench: Step; equivalence: Step } {
  return {
    bench: ['L1 bench: measurement harness selftest', ['node', '--test', join(here, 'benchmarks', 'selftest.test.mjs')], ['tests/benchmarks/**']],
    // Its argv names the check, which main() runs as a build followed by the dist test; --l1-local skips it.
    equivalence: [
      'L1 world model: incremental reindex equals a clean rebuild (wm-equivalence.test.js)',
      ['wm_equivalence'],
      SERVER,
      SLOW,
    ],
  };
}

export function l3Steps(here: string): Step[] {
  const ts = ['node', '--experimental-strip-types', '--experimental-sqlite', '--test'];
  const l56 = (...files: string[]) => files.map((f) => join(here, 'l5-l6', f));
  const l3 = (file: string) => ['node', '--test', join(here, 'l3-integration', file)];
  return [
    ['L3 integration: MCP server end-to-end (stdio JSON-RPC)', ['node', join(here, 'l3-integration', 'mcp', 'run.mjs')]],
    ['L3 integration: L5 scorer unit tests', [...ts, ...l56('lib/scorers.test.ts')]],
    [
      'L3 integration: L5/L6 helper libs (TS)',
      [
        ...ts,
        ...l56(
          'lib/flow-helpers.test.ts',
          'lib/l6-chain-helpers.test.ts',
          'lib/sandbox.test.ts',
          'lib/smoke-helpers.test.ts',
          'lib/timeout.test.ts',
        ),
      ],
    ],
    ['L3 integration: L5 row setup scripts (setup-helpers.ts)', [...ts, ...l56('lib/setup-helpers.test.ts')]],
    ['L3 integration: L5 runner (run-l5.ts, stub claude)', [...ts, ...l56('run-l5.test.ts')]],
    ['L3 integration: L6 chain runner (TS)', [...ts, ...l56('run-l6-chain.test.ts')]],
    [
      'L3 integration: sandbox network probe + inspect-trajectory',
      ['node', '--experimental-strip-types', '--test', ...l56('probes/sandbox-network-probe.test.ts', 'inspect-trajectory.test.ts')],
    ],
    ['L3 integration: test orchestrator helpers (run-all.ts)', ['node', '--experimental-strip-types', '--test', join(here, 'run-all.test.ts')]],
    ['L3 integration: runtime payload prune (dev-build)', l3('runtime-payload.test.mjs')],
    ['L3 integration: generated payload parity (dev-build)', l3('payload-parity.test.mjs')],
    ['L3 integration: await payload/<tag> on the remote', l3('await-payload-tag.test.mjs')],
    ['L3 integration: release.ts + publish-rc-channel.ts (stubbed git/gh)', l3('release-scripts.test.mjs')],
    ['L3 integration: changelog fragments + bump-version', l3('changelog-fragments.test.mjs')],
    ['L3 integration: dev-build-version', l3('dev-build-version.test.mjs')],
  ];
}

export function l4Steps(here: string): Step[] {
  const flow = (label: string, file: string): Step => [
    `L4 workflow-sim: ${label}`,
    ['bun', 'test', '--timeout', '30000', join(here, 'l4-workflow-sim', file)],
  ];
  return [
    flow('flow-02 simple-task', 'flow-02-simple-task.test.mjs'),
    flow('flow-03 difficult-task', 'flow-03-difficult-task.test.mjs'),
    flow('flow-06 push-gate', 'flow-06-push-gate.test.mjs'),
    flow('flow-08 swe-retry', 'flow-08-swe-retry.test.mjs'),
    flow('flow-09 anonymous-cold-restart', 'flow-09-anonymous-cold-restart.test.mjs'),
    flow('flow-10 roundtable-composite', 'flow-10-roundtable-composite.test.mjs'),
    flow('flow-11 concurrent-siblings', 'flow-11-concurrent-siblings.test.mjs'),
    flow('flow-12 spec-amend', 'flow-12-spec-amend.test.mjs'),
    flow('flow-13 issue-update-milestone', 'flow-13-issue-update-milestone.test.mjs'),
    flow('flow-14 repo-rename', 'flow-14-repo-rename.test.mjs'),
  ];
}

/** The env for the steps after L1: TMB_L1_OFFLINE is unset, as run-all.sh did once L1 ended. */
export function postL1Env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { TMB_L1_OFFLINE: _offline, ...rest } = env;
  return rest;
}

const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/** The signal that stops the run: one the orchestrator received, else one that killed the step's child. */
export function abortSignal(received: NodeJS.Signals | undefined, childSignal: NodeJS.Signals | null): NodeJS.Signals | undefined {
  if (received !== undefined) return received;
  return childSignal !== null && childSignal in SIGNAL_EXIT ? childSignal : undefined;
}

class Aborted extends Error {
  readonly signal: NodeJS.Signals;
  constructor(signal: NodeJS.Signals) {
    super(`aborted by ${signal}`);
    this.signal = signal;
  }
}

const active: { child?: ChildProcess; received?: NodeJS.Signals } = {};

function onSignal(signal: NodeJS.Signals): void {
  active.received ??= signal;
  active.child?.kill(signal);
}

async function runArgv(argv: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<boolean> {
  if (active.received !== undefined) throw new Aborted(active.received);
  const r = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env, cwd });
    active.child = child;
    child.once('error', (e) => {
      err(`${argv[0]}: ${e.message}\n`);
      resolve({ status: null, signal: null });
    });
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  active.child = undefined;
  const stop = abortSignal(active.received, r.signal);
  if (stop !== undefined) throw new Aborted(stop);
  return r.status === 0;
}

function emptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

export async function main(args: string[]): Promise<number> {
  const runArgs = parseArgs(args);
  const runTmp = mkdtempSync(join(tmpdir(), 'tmb-run-all.'));
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    return await run(runArgs, runTmp);
  } catch (e) {
    if (!(e instanceof Aborted)) throw e;
    out(`\n→ ABORTED: ${e.signal}, no further steps run\n`);
    return SIGNAL_EXIT[e.signal];
  } finally {
    rmSync(runTmp, { recursive: true, force: true });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** The L1 steps a run selects: --l1-changed by its diff, --l1-local the non-slow ones, else all. */
function runnableL1(args: RunArgs, steps: Step[]): Step[] {
  if (args.l1Local) return l1LocalSteps(steps);
  if (!args.l1Changed) return steps;
  const base = changedBase(args.base, process.env.TMB_LINT_BASE_SHA);
  const changed = base === null ? null : changedPaths(PLUGIN_ROOT, base);
  const selected = selectL1Steps(steps, changed);
  if (base === null) out('\n→ --l1-changed: no --base or TMB_LINT_BASE_SHA, so the full L1 runs\n');
  else if (changed === null) out(`\n→ --l1-changed: git diff ${base}...HEAD failed, so the full L1 runs\n`);
  else out(`\n→ --l1-changed: ${changed.length} paths changed since ${base}; ${selected.length} of ${steps.length} L1 steps selected\n`);
  return selected;
}

async function run(args: RunArgs, runTmp: string): Promise<number> {
  const { l1Only } = args;
  let fail = false;
  const home = process.env.HOME ?? homedir();
  const homeIsolated = emptyDir(home);
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    TMB_DISABLE_REMOTE_SYNC: '1',
    BUN_INSTALL_CACHE_DIR: join(runTmp, 'bun-install-cache'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(runTmp, 'bun-transpiler-cache'),
  };
  Object.assign(base, miseEnv(base, runTmp));

  const stubDir = join(runTmp, 'stubs');
  const sentinel = join(stubDir, 'live-cli-sentinel');
  writeStubs(stubDir, sentinel);
  const scanPluginJson = join(runTmp, 'claude-plugin-list.json');
  writeFileSync(scanPluginJson, '[]\n');
  const stubPath = `${stubDir}${delimiter}${base.PATH ?? ''}`;
  const forbidLive = { PATH: stubPath, TMB_FORBID_LIVE_SYNC: '1', TMB_SCAN_PLUGIN_JSON: scanPluginJson };

  const skipList = process.env.TMB_L1_SKIP;
  const runStep = async (label: string, argv: string[], env: NodeJS.ProcessEnv, check?: () => boolean | Promise<boolean>) => {
    out(`\n=== ${label} ===\n`);
    if (l1Skipped(argv, skipList)) {
      out('→ SKIP (TMB_L1_SKIP)\n');
    } else if (await (check ? check() : runArgv(argv, env))) {
      out('→ PASS\n');
    } else {
      out('→ FAIL\n');
      fail = true;
    }
  };
  const skipMode = args.l1Changed ? '--l1-changed' : '--l1-local';
  const skipUnselected = (label: string) => out(`\n=== ${label} ===\n→ SKIP (${skipMode})\n`);
  const liveCliCheck = (step: string) => {
    const calls = readFileSync(sentinel, 'utf8');
    if (calls !== '') {
      out(`→ FAIL: live CLI calls detected during ${step}:\n${calls}`);
      writeFileSync(sentinel, '');
      fail = true;
    } else {
      out(`→ sentinel 0-byte: no live CLI calls during ${step}. PASS\n`);
    }
  };

  await runStep('Build: generated payload (bun run build:payload)', ['bun', 'run', '--cwd', PLUGIN_ROOT, 'build:payload'], base);

  const l1Env = { ...base, PATH: stubPath, TMB_L1_OFFLINE: '1' };
  const steps = l1Steps(HERE);
  const { bench, equivalence } = l1TailSteps(HERE);
  const everyL1 = [...steps, bench, equivalence];
  const runnable = new Set(runnableL1(args, everyL1));
  const runL1 = async (step: Step, check?: () => boolean | Promise<boolean>) => {
    const [label, argv] = step;
    if (runnable.has(step)) await runStep(label, argv, l1Env, check);
    else skipUnselected(label);
  };
  for (const step of steps) await runL1(step);
  await runStep('L1 self-check: every tests/l1-lint/*.sh and *.test.mjs runs here', ['l1_lints_all_wired'], l1Env, () => {
    const missing = unwiredLints(l1LintFiles(join(HERE, 'l1-lint')), steps);
    for (const lint of missing) err(`  ✗ tests/l1-lint/${lint} has no step in tests/run-all.ts\n`);
    return missing.length === 0;
  });
  await runStep('L1 self-check: every L1 step declares its input globs', ['l1_inputs_declared'], l1Env, () => {
    const undeclared = undeclaredInputSteps(everyL1);
    for (const label of undeclared) err(`  ✗ "${label}" declares no input globs in tests/run-all.ts\n`);
    return undeclared.length === 0;
  });
  await runL1(bench);
  const serverDir = join(PLUGIN_ROOT, 'mcp', 'trajectory-server');
  const equivalenceTest = join('dist', 'test', 'wm-equivalence.test.js');
  await runL1(equivalence, async () => {
    if (!(await runArgv(['bun', 'run', 'build'], l1Env, serverDir))) return false;
    return await runArgv(['node', '--experimental-sqlite', '--test', equivalenceTest], { ...l1Env, ...forbidLive }, serverDir);
  });
  liveCliCheck('L1');
  if (l1Only) return fail ? 1 : 0;

  const afterL1 = postL1Env(base);
  const l2Env = { ...afterL1, ...forbidLive };
  await runStep('L2 unit: MCP handlers (node --test on built dist/, live-CLI stubs)', ['l2_unit'], l2Env, async () => {
    if (!(await runArgv(['bun', 'run', 'build'], l2Env, serverDir))) return false;
    const testDir = join(serverDir, 'dist', 'test');
    const files = readdirSync(testDir)
      .filter((name) => name.endsWith('.test.js'))
      .sort()
      .map((name) => join('dist', 'test', name));
    if (files.length === 0) {
      err(`no dist/test/*.test.js under ${serverDir}\n`);
      return false;
    }
    return await runArgv(['node', '--experimental-sqlite', '--test', ...files], l2Env, serverDir);
  });
  liveCliCheck('L2');

  for (const [label, argv] of l3Steps(HERE)) await runStep(label, argv, afterL1);

  const l4Env = { ...afterL1, ...forbidLive };
  for (const [label, argv] of l4Steps(HERE)) await runStep(label, argv, l4Env);
  liveCliCheck('L4');

  if (homeIsolated) {
    out('\n=== HOME footprint (run started with an empty HOME) ===\n');
    const leaks = homeLeaks(walkTree(home));
    if (leaks.length > 0) {
      out(`→ FAIL: the run wrote under HOME:\n${leaks.map((p) => `$HOME/${p}`).join('\n')}\n`);
      fail = true;
    } else {
      out('→ PASS: HOME holds nothing but .cache/huggingface\n');
    }
  }

  out('\n========================================\n');
  if (!fail) {
    out('All test layers passed (L1 + L2 + L3 + L4).\n');
    out(
      'L0 install-smoke is separate: run node --experimental-strip-types tests/l0-install/run-docker.ts install with Docker before a PR (release-gate also runs it on rc tags).\n',
    );
    return 0;
  }
  out('One or more layers FAILED. See output above.\n');
  return 1;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
