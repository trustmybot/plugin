/**
 * stripLiterals against tmb_cmd_strip_literals in its plain mode (GH 1692):
 * the same bytes for each command as the frozen answers of the shell lib,
 * recorded once per command and locale (C and en_US.UTF-8) into
 * tests/fixtures/cmd-analysis/strip-literals.jsonl.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripLiterals } from '../hooks/cmd-analysis/index.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis/strip-literals.jsonl');
const NON_ASCII = 'echo "é"';

const COMMANDS: readonly string[] = [
  '',
  'git status',
  'cd /r && git switch feat/x && git merge --ff-only @{u}',
  "git commit -m 'a; b | c && d'",
  'echo "x > y" < in',
  "echo $'it\\'s a\\ttab; ok'",
  'echo "$(git rev-parse HEAD) and `date`"',
  'echo "$(printf "(x)" | tr x y)"',
  'echo "a\\"b" \\; c',
  'ls # git push --force',
  'echo a#b # trailing',
  '#!/bin/sh\ngit status',
  "cat <<EOF\ngit push --force origin main\nEOF\ngit status",
  "cat <<-'EOF'\n\tgit commit -m x\n\tEOF\necho done",
  'cat <<"A" <<B\nbody a\nA\nbody b\nB\nnext',
  'tr a b <<< "git push"',
  "echo 'open\nstill open' && git status",
  'echo "multi\nline" ; ls',
  'git switch\tfeat/x  &&   git merge --ff-only @{u}',
  'echo "ü — ß"; git log',
  'trailing newline\n',
  'cat << EOF\nunterminated body',
  'x=$(cat <<EOF\ninner\nEOF\n)',
];

interface FrozenLine {
  cmd: string;
  locale: string;
  out: string;
}

const key = (command: string, locale: string): string => JSON.stringify([command, locale]);
const lines = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as FrozenLine);
const frozen = new Map(lines.map((l) => [key(l.cmd, l.locale), l.out]));
const ascii = COMMANDS.filter((c) => !/[^\x00-\x7f]/.test(c));

function shell(command: string, locale: string): string {
  const out = frozen.get(key(command, locale));
  assert.ok(out !== undefined, `no fixture line for ${key(command, locale)}`);
  return out;
}

describe('stripLiterals matches tmb_cmd_strip_literals', () => {
  it('strip-literals.jsonl holds one line per command and locale', () => {
    const want = [...COMMANDS.map((c) => key(c, 'C')), ...ascii.map((c) => key(c, 'en_US.UTF-8'))];
    if (!COMMANDS.includes(NON_ASCII)) want.push(key(NON_ASCII, 'C'));
    assert.equal(frozen.size, lines.length, 'two fixture lines share a key');
    assert.deepEqual([...frozen.keys()].sort(), want.sort());
  });

  it("prints the shell lib's frozen bytes for every command (LC_ALL=C)", () => {
    for (const command of COMMANDS) assert.equal(stripLiterals(command), shell(command, 'C'), JSON.stringify(command));
  });

  it("prints the shell lib's frozen bytes for every ASCII command (LC_ALL=en_US.UTF-8)", () => {
    for (const command of ascii) {
      assert.equal(stripLiterals(command), shell(command, 'en_US.UTF-8'), JSON.stringify(command));
    }
  });

  it('reads a non-ASCII command as the shell lib did in C, in every locale (BSD awk fails on it under UTF-8)', () => {
    assert.equal(stripLiterals(NON_ASCII), shell(NON_ASCII, 'C'));
  });
});
