// L1 lint: every config-changing `claude plugin` / `claude mcp` call runs at project scope. The CLI's defaults reach user scope (`plugin uninstall` defaults to user, `mcp add` to local — stored in ~/.claude.json — and `mcp remove` acts on whichever scope holds the name), so TMB pins the scope instead of relying on them. Config-changing subcommands, aliases included, from the help of Claude Code 2.1.303: with `-s, --scope` plugin install|i, uninstall|remove, enable, disable, update, prune|autoremove; mcp add, add-json, add-from-claude-desktop, remove. With `--scope` only: plugin marketplace add, remove|rm. No scope option: plugin configure, init|new; plugin marketplace update; mcp login, logout, reset-project-choices. A call passes only when its last scope flag (`--scope X`, `--scope=X`, and `-s X` / `-sX` where the subcommand takes `-s`) before any `--` is the literal `project`; a subcommand with no scope option is flagged outright. Read-only ones (list, get, details, validate, ...) pass; `plugins` is the CLI's alias for `plugin`. The program is `claude`, any path ending in `/claude`, or a variable (`$X`, `${X}`, quoted or not) whose name contains "claude" (any case) or that the file assigns a value naming `claude`, matched anywhere on a line. Global options may sit between the program and `plugin` / `mcp`. The call runs to the end of its command (`;`, `&&`, `||`, `|`, `&`, an unmatched `)` or backtick, the string it sits in, or an unescaped newline). TS/JS argv arrays (`['plugin', 'install', x]`, global options and a program element allowed before the group) are checked the same way. A non-literal subcommand fails closed: flagged unless the call is pinned to project scope. Comments are stripped only outside quotes: `//` and `/* */`. Scans every git-tracked *.mjs, *.js and *.ts outside any tests/ or test/, dist/ and node_modules/ directory. Exempt: the Human-run repair tools on tests/l1-lint/no-home-writes.allowlist, and a call shown to the Human rather than run, marked with a `# cli-config-scope: printed` (or `//`) comment on its line; on a heredoc's opening line the comment covers the whole body. Every run also checks fixtures/cli-config-scope/: every line marked VIOLATION in a bad fixture is flagged, nothing else is, and the good fixtures produce no findings.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { files as trackedSources, ROOT, scan } from './lib/cli-config-scope.mjs';

const FIXTURES = 'tests/l1-lint/fixtures/cli-config-scope';

const fixtures = existsSync(join(ROOT, FIXTURES)) ? readdirSync(join(ROOT, FIXTURES)).sort() : [];

for (const name of fixtures.filter((f) => f.startsWith('bad.'))) {
  test(`fixture ${name}: exactly the VIOLATION lines are flagged`, () => {
    const rel = `${FIXTURES}/${name}`;
    const expected = readFileSync(join(ROOT, rel), 'utf8')
      .split('\n')
      .flatMap((l, i) => (l.includes('VIOLATION') ? [i + 1] : []))
      .join(' ');
    const got = scan([rel])
      .map((l) => Number(/^[^:]+:(\d+):/.exec(l)[1]))
      .sort((a, b) => a - b)
      .join(' ');
    assert.ok(got !== '' && got === expected, `cli-config-scope self-test: ${name} — expected lines [${expected}], flagged [${got}]`);
  });
}

for (const name of fixtures.filter((f) => f.startsWith('good.'))) {
  test(`fixture ${name}: no findings`, () => {
    const out = scan([`${FIXTURES}/${name}`]);
    assert.deepEqual(out, [], `cli-config-scope self-test: false positives in ${name}:\n${out.join('\n')}`);
  });
}

test('claude CLI config calls pinned to project scope', () => {
  let files;
  try {
    files = trackedSources();
  } catch {
    assert.fail('Cli-config-scope: FAIL — git ls-files failed; run from a git checkout');
  }
  const out = scan(files);
  assert.deepEqual(
    out,
    [],
    `Cli-config-scope: FAIL — config-changing claude plugin/mcp calls not pinned to project scope (the CLI default can reach user scope):\n${out.join('\n')}`,
  );
});
