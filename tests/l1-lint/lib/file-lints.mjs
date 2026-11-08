// The file-scopable L1 lints file-lint.ts runs on one path: each lint's scope and its check of one file, both from the lint's own lib.
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import * as cliConfigScope from './cli-config-scope.mjs';
import * as bareMktemp from './no-bare-mktemp.mjs';
import * as citations from './no-citations-in-prompts.mjs';
import * as cwdReads from './no-cwd-reads.mjs';
import * as developerPaths from './no-developer-paths.mjs';
import * as hardcodedName from './no-hardcoded-plugin-name.mjs';
import * as homeWrites from './no-home-writes.mjs';
import * as negativeDirectives from './no-negative-directives.mjs';
import * as repoPaths from './no-repo-paths-in-prompts.mjs';
import * as secrets from './no-secrets-in-source.mjs';
import * as tmpWrites from './no-tmp-writes.mjs';
import * as wallClock from './no-wall-clock-asserts.mjs';

const own = (rel) => (line) => line.startsWith(`${rel}:`);

export const LINTS = [
  { name: 'no-secrets-in-source', lib: secrets, check: (root, rel, text) => secrets.scanFile(rel, text, secrets.allowEntries(root)) },
  { name: 'no-negative-directives', lib: negativeDirectives, warnOnly: true, check: (root, rel) => negativeDirectives.findings(join(root, rel), rel) },
  { name: 'no-repo-paths-in-prompts', lib: repoPaths, check: (_root, rel, text) => repoPaths.findingsInText(text).map((n) => repoPaths.message(rel, n)) },
  { name: 'no-citations-in-prompts', lib: citations, check: (_root, rel, text) => citations.citationLines(text).map((n) => citations.message(rel, n)) },
  { name: 'no-hardcoded-plugin-name', lib: hardcodedName, check: (_root, rel, text) => hardcodedName.hardcodedInText(text, rel) },
  { name: 'no-developer-paths', lib: developerPaths, check: (root, rel) => developerPaths.matchingLines(join(root, rel)).map((n) => developerPaths.message(rel, n)) },
  { name: 'no-cwd-reads', lib: cwdReads, check: (root, rel) => cwdReads.scanFile(root, rel) },
  { name: 'no-tmp-writes', lib: tmpWrites, check: (root, rel) => tmpWrites.scan([rel], root) },
  { name: 'no-home-writes', lib: homeWrites, check: (root, rel) => homeWrites.scan([rel], root) },
  { name: 'no-wall-clock-asserts', lib: wallClock, check: (root, rel) => wallClock.scan(wallClock.ALLOWLIST, [rel], root).out.filter(own(rel)) },
  { name: 'no-bare-mktemp', lib: bareMktemp, check: (root, rel) => bareMktemp.scan(bareMktemp.ALLOWLIST, [rel], root).filter(own(rel)) },
  { name: 'cli-config-scope', lib: cliConfigScope, check: (root, rel) => cliConfigScope.scan([rel], root) },
];

function isBinary(abs) {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}

function realDir(abs) {
  try {
    return join(realpathSync(dirname(abs)), basename(abs));
  } catch {
    return abs;
  }
}

export function toRel(root, path) {
  const abs = isAbsolute(path) ? path : join(root, path);
  for (const candidate of [abs, realDir(abs)]) {
    const rel = relative(root, candidate);
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return null;
}

export function lintFile(root, path) {
  const rel = toRel(root, path);
  if (rel === null) return { rel: path, skipped: 'outside the repo root', errors: [], warnings: [] };
  const abs = join(root, rel);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { rel, skipped: 'missing', errors: [], warnings: [] };
  }
  if (!stat.isFile()) return { rel, skipped: 'not a regular file', errors: [], warnings: [] };
  if (isBinary(abs)) return { rel, skipped: 'binary', errors: [], warnings: [] };
  const text = readFileSync(abs, 'utf8');
  const errors = [];
  const warnings = [];
  for (const lint of LINTS) {
    if (!lint.lib.scope(root)(rel)) continue;
    const out = lint.check(root, rel, text).map((f) => `${lint.name}: ${f}`);
    (lint.warnOnly ? warnings : errors).push(...out);
  }
  return { rel, skipped: null, errors, warnings };
}
