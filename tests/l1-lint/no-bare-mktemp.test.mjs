// L1 lint: every mktemp in tests/ and scripts/ (*.sh) passes an explicit path template. BSD mktemp (macOS) puts a bare `mktemp`, `mktemp -d`, `mktemp -t X` or `mktemp -d -t X` under DARWIN_USER_TEMP_DIR and ignores TMPDIR, which the Bash sandbox does not let a command write; GNU mktemp honours TMPDIR. A template is honoured by both. macOS's TMPDIR ends in a slash, so the parent drops every trailing slash; a raw `${TMPDIR:-/tmp}/` parent yields a `//` that hooks normalise away and path comparisons then miss: D=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-<name>.XXXXXX"). A call is a mktemp in command position (line start, after `$(`, a backtick, or `;` `&` `|` and a space); its first non-flag argument must contain a `/` and `XXX`, and must not start its path at `${TMPDIR...}/`. `-t` and `-p`/`--tmpdir` consume their argument. Comment lines are skipped. Allowlist: tests/l1-lint/no-bare-mktemp.allowlist — <path><TAB><substring of the line><TAB><reason>; an entry with no reason or matching no hit fails. Every run also checks fixtures/no-bare-mktemp/: every `# VIOLATION` line of bad.txt is reported and nothing in good.txt (the fixtures are .txt so neither this scan nor a repo-wide grep of *.sh picks up their deliberate hits).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ALLOWLIST, files, lines, read, scan } from './lib/no-bare-mktemp.mjs';

const FIXTURES = 'tests/l1-lint/fixtures/no-bare-mktemp';

test('fixture bad.txt: every VIOLATION line is reported', () => {
  const bad = scan(null, [`${FIXTURES}/bad.txt`]);
  const expected = lines(read(`${FIXTURES}/bad.txt`)).filter((l) => l.includes('VIOLATION')).length;
  const ok = bad.filter((l) => l.includes('VIOLATION')).length === expected && bad.every((l) => l.includes('VIOLATION'));
  assert.ok(ok, `no-bare-mktemp self-test: expected ${expected} violations in bad.txt, got:\n${bad.join('\n')}`);
});

test('fixture good.txt: no violations', () => {
  const good = scan(null, [`${FIXTURES}/good.txt`]);
  assert.deepEqual(good, [], `no-bare-mktemp self-test: false positives in good.txt:\n${good.join('\n')}`);
});

test('no bare mktemp (explicit path template)', () => {
  const out = scan(ALLOWLIST, files());
  assert.deepEqual(
    out,
    [],
    `No-bare-mktemp: FAIL — mktemp without a slash-stripped path template (BSD mktemp ignores TMPDIR and the sandbox denies its default dir; a raw \${TMPDIR:-/tmp}/ parent doubles macOS's trailing slash).\nUse: D=$(mktemp -d "$(printf %s "\${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-<name>.XXXXXX")\n${out.join('\n')}`,
  );
});
