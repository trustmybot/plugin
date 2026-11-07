// L1 lint: no `| grep -q` in a shell script that sets pipefail (grep -q closes the pipe on the first match, the upstream can die of SIGPIPE and the pipeline fails although the pattern was present; write `cmd | grep PAT >/dev/null`). Scans every *.sh under tests/, scripts/ and hooks/ (fixtures/ dirs excepted) whose `set` line turns on pipefail, every */lib/*.sh under scripts/ and tests/ unconditionally (sourced libraries inherit pipefail), and each raw line of tests/l5-l6/l6-chain/chain-manifest.json (its strings are eval'd under pipefail). A hit is a non-comment logical line (a line ending in `|` joins the next) where a pipe feeds grep/egrep/fgrep/rg whose options include a cluster containing q, --quiet or --silent. Every run also checks fixtures/no-grep-q-in-pipelines/.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'no-grep-q-in-pipelines');
const MANIFESTS = ['tests/l5-l6/l6-chain/chain-manifest.json'];
const PIPEFAIL = /^\s*set\s+[^#]*-[A-Za-z]*o\s+pipefail\b/;
const OPT = String.raw`(?:-[A-Za-z]*e\s+(?:'[^']*'|"[^"]*"|\\"(?:[^"\\]|\\.)*?\\"|\S+)|--[A-Za-z][\w-]*(?:=\S+)?|-[A-Za-z]+)`;
const QUIET = String.raw`(?:-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)(?![\w-])`;
const HIT = new RegExp(String.raw`(?:^|[^|])\|\s*(?:grep|egrep|fgrep|rg)(?:\s+${OPT})*?\s+${QUIET}`);
const TRAILING = /(?:^|[^|])\|\s*$/;

export function scan(base, files) {
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const rel = file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
    const manifest = rel.endsWith('.json');
    const sourced = /^(?:scripts|tests)\/(?:.+\/)?lib\/[^/]+\.sh$/.test(rel);
    if (!manifest && !sourced && !lines.some((l) => PIPEFAIL.test(l))) continue;
    let i = 0;
    while (i < lines.length) {
      const start = i;
      let line = lines[i];
      if (/^\s*#/.test(line)) {
        i++;
        continue;
      }
      while (TRAILING.test(line) && i < lines.length - 1) {
        i++;
        line += ` ${lines[i]}`;
      }
      i++;
      if (HIT.test(line)) out.push(`${rel}:${start + 1}: ${line.replace(/^\s+/, '')}`);
    }
  }
  return out;
}

function shellFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'fixtures') continue;
    const child = join(dir, entry.name);
    if (entry.isDirectory()) shellFiles(child, out);
    else if (entry.isFile() && entry.name.endsWith('.sh')) out.push(child);
  }
}

const CAUGHT = [
  'offending.sh',
  'offending-long-option.sh',
  'offending-e-pattern.sh',
  'offending-trailing-pipe.sh',
  'scripts/hooks/lib/sourced-lib.sh',
  'scripts/maintenance/lib/sourced-lib.sh',
  'manifest-offending.json',
];
const ALLOWED = ['clean.sh', 'no-pipefail.sh', 'manifest-clean.json'];

for (const f of CAUGHT) {
  test(`fixture ${f} is caught`, () => {
    assert.notDeepEqual(scan(FIXTURES, [join(FIXTURES, f)]), [], `no-grep-q-in-pipelines self-test: FAIL (${f} not caught)`);
  });
}

for (const f of ALLOWED) {
  test(`fixture ${f} is allowed`, () => {
    const out = scan(FIXTURES, [join(FIXTURES, f)]);
    assert.deepEqual(out, [], `no-grep-q-in-pipelines self-test: FAIL (${f} flagged)\n${out.join('\n')}`);
  });
}

test('no grep -q in pipelines under pipefail', () => {
  const files = [];
  for (const dir of ['tests', 'scripts', 'hooks']) {
    if (existsSync(join(ROOT, dir))) shellFiles(join(ROOT, dir), files);
  }
  for (const m of MANIFESTS) if (existsSync(join(ROOT, m))) files.push(join(ROOT, m));
  const out = scan(ROOT, files.sort());
  assert.deepEqual(out, [], `${out.join('\n')}\nno-grep-q-in-pipelines: FAIL — pipe into 'grep PAT >/dev/null' instead of 'grep -q' under pipefail`);
});
