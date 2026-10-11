#!/usr/bin/env node
// Generates the artifacts derived from mcp/trajectory-server/src/audit-events.ts
// (read through its compiled dist/audit-events.js):
//   --txt    scripts/hooks/lib/audit-events.txt, one event type per line (run by `npm run build`)
//   --doc    the audit.event_type section of docs/contributing/ENUMS.md, between the generated markers
//   --check  writes nothing; exits 1 naming each artifact that differs from what would be generated
//   --root <dir>  read and write the txt and doc under <dir> instead of this checkout (lint self-tests)
// With neither --txt nor --doc it does both.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const rootAt = argv.indexOf('--root');
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp/trajectory-server/dist/audit-events.js');
const ROOT = rootAt >= 0 ? argv[rootAt + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TXT = join(ROOT, 'scripts/hooks/lib/audit-events.txt');
const DOC = join(ROOT, 'docs/contributing/ENUMS.md');
const BEGIN = '<!-- BEGIN GENERATED audit.event_type: scripts/maintenance/gen-enums-doc.mjs -->';
const END = '<!-- END GENERATED audit.event_type -->';

const { AUDIT_EVENT_TYPES } = await import(pathToFileURL(SOURCE).href);

function renderTxt() {
  return AUDIT_EVENT_TYPES.map((e) => e.type).join('\n') + '\n';
}

function cell(text) {
  return text.replace(/\|/g, '\\|');
}

function renderSection() {
  const rows = AUDIT_EVENT_TYPES.map(
    (e) => `| \`${e.type}\` | ${e.reserved ? 'reserved — ' : ''}${cell(e.description)} |`,
  );
  return [BEGIN, '| Value | Trigger |', '|---|---|', ...rows, END].join('\n');
}

function renderDoc(current) {
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) {
    throw new Error(`${relative(ROOT, DOC)}: generated markers missing (${BEGIN} … ${END})`);
  }
  return current.slice(0, start) + renderSection() + current.slice(end + END.length);
}

const args = new Set(argv);
const check = args.has('--check');
const doTxt = check || args.has('--txt') || (!args.has('--doc'));
const doDoc = check || args.has('--doc') || (!args.has('--txt'));

const stale = [];
if (doTxt) {
  const want = renderTxt();
  let have = '';
  try { have = readFileSync(TXT, 'utf8'); } catch { have = ''; }
  if (have !== want) {
    if (check) stale.push(relative(ROOT, TXT));
    else writeFileSync(TXT, want);
  }
}
if (doDoc) {
  const have = readFileSync(DOC, 'utf8');
  const want = renderDoc(have);
  if (have !== want) {
    if (check) stale.push(relative(ROOT, DOC));
    else writeFileSync(DOC, want);
  }
}

if (stale.length > 0) {
  for (const f of stale) console.error(`  ✗ ${f} differs from what audit-events.ts generates`);
  process.exit(1);
}
