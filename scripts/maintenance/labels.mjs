#!/usr/bin/env node
// Keeps the GitHub issue labels of this repo in line with .github/labels.json (GH 1770).
//   --sync            create or update labels on GH to match; extras are printed, never deleted
//   --doc             rewrite the canonical tables in docs/contributing/LABELS.md between the generated markers
//   --check           offline; exits 1 when LABELS.md differs from what --doc would write
//   --check-live      exits 1 when GH labels differ from labels.json; skips without gh or with TMB_L1_OFFLINE=1
//   --triage <issue>  add the issue-form Area answer when the issue has no area, then toggle needs-triage
//   --root <dir>      read labels.json and LABELS.md under <dir> instead of this checkout
//   --repo <owner/name>  the GH repo for --sync, --check-live and --triage (default: gh's current repo)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GROUPS = ['type', 'priority', 'area', 'theme', 'status'];
export const REQUIRED_GROUPS = ['type', 'priority', 'area'];
export const NEEDS_TRIAGE = 'needs-triage';
export const AREA_PREFIX = 'Area: ';
export const BEGIN = '<!-- BEGIN GENERATED labels: scripts/maintenance/labels.mjs -->';
export const END = '<!-- END GENERATED labels -->';

const GROUP_TITLES = {
  type: 'Type — exactly one',
  priority: 'Priority — exactly one',
  area: 'Area — exactly one',
  theme: 'Theme — optional',
  status: 'Status — set by the triage workflow',
};

export function loadCatalog(root) {
  const catalog = JSON.parse(readFileSync(join(root, '.github/labels.json'), 'utf8'));
  const seen = new Set();
  for (const label of catalog) {
    if (!label.name || !/^[0-9a-f]{6}$/i.test(label.color ?? '') || typeof label.description !== 'string' || !GROUPS.includes(label.group)) {
      throw new Error(`.github/labels.json: malformed entry ${JSON.stringify(label)}`);
    }
    if (seen.has(label.name)) throw new Error(`.github/labels.json: duplicate label ${label.name}`);
    seen.add(label.name);
  }
  return catalog;
}

export function formArea(body) {
  const match = /^###\s+Area\s*$\s*^(?!###)(.+?)\s*$/m.exec(body ?? '');
  if (!match) return null;
  const answer = match[1].trim();
  return answer === '' || answer === '_No response_' ? null : answer;
}

export function triage({ labels, body, catalog }) {
  const groupOf = new Map(catalog.map((l) => [l.name, l.group]));
  const current = new Set(labels);
  const add = [];
  const remove = [];
  const count = (group) => [...current].filter((n) => groupOf.get(n) === group).length;

  if (count('area') === 0) {
    const answer = formArea(body);
    const name = answer && `${AREA_PREFIX}${answer}`;
    if (name && groupOf.get(name) === 'area') {
      add.push(name);
      current.add(name);
    }
  }

  const complete = REQUIRED_GROUPS.every((g) => count(g) === 1);
  if (complete && current.has(NEEDS_TRIAGE)) remove.push(NEEDS_TRIAGE);
  if (!complete && !current.has(NEEDS_TRIAGE)) add.push(NEEDS_TRIAGE);
  return { add, remove };
}

