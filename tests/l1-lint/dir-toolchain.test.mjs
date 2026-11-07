// L1 lint: shell scripts in a guarded directory use only the interpreters on that directory's allowlist (the B13 incident: a Python3 script landed in tests/benchmarks/ without a contract update). Each top-level *.sh is checked on its shebang interpreter and on every python/python3/node/ruby/perl/php/Rscript word in its lines (heredoc or inline sub-interpreters). Allowlist: tests/benchmarks → bash, python3, node.
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST_MAP = { 'tests/benchmarks': ['bash', 'python3', 'node'] };
const INLINE_INTERP = /\b(python3?|node|ruby|perl|php|Rscript)\b/;

function shebangInterp(first) {
  if (!first.startsWith('#!')) return '';
  const word = first.replace(/^#!\s*\/?(usr\/bin\/env\s+)?/, '').trim().split(/\s+/)[0];
  return word ? basename(word) : '';
}

export function toolchainProblems(root, map) {
  const out = [];
  for (const [dirRel, allowed] of Object.entries(map)) {
    const dir = join(root, dirRel);
    if (!existsSync(dir)) continue;
    const list = allowed.join(',');
    const scripts = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.endsWith('.sh'))
      .map((e) => e.name)
      .sort();
    for (const name of scripts) {
      const rel = `${dirRel}/${name}`;
      const lines = readFileSync(join(dir, name), 'utf8').split('\n');
      const interp = shebangInterp(lines[0] ?? '');
      if (interp && !allowed.includes(interp)) {
        out.push(`FAIL ${rel}: shebang interpreter '${interp}' not in allowlist [${list}] for ${dirRel}/`);
      }
      for (const line of lines) {
        const m = INLINE_INTERP.exec(line);
        if (m && !allowed.includes(m[1])) {
          out.push(`FAIL ${rel}: heredoc/inline interpreter '${m[1]}' not in allowlist [${list}] for ${dirRel}/`);
        }
      }
    }
  }
  return out;
}

test('an off-allowlist shebang and inline interpreter are caught; allowed ones pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-dir-toolchain-'));
  try {
    mkdirSync(join(dir, 'bench'));
    writeFileSync(join(dir, 'bench', 'ok.sh'), '#!/usr/bin/env bash\npython3 - <<PY\nPY\nnode x.mjs\n');
    writeFileSync(join(dir, 'bench', 'bad.sh'), '#!/usr/bin/ruby -w\nperl -e 1\n');
    assert.deepEqual(toolchainProblems(dir, { bench: ['bash', 'python3', 'node'] }), [
      "FAIL bench/bad.sh: shebang interpreter 'ruby' not in allowlist [bash,python3,node] for bench/",
      "FAIL bench/bad.sh: heredoc/inline interpreter 'ruby' not in allowlist [bash,python3,node] for bench/",
      "FAIL bench/bad.sh: heredoc/inline interpreter 'perl' not in allowlist [bash,python3,node] for bench/",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guarded directories use only allowlisted interpreters', () => {
  const out = toolchainProblems(ROOT, ALLOWLIST_MAP);
  assert.deepEqual(
    out,
    [],
    `${out.join('\n')}\n\ndir-toolchain: FAIL — one or more scripts use interpreters outside the allowlist.\n  Fix: either restrict the script to the allowed interpreter(s), or update\n  the allowlist in tests/l1-lint/dir-toolchain.test.mjs if the constraint has changed.`,
  );
});
