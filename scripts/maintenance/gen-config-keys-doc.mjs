#!/usr/bin/env node
// Regenerates the plugin_config key table in docs/architecture/CONFIG_KEYS.md
// (between the config-keys:generated markers).
//
// The key set comes from the code: every key the server (mcp/trajectory-server/src,
// tests and db.ts migrations excluded) or a script (scripts/) reads or writes,
// plus the keys schema.sql seeds. Defaults of seeded keys come from the seed.
// KEYS below carries what code cannot say — type, who sets the key, its
// effect. A key found in code with no KEYS entry, or a KEYS entry no code
// touches, fails the run. The emitted text is a user reference: it names
// keys, commands and values, never code symbols, files or issue numbers.
//   (no flag)     rewrite the doc in place
//   --check       write nothing; exit 1 when the committed doc differs or the
//                 key set disagrees with KEYS
//   --root <dir>  read and write docs/architecture/CONFIG_KEYS.md under <dir> (lint self-tests)

import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '<!-- config-keys:generated:start -->';
export const END = '<!-- config-keys:generated:end -->';

export const KEYS = [
  {
    name: 'issue_sync',
    type: 'string: `auto` \\| `gh` \\| `glab` \\| `both` \\| `off`',
    setBy: '`/onboard` (writes `auto` or `off`); bro via `config_set`',
    effect: 'Whether issue writes mirror to GitHub/GitLab and through which CLI; `auto` picks from the repo\'s remotes and CLI auth. Setting `TMB_DISABLE_REMOTE_SYNC` forces it off.',
  },
  {
    name: 'issue_classification_labels',
    type: 'string[]',
    setBy: 'bro via `config_set`',
    effect: 'A new issue needs at least one of these labels; unset or malformed falls back to a generic default.',
  },
  {
    name: 'issue_priority_labels',
    type: 'string[]',
    setBy: 'bro via `config_set`',
    effect: 'A new issue needs at least one of these labels; unset or malformed falls back to a generic default.',
  },
  {
    name: 'issue_area_labels',
    type: 'string[]',
    defaultText: 'unset (no area required)',
    setBy: 'bro via `config_set` (anything but an array of non-empty strings is refused)',
    effect: 'When non-empty, creating an issue, changing its labels or starting an intent needs exactly one of these labels; none or two or more is refused. Unset or `[]` changes nothing.',
  },
  {
    name: 'issue_area_paths',
    type: 'object: `{"<path prefix>": "<area label>"}`',
    defaultText: 'unset (no inference)',
    setBy: 'bro via `config_set` (anything but an object of non-empty strings is refused)',
    effect: 'When `issue_area_labels` is set and no area is given, the area is inferred from the paths named in the objective and description, the longest matching prefix winning; paths in two or more areas are refused.',
  },
  {
    name: 'model_prices',
    type: 'object: `{"<model>": {input, output, cache_read, cache_creation}}` (USD per 1M tokens)',
    setBy: 'bro via `config_set`',
    effect: '`task_stats` prices each agent run\'s tokens by its model; tokens of an unpriced model are reported separately.',
  },
  {
    name: 'onboarded',
    type: 'boolean `true`',
    defaultText: 'unset until `/onboard` completes',
    setBy: '`/onboard`',
    effect: 'Marks the project onboarded; while unset, bro is routed to `/onboard`.',
  },
  {
    name: 'headless_enforcement',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`)',
    setBy: '`/onboard`, on request, after bro asks the Human',
    effect: '`yes` writes the plugin\'s PreToolUse gates into the project\'s `.claude/settings.local.json` so they fire in headless `claude -p` runs; `no` removes them.',
  },
  {
    name: 'sandbox_enforcement',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`); a fresh `/onboard` defaults to `yes` on macOS and `no` elsewhere until a Linux probe is recorded ([sandbox support](./INSTALL.md#operating-systems))',
    setBy: '`/onboard`',
    effect: '`yes` writes Claude Code\'s Bash sandbox block into the project\'s `.claude/settings.local.json`; `no` removes what TMB wrote.',
  },
  {
    name: 'bug_report_consent',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`)',
    setBy: '`/onboard` (its bug-report question, which an onboarded project can also answer alone)',
    effect: '`yes` lets bro offer to draft a TMB bug report for github.com/trustmybot/plugin, filed only after the Human approves each one; `no` means bro never offers.',
  },
  {
    name: 'sandbox_settings',
    type: 'object',
    defaultText: 'unset',
    setBy: '`/onboard`',
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
    effect: 'The command time one run of a task\'s verification commands gets when swe closes the task, clamped to 1–1800; 0 or a non-integer falls back to 900 with a warning. `TMB_VERIFICATION_TIMEOUT_S` overrides it (tests).',
  },
  {
    name: 'readme_nudge_skip_dirs',
    type: 'string[]: path segments',
    defaultText: 'unset (read as `["dist","build","changelog.d","fixtures","test","tests","__tests__","node_modules"]`)',
    setBy: 'bro via `config_set`',
    effect: 'The post-close README nudge skips a touched dir when any of its path segments is listed; unset, malformed JSON or anything but an array of strings reads as the default, and `[]` skips nothing.',
  },
  {
    name: 'swe_default_effort',
    type: 'string: `low` \\| `medium` \\| `high`',
    defaultText: 'unset (read as `medium`)',
    setBy: 'bro via `config_set` (any other value is refused)',
    effect: 'The effort a task gets when its creator names none. A swe spawn must run at the task\'s effort, and at `high` while the task has a review FAIL since its last pass (the FAIL reopens the task at `high`).',
  },
  {
    name: 'high_effort_paths',
    type: 'string[]: path prefixes',
    defaultText: 'unset (read as `[]`)',
    setBy: 'bro via `config_set` (anything but an array of non-empty strings is refused)',
    effect: 'A task with a files[] entry that equals, sits under or contains a listed prefix gets effort `high` when its creator names none; a prompt-bearing task and rework also get `high`, and an explicit effort always wins.',
  },
  {
    name: 'change_impact_agent_surface',
    type: 'string[]: git globs, each bare or `<repo>:<glob>`',
    defaultText: 'unset (`CLAUDE.md`, `.claude/agents/**`, `.claude/skills/**`, `.claude/settings*.json`)',
    setBy: 'bro via `config_set`',
    effect: '`change_impact` counts as agent-surface changes the first-parent commits on each repo\'s base branch that touch these globs, replacing the default; a `<repo>:<glob>` entry applies to that repo only. Unset or malformed reads as the default.',
  },
  {
    name: 'swe_effort_ab',
    type: 'object: `{label: string, target: positive integer}`',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (any other shape is refused)',
    effect: 'The opt-in swe effort experiment: while fewer than `target` tasks carry `label`, a new task whose effort would be the default or an explicit `medium` runs at the arm its id\'s parity picks (even `high`, odd `medium`). Rework, an explicit `high` or `low`, and prompt-bearing and `high_effort_paths` tasks are never enrolled. Unset or malformed is off.',
  },
  {
    name: 'downstream_context_ab',
    type: 'object: `{label: string, target: positive integer, tools_shipped_at: ISO timestamp}`',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (`{}` is off; any other shape is refused)',
    effect: 'The opt-in downstream-context experiment: a task is enrolled the first time swe edits for it or code-reviewer starts on it while fewer than `target` tasks carry `label`, into arm `on` or `off` by its id. Only `on` tasks get the direct downstream of the code they touch as context. `tools_shipped_at` bounds the report\'s baseline, the 20 most recent closed tasks before it. Unset, `{}` or malformed is off.',
  },
  {
    name: 'reviewer_effort',
    type: 'string: `low` \\| `medium` \\| `high`',
    defaultText: 'unset (read as `medium`)',
    setBy: 'bro via `config_set` (any other value is refused)',
    effect: 'The fixed code-reviewer effort: what a review is assigned unless a risk tier is (`reviewer_effort_tiers`, or the `tiered` arm of `reviewer_effort_ab`), and the effort of a review with no assignment. A code-reviewer spawn must run at the expected effort.',
  },
  {
    name: 'reviewer_effort_tiers',
    type: 'boolean',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (anything but a boolean is refused)',
    effect: 'The opt-in reviewer effort by risk tier: `true` gives each review the tier of its changed paths: `high` for a prompt-bearing task or a path overlapping a `high_effort_paths` prefix, `low` when every path is docs (`*.md`, under `docs/`) or tests, else `medium`. A task enrolled in `reviewer_effort_ab` follows its arm instead. Unset or `false` assigns `reviewer_effort`.',
  },
  {
    name: 'reviewer_effort_ab',
    type: 'object: `{label: string, target: positive integer}`',
    defaultText: 'unset (off)',
    setBy: 'bro via `config_set` (any other shape is refused)',
    effect: 'The opt-in reviewer effort experiment: a task is enrolled at its first review handoff while fewer than `target` tasks carry `label`; even ids get arm `tiered` (the risk tier), odd ids `fixed` (`reviewer_effort`), and an enrolled task keeps its arm. A task not enrolled follows `reviewer_effort_tiers`. Unset or malformed is off.',
  },
  {
    name: 'reviewer_tier_settings',
    type: 'object: `{"<tier reason>": {model?: "opus" \\| "sonnet" \\| "haiku" \\| "fable", effort?: "low" \\| "medium" \\| "high"}}`, tier reason one of `prompt_bearing`, `high_effort_paths`, `docs_tests`, `default`',
    defaultText: 'unset (no overrides)',
    setBy: 'bro via `config_set` (an unknown reason, model, effort or field is refused)',
    effect: 'The model and effort a risk-tier review runs at, per tier reason, for example `{"docs_tests": {"model": "sonnet", "effort": "high"}}`. A reason with no entry, or no `model`, keeps the tier effort and the code-reviewer\'s own model; a fixed-effort review never gets a model. Unset or malformed applies no overrides.',
  },
  {
    name: 'bro_compact_nudge_tokens',
    type: 'non-negative integer',
    defaultText: 'unset (read as `80000`)',
    setBy: 'bro via `config_set` (anything but a non-negative integer is refused)',
    effect: 'The bro context size, in tokens, past which bro gets one advisory line per session asking the Human to run /compact at the next natural break. It never blocks. `0` turns it off; malformed reads as the default.',
  },
  {
    name: 'workflow_mode',
    type: 'string: `truest` \\| `agile`',
    defaultText: 'unset (read as `truest`)',
    setBy: 'the Human through `/onboard` only, which does not ask for it yet: `config_set` refuses the key, and any value other than `truest` or `agile` is refused',
    effect: 'The project\'s workflow mode, stamped on each task when it closes; unset, unparseable or unknown reads as `truest`. No gate reads it yet.',
  },
  {
    name: 'world_model_test_lane',
    type: 'object: `{extend?: glob[], exclude?: glob[]}`, each an array of non-blank strings',
    defaultText: 'unset (the default rules only)',
    setBy: 'bro via `config_set` (any other shape is refused)',
    effect: 'Paths the world model treats as tests, on top of the default per-language rules (dirs `test`, `tests`, `__tests__`, `spec`, `e2e`, `fixtures`; names `*.test.*`, `*.spec.*`, `*.suite.*`, `*_test.go`, `test_*.py`, `*_test.py`, `*_spec.rb`, `conftest.py`). A path matching an `extend` glob is a test; one matching an `exclude` glob is product, and `exclude` wins. Each scan reads it; a malformed value reads as the defaults.',
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

export function renderSection(seeds, keys = KEYS) {
  const rows = keys.map((k) => {
    const dflt = seeds.has(k.name) ? `\`${seeds.get(k.name)}\` (schema seed)` : k.defaultText;
    return `| \`${k.name}\` | ${k.type} | ${dflt.replace(/[\\|]/g, '\\$&')} | ${k.setBy} | ${k.effect} |`;
  });
  return [
    BEGIN,
    '_Generated by `scripts/maintenance/gen-config-keys-doc.mjs` from the keys the code reads and writes; `tests/l1-lint/config-keys-doc-fresh.test.mjs` fails when it drifts._',
    '',
    '| Key | Type | Default | Set by | Effect |',
    '|---|---|---|---|---|',
    ...rows,
    END,
  ].join('\n');
}

export function renderDoc(current, seeds) {
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) throw new Error(`generated markers missing (${BEGIN} … ${END})`);
  return current.slice(0, start) + renderSection(seeds) + current.slice(end + END.length);
}

function main() {
  const argv = process.argv.slice(2);
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rootAt = argv.indexOf('--root');
  const root = rootAt >= 0 ? argv[rootAt + 1] : repo;
  const doc = join(root, 'docs/architecture/CONFIG_KEYS.md');
  const seeds = seededDefaults(readFileSync(join(repo, 'mcp/trajectory-server/src/schema.sql'), 'utf8'));
  const errors = keySetErrors(discoverKeys(repo));
  for (const e of errors) console.error(`  ✗ ${e}`);
  const have = readFileSync(doc, 'utf8');
  const want = renderDoc(have, seeds);
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