function cell(text) {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

export function renderSection(catalog) {
  const lines = [BEGIN];
  for (const group of GROUPS) {
    const rows = catalog.filter((l) => l.group === group);
    if (rows.length === 0) continue;
    lines.push('', `### ${GROUP_TITLES[group]}`, '', '| Label | Means |', '|---|---|');
    for (const l of rows) lines.push(`| **${cell(l.name)}** | ${cell(l.description)} |`);
  }
  lines.push('', END);
  return lines.join('\n');
}

export function renderDoc(current, catalog) {
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) throw new Error(`LABELS.md: generated markers missing (${BEGIN} … ${END})`);
  return current.slice(0, start) + renderSection(catalog) + current.slice(end + END.length);
}

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function gh(args, repo) {
  const full = repo ? [...args, '--repo', repo] : args;
  return execFileSync('gh', full, { cwd: CHECKOUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function liveLabels(repo) {
  return JSON.parse(gh(['label', 'list', '--limit', '500', '--json', 'name,color,description'], repo));
}

function sameLabel(a, b) {
  return a.color.toLowerCase() === b.color.toLowerCase() && (a.description ?? '') === (b.description ?? '');
}

function sync(catalog, repo) {
  const live = new Map(liveLabels(repo).map((l) => [l.name, l]));
  for (const want of catalog) {
    const have = live.get(want.name);
    if (have && sameLabel(have, want)) continue;
    const verb = have ? 'edit' : 'create';
    gh(['label', verb, want.name, '--color', want.color, '--description', want.description], repo);
    console.log(`  ${verb === 'edit' ? '~ updated' : '+ created'} ${want.name}`);
  }
  const names = new Set(catalog.map((l) => l.name));
  for (const name of live.keys()) {
    if (!names.has(name)) console.log(`  ! extra on GH, not in labels.json (left in place): ${name}`);
  }
}

function ghAvailable() {
  try {
    execFileSync('gh', ['api', 'user', '--jq', '.login'], { cwd: CHECKOUT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkLive(catalog, repo) {
  if (process.env.TMB_L1_OFFLINE === '1') return console.log('  ⊘ skip: TMB_L1_OFFLINE=1'), 0;
  if (!ghAvailable()) return console.log('  ⊘ skip: gh CLI not installed, not authenticated or no network'), 0;
  const live = new Map(liveLabels(repo).map((l) => [l.name, l]));
  const problems = [];
  for (const want of catalog) {
    const have = live.get(want.name);
    if (!have) problems.push(`missing on GH: ${want.name}`);
    else if (!sameLabel(have, want)) problems.push(`differs on GH: ${want.name}`);
  }
  const names = new Set(catalog.map((l) => l.name));
  for (const name of live.keys()) if (!names.has(name)) problems.push(`extra on GH, not in labels.json: ${name}`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (problems.length > 0) {
    console.error('  Run `node scripts/maintenance/labels.mjs --sync`, or edit .github/labels.json.');
    return 1;
  }
  console.log(`  ✓ ${catalog.length} GH labels match .github/labels.json`);
  return 0;
}

function triageIssue(catalog, issue, repo) {
  const data = JSON.parse(gh(['issue', 'view', String(issue), '--json', 'labels,body'], repo));
  const { add, remove } = triage({ labels: data.labels.map((l) => l.name), body: data.body, catalog });
  if (add.length === 0 && remove.length === 0) return console.log(`  ✓ #${issue} needs no label change`);
  const args = ['issue', 'edit', String(issue)];
  for (const name of add) args.push('--add-label', name);
  for (const name of remove) args.push('--remove-label', name);
  gh(args, repo);
  console.log(`  #${issue}: added [${add.join(', ')}] removed [${remove.join(', ')}]`);
}

function main(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const root = value('--root') ?? CHECKOUT;
  const repo = value('--repo');
  const doc = join(root, 'docs/contributing/LABELS.md');
  const catalog = loadCatalog(root);

  if (argv.includes('--doc')) {
    const have = readFileSync(doc, 'utf8');
    const want = renderDoc(have, catalog);
    if (have !== want) writeFileSync(doc, want);
    return 0;
  }
  if (argv.includes('--check')) {
    if (readFileSync(doc, 'utf8') !== renderDoc(readFileSync(doc, 'utf8'), catalog)) {
      console.error(`  ✗ ${relative(root, doc)} differs from .github/labels.json; run node scripts/maintenance/labels.mjs --doc`);
      return 1;
    }
    return 0;
  }
  if (argv.includes('--check-live')) return checkLive(catalog, repo);
  if (argv.includes('--sync')) return sync(catalog, repo), 0;
  if (argv.includes('--triage')) {
    const issue = value('--triage');
    if (!/^\d+$/.test(issue ?? '')) throw new Error('--triage needs an issue number');
    return triageIssue(catalog, issue, repo), 0;
  }
  console.error('usage: labels.mjs --sync | --doc | --check | --check-live | --triage <issue> [--root <dir>] [--repo <owner/name>]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
