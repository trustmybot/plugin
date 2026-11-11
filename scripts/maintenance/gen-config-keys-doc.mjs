#!/usr/bin/env node
// Regenerates the plugin_config key table in docs/reference/CONFIG_KEYS.md
// (between the config-keys:generated markers).
//
// The key set comes from the code: every key the server (mcp/trajectory-server/src,
// tests and db.ts migrations excluded) or a script (scripts/) reads or writes,
// plus the keys schema.sql seeds. Defaults of seeded keys come from the seed.
// KEYS below carries what code cannot say — type, who sets the key, its
// effect. A key found in code with no KEYS entry, or a KEYS entry no code
// touches, fails the run.
//   (no flag)     rewrite the doc in place
//   --check       write nothing; exit 1 when the committed doc differs or the
//                 key set disagrees with KEYS
//   --root <dir>  read and write docs/reference/CONFIG_KEYS.md under <dir> (lint self-tests)

import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- config-keys:generated:start -->';
export const END = '<!-- config-keys:generated:end -->';

export const KEYS = [
  {
    name: 'issue_sync',
    type: 'string: `auto` \\| `gh` \\| `glab` \\| `both` \\| `off`',
    setBy: '`/onboard` (`onboard_apply` writes `auto` or `off`); bro via `config_set`',
    effect: 'Whether issue writes mirror to GitHub/GitLab and through which CLI; `auto` picks from the repo\'s remotes and CLI auth. `TMB_DISABLE_REMOTE_SYNC=1` forces it off.',
  },
  {
    name: 'issue_classification_labels',
    type: 'string[]',
    setBy: 'bro via `config_set`',
    effect: '`issue_create` requires at least one of these labels; unset or malformed falls back to the generic default.',
  },
  {
    name: 'issue_priority_labels',
    type: 'string[]',
    setBy: 'bro via `config_set`',
    effect: '`issue_create` requires at least one of these labels; unset or malformed falls back to the generic default.',
  },
  {
    name: 'issue_area_labels',
    type: 'string[]',
    defaultText: 'unset (no area required)',
    setBy: 'bro via `config_set` (anything but an array of non-empty strings is refused)',
    effect: 'When non-empty, `issue_create`, `issue_update` (when labels are passed), and `intent_start` require exactly one of these labels; zero is `missing_required_labels`, two or more is `multiple_area_labels`. Unset or `[]` changes nothing.',
  },
  {
    name: 'issue_area_paths',
    type: 'object: `{"<path prefix>": "<area label>"}`',
    defaultText: 'unset (no inference)',
    setBy: 'bro via `config_set` (anything but an object of non-empty strings is refused)',
    effect: 'When `issue_area_labels` is set and the caller passes no area, `issue_create` / `intent_start` match the paths named in the objective and description against these prefixes (longest wins), append the one area found and return it as `area_inferred`; paths in two or more areas refuse with `ambiguous_area`.',
  },
  {
    name: 'model_prices',
    type: 'object: `{"<model>": {input, output, cache_read, cache_creation}}` (USD per 1M tokens)',
    setBy: 'bro via `config_set`',
    effect: '`task_stats` prices each `agent_runs` row by its `model` into `cost_estimate`; rows of an unpriced model are reported as `unpriced_tokens`.',
  },
  {
    name: 'onboarded',
    type: 'boolean `true`',
    defaultText: 'unset until `/onboard` completes',
    setBy: '`/onboard` (`onboard_apply`)',
    effect: 'Marks the project onboarded; while unset the activation hook routes bro to `/onboard`.',
  },
  {
    name: 'headless_enforcement',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`)',
    setBy: '`onboard_apply`, on request: the `headless-intent` hint asks the Human first',
    effect: '`yes` writes the plugin\'s PreToolUse gates into the project\'s `.claude/settings.local.json` so they fire in headless `claude -p` runs; `no` removes them.',
  },
  {
    name: 'sandbox_enforcement',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`); a fresh `/onboard` defaults to `yes` on macOS and `no` elsewhere until a Linux probe is recorded ([sandbox support](./INSTALL.md#sandbox-support))',
    setBy: '`/onboard` (`onboard_apply`)',
    effect: '`yes` writes Claude Code\'s Bash sandbox block into the project\'s `.claude/settings.local.json`; `no` removes what TMB wrote.',
  },
  {
    name: 'bug_report_consent',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`)',
    setBy: '`/onboard` (`onboard_apply`, the `bug_report` round); `onboard_apply` with `bug_report_consent` alone on an onboarded project',
    effect: '`yes` lets bro offer to draft a TMB bug report for github.com/trustmybot/plugin, filed only after the Human approves each one; `no` means bro never offers.',
  },
  {
    name: 'sandbox_settings',
    type: 'object: `{enabled_set, allow_write, allowed_domains, weaker_network_isolation_set, allow_local_binding_set, env}`',
    defaultText: 'unset',
    setBy: '`onboard_apply`',
    effect: 'Records exactly what TMB added to the sandbox block, so answering `no` removes only that.',
  },
  {
    name: 'pr_review_bots',
    type: 'string[] (bot login patterns)',
    defaultText: 'unset (built-in bot patterns only)',
    setBy: 'bro via `config_set`',
    effect: '`pr_monitor_comments_get` adds these to its built-in patterns when filtering bot comments.',
  },
  {
    name: 'verification_timeout_s',
    type: 'integer (seconds)',
    defaultText: 'unset (900)',
    setBy: 'bro via `config_set`',
    effect: '`swe-verification-gate` gives one run of a task\'s `verification[]` this many seconds of command time on the swe close (the run-record writes are budgeted apart), clamped to 1–1800; 0 or a non-integer falls back to 900 with a stderr warning. `TMB_VERIFICATION_TIMEOUT_S` overrides it (tests).',
  },
  {
    name: 'readme_nudge_skip_dirs',
    type: 'string[]: path segments',
    defaultText: 'unset (read as `["dist","build","changelog.d","fixtures","test","tests","__tests__","node_modules"]`)',
    setBy: 'bro via `config_set`',
    effect: 'The post-close README nudge (`post-atomic-close-readme`, GH 1965) skips a touched dir when any of its path segments is listed; unset, malformed JSON or anything but an array of strings reads as the default, and `[]` skips nothing.',
  },
  {
    name: 'swe_default_effort',
    type: 'string: `low` \\| `medium` \\| `high`',
    defaultText: 'unset (read as `medium`)',
    setBy: 'bro via `config_set` (any other value is refused)',
    effect: 'The `tasks.effort` a task gets when `task_create_batch` / `task_provision` name none. `require-spawn-effort` denies a swe spawn whose Agent `effort` differs from the task\'s, or is not `high` while the task has a review FAIL since its last pass (GH 2866: the FAIL reopens the task at `high`, and `task_reopen` refuses a lower effort then); `swe-atomic-close` copies the task\'s effort onto the swe `agent_runs` row.',
  },
  {
    name: 'high_effort_paths',
    type: 'string[]: path prefixes',
    defaultText: 'unset (read as `[]`)',
    setBy: 'bro via `config_set` (anything but an array of non-empty strings is refused)',
    effect: 'A files[] entry that equals or sits under (or contains) a listed prefix, with directory semantics, raises the `tasks.effort` a task gets to `high` when `task_create_batch` / `task_provision` name none; the other triggers are a prompt-bearing task and rework by `task_reopen` / `task_retry`, and an explicit `effort` always wins.',
  },
  {
    name: 'change_impact_agent_surface',
    type: 'string[]: git globs, each bare or `<repo>:<glob>`',
    defaultText: 'unset (`CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.claude/settings*.json`)',
    setBy: 'bro via `config_set`',
    effect: '`change_impact` (GH 2600) lists as `agent_surface` changes the first-parent commits on each `repos` row\'s base branch that touch these globs, replacing the default; a `<repo>:<glob>` entry applies to that repo only. Unset or malformed reads as the default.',
  },
  {
    name: 'swe_effort_ab',
    type: 'object: `{label: string, target: positive integer}`',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (any other shape is refused)',
    effect: 'The opt-in swe effort A/B (GH 1745): while fewer than `target` tasks carry `label`, a new task from `task_provision` / `task_create_batch` whose computed effort is the default or an explicit `medium` runs at the arm of its id\'s parity (even `high`, odd `medium`, `effort_reason` `ab_arm`) with one `effort_ab_enrolled` audit row. Reworks, explicit `high` / `low`, prompt-bearing and `high_effort_paths` tasks are never enrolled. `node scripts/maintenance/effort-ab-report.ts --label <label>` reports the arms. Unset or malformed is off.',
  },
  {
    name: 'downstream_context_ab',
    type: 'object: `{label: string, target: positive integer, tools_shipped_at: ISO timestamp}`',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (`{}` is off; any other shape is refused)',
    effect: 'The opt-in downstream-context A/B (GH 1990): the first `swe-downstream-context` or `reviewer-downstream-context` call for a task enrolls it while fewer than `target` tasks carry `label`, at arm `on` when `floor(task_id / 2)` is odd, else `off`, with one `downstream_context_ab_enrolled` audit row. Only `on` tasks get the hooks\' direct-downstream context. `tools_shipped_at` bounds the report\'s baseline: the 20 most recent closed tasks before it (`src/downstream-context-ab-report.ts`). Unset, `{}` or malformed is off.',
  },
  {
    name: 'reviewer_effort',
    type: 'string: `low` \\| `medium` \\| `high`',
    defaultText: 'unset (read as `medium`)',
    setBy: 'bro via `config_set` (any other value is refused)',
    effect: 'The fixed code-reviewer effort: what `review_handoff` assigns a task\'s review (in its `reviewer_effort_assigned` row, returned as `reviewer_effort`) unless `reviewer_effort_tiers` or the `tiered` arm of `reviewer_effort_ab` assigns the risk tier, and the effort for a review with no assignment (no `task_id=<N>` in the prompt, or a task never handed off, such as one closed by `task_recover`). `require-spawn-effort` denies a code-reviewer spawn whose Agent `effort` differs from the expected one, or whose `model` differs from the one `reviewer_tier_settings` assigned (none unless assigned); `swe-atomic-close` records the same effort on the code-reviewer `agent_runs` row.',
  },
  {
    name: 'reviewer_effort_tiers',
    type: 'boolean',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (anything but a boolean is refused)',
    effect: 'The opt-in reviewer effort by risk tier (GH 1955): `true` makes every `review_handoff` assign the review the tier of the handoff-time scope diff: `high` for a prompt-bearing task or a changed path overlapping a `high_effort_paths` prefix, `low` when every changed path is docs (`*.md`, under `docs/`) or tests (a `test` / `tests` / `__tests__` segment, `.test.` / `.spec.` in the name), else `medium`. A task enrolled in `reviewer_effort_ab` follows its arm instead. Unset or `false` assigns `reviewer_effort`.',
  },
  {
    name: 'reviewer_effort_ab',
    type: 'object: `{label: string, target: positive integer}`',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (any other shape is refused)',
    effect: 'The opt-in reviewer effort A/B (GH 1955): a task is enrolled at its first `review_handoff` while fewer than `target` tasks carry a `reviewer_effort_assigned` row with `label`; even ids get arm `tiered` (the risk tier), odd ids `fixed` (`reviewer_effort`), and an enrolled task keeps its arm on every later handoff. A task not enrolled follows `reviewer_effort_tiers`. Unset or malformed is off.',
  },
  {
    name: 'reviewer_tier_settings',
    type: 'object: `{"<tier reason>": {model?: "opus" \\| "sonnet" \\| "haiku" \\| "fable", effort?: "low" \\| "medium" \\| "high"}}`, tier reason one of `prompt_bearing`, `high_effort_paths`, `docs_tests`, `default`',
    defaultText: 'unset (no overrides)',
    setBy: 'bro via `config_set` (an unknown reason, model, effort or field is refused)',
    effect: 'The model and effort a risk-tier review runs at (GH 2932): when `reviewer_effort_tiers` or the `tiered` arm of `reviewer_effort_ab` assigns the tier, `review_handoff` takes the entry for the tier\'s reason, its `effort` replacing the tier effort and its `model` recorded as `model` in the `reviewer_effort_assigned` row and returned in `reviewer_spawn` (for example `{"docs_tests": {"model": "sonnet", "effort": "high"}}`). A reason with no entry, or with no `model`, keeps the tier effort and the code-reviewer\'s own model; the fixed `reviewer_effort` path never gets a model. `require-spawn-effort` admits a code-reviewer spawn only with the assigned model, or with no model when none is assigned. Unset or malformed applies no overrides.',
  },
  {
    name: 'workflow_mode',
    type: 'string: `truest` \\| `agile`',
    defaultText: 'unset (read as `truest`)',
    setBy: 'the Human through `/onboard` only (its `onboard_apply` input is still to come under GH 2225): `config_set` refuses the key with `human_only_config_key`, and any value other than `truest` or `agile` is refused',
    effect: 'The project\'s workflow mode (GH 2225). The shared close path of `bro_atomic_close` and `task_recover` stamps it on `tasks.workflow_mode` when a task closes; unset, unparseable or unknown reads as `truest`. No gate reads it yet.',
  },
  {
    name: 'world_model_test_lane',
    type: 'object: `{extend?: glob[], exclude?: glob[]}`, each an array of non-blank strings',
    defaultText: 'unset (the default rules only)',
    setBy: 'bro via `config_set` (any other shape is refused)',
    effect: 'The project\'s test lane (GH 2886): paths the world model treats as tests, on top of the default per-language rules (dirs `test`, `tests`, `__tests__`, `spec`, `e2e`, `fixtures`; names `*.test.*`, `*.spec.*`, `*.suite.*`, `*_test.go`, `test_*.py`, `*_test.py`, `*_spec.rb`, `conftest.py`). A path matching an `extend` glob is test; one matching an `exclude` glob is product, and `exclude` wins. Each `scan_run` reads it and stores every file\'s lane in `wm_files.lane`; the server reads it again at start for in-process readers. A malformed stored value reads as the defaults.',
  },
];

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, '');
}

export function seededDefaults(schemaSql) {
  const seeds = new Map();
  const block = /INSERT OR IGNORE INTO plugin_config\s*\(key,\s*value_json\)\s*VALUES([\s\S]*?);/i.exec(stripSqlComments(schemaSql));
  if (!block) return seeds;
  for (const m of block[1].matchAll(/\(\s*'([a-z][a-z0-9_.-]*)'\s*,\s*'((?:[^']|'')*)'\s*\)/g)) {
    seeds.set(m[1], m[2].replace(/''/g, "'"));
  }
  return seeds;
}

const KEY_PATTERNS = [
  /plugin_config[^;]{0,160}?\bkey\s*=\s*'([a-z][a-z0-9_.-]*)'/g,
  /INSERT INTO plugin_config\s*\(key,\s*value_json\)\s*VALUES\s*\(\s*'([a-z][a-z0-9_.-]*)'/g,
  /\b[A-Za-z]*Config[A-Za-z]*\(\s*[A-Za-z_.]+\s*,\s*'([a-z][a-z0-9_.-]*)'/g,
  /\b[A-Z][A-Z_]*_KEY\s*=\s*'([a-z][a-z0-9_.-]*)'/g,
  /\btmb_config_(?:get|raw|array)\s+["']?([a-z][a-z0-9_.-]*)/g,
];

function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

// Map key → sorted list of repo-relative files that read or write it.
export function discoverKeys(repo) {
  const src = join(repo, 'mcp/trajectory-server/src');
  const self = fileURLToPath(import.meta.url);
  const files = [
    ...walk(src, (p) => p.endsWith('.ts') && !p.includes('/test/') && !p.endsWith('/db.ts')),
    ...walk(join(repo, 'scripts'), (p) => /\.(sh|mjs)$/.test(p) && p !== self),
  ];
  const found = new Map();
  const add = (key, file) => {
    if (!found.has(key)) found.set(key, new Set());
    found.get(key).add(relative(repo, file));
  };
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of KEY_PATTERNS) {
      for (const m of text.matchAll(pattern)) add(m[1], file);
    }
  }
  const schema = join(src, 'schema.sql');
  for (const key of seededDefaults(readFileSync(schema, 'utf8')).keys()) add(key, schema);
  return new Map([...found].map(([k, v]) => [k, [...v].sort()]));
}

export function keySetErrors(found, keys = KEYS) {
  const documented = new Set(keys.map((k) => k.name));
  const errors = [];
  for (const key of [...found.keys()].sort()) {
    if (!documented.has(key)) errors.push(`plugin_config key '${key}' is used in ${found.get(key).join(', ')} but has no KEYS entry in scripts/maintenance/gen-config-keys-doc.mjs`);
  }
  for (const key of documented) {
    if (!found.has(key)) errors.push(`plugin_config key '${key}' has a KEYS entry but no code reads or writes it`);
  }
  return errors;
}

export function renderSection(found, seeds, keys = KEYS) {
  const rows = keys.map((k) => {
    const dflt = seeds.has(k.name) ? `\`${seeds.get(k.name)}\` (schema seed)` : k.defaultText;
    const where = (found.get(k.name) ?? []).map((f) => `\`${f}\``).join(', ');
    return `| \`${k.name}\` | ${k.type} | ${dflt.replace(/\|/g, '\\|')} | ${k.setBy} | ${k.effect} | ${where} |`;
  });
  return [
    BEGIN,
    '_Generated by `scripts/maintenance/gen-config-keys-doc.mjs` from the keys the code reads and writes; `tests/l1-lint/config-keys-doc-fresh.test.mjs` fails when it drifts._',
    '',
    '| Key | Type | Default | Set by | Effect | Read / written in |',
    '|---|---|---|---|---|---|',
    ...rows,
    END,
  ].join('\n');
}

export function renderDoc(current, found, seeds) {
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) throw new Error(`generated markers missing (${BEGIN} … ${END})`);
  return current.slice(0, start) + renderSection(found, seeds) + current.slice(end + END.length);
}

function main() {
  const argv = process.argv.slice(2);
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rootAt = argv.indexOf('--root');
  const root = rootAt >= 0 ? argv[rootAt + 1] : repo;
  const doc = join(root, 'docs/reference/CONFIG_KEYS.md');
  const found = discoverKeys(repo);
  const seeds = seededDefaults(readFileSync(join(repo, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
  const errors = keySetErrors(found);
  for (const e of errors) console.error(`  ✗ ${e}`);
  const have = readFileSync(doc, 'utf8');
  const want = renderDoc(have, found, seeds);
  if (have !== want) {
    if (argv.includes('--check')) {
      console.error(`  ✗ ${relative(root, doc)} differs from what the code generates`);
      process.exit(1);
    }
    writeFileSync(doc, want);
  }
  if (errors.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
