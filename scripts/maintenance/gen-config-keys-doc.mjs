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

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    setBy: 'bro via `config_set`; Codex `planning_label_taxonomy_set`',
    effect: '`issue_create` requires at least one of these labels; unset or malformed falls back to the generic default.',
  },
  {
    name: 'issue_priority_labels',
    type: 'string[]',
    setBy: 'bro via `config_set`; Codex `planning_label_taxonomy_set`',
    effect: '`issue_create` requires at least one of these labels; unset or malformed falls back to the generic default.',
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
    setBy: '`/onboard` (`onboard_apply`)',
    effect: '`yes` writes the plugin\'s PreToolUse gates into the project\'s `.claude/settings.local.json` so they fire in headless `claude -p` runs; `no` removes them.',
  },
  {
    name: 'sandbox_enforcement',
    type: 'string: `yes` \\| `no`',
    defaultText: 'unset (read as `no`)',
    setBy: '`/onboard` (`onboard_apply`)',
    effect: '`yes` writes Claude Code\'s Bash sandbox block into the project\'s `.claude/settings.local.json`; `no` removes what TMB wrote.',
  },
  {
    name: 'sandbox_settings',
    type: 'object: `{enabled_set, allow_write}`',
    defaultText: 'unset',
    setBy: '`onboard_apply` (never by hand)',
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
    effect: '`swe-verification-gate.sh` gives one run of a task\'s `verification[]` this many seconds of command time on the swe close (the run-record writes are budgeted apart), clamped to 1–1800; 0 or a non-integer falls back to 900 with a stderr warning. `TMB_VERIFICATION_TIMEOUT_S` overrides it (tests).',
  },
  {
    name: 'swe_default_effort',
    type: 'string: `low` \\| `medium` \\| `high`',
    defaultText: 'unset (read as `medium`)',
    setBy: 'bro via `config_set` (any other value is refused)',
    effect: 'The `tasks.effort` a task gets when `task_create_batch` / `task_provision` name none. `require-spawn-effort.sh` denies a swe spawn whose Agent `effort` differs from the task\'s; `swe-atomic-close.sh` copies the task\'s effort onto the swe `agent_runs` row.',
  },
  {
    name: 'reviewer_effort',
    type: 'string: `low` \\| `medium` \\| `high`',
    defaultText: 'unset (read as `high`)',
    setBy: 'bro via `config_set` (any other value is refused)',
    effect: 'The effort every pr-reviewer spawn runs at: `require-spawn-effort.sh` denies a pr-reviewer spawn whose Agent `effort` differs; `swe-atomic-close.sh` records it on the pr-reviewer `agent_runs` row.',
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
    '_Generated by `scripts/maintenance/gen-config-keys-doc.mjs` from the keys the code reads and writes; `tests/l1-lint/config-keys-doc-fresh.sh` fails when it drifts._',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
