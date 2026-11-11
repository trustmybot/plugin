// L1 lint: tests assert behaviour, not wall-clock budgets (GH 1645, GH 1677). An elapsed-time bound flakes on a loaded runner; assert the timeout path fired instead (its exit code, message or marker file). Shell (*.sh): a `$SECONDS` or `date +%s` difference against a variable (an elapsed time, not an epoch shifted by a literal), inline or through a variable assigned from it, compared with -lt/-le/-gt/-ge or inside (( )). TS/JS: a `Date.now() - x` or `performance.now() - x` result, inline or through a variable assigned from it, compared to a numeric literal with < <= > >= or expect(...).toBeLessThan/…OrEqual/toBeGreaterThan/…OrEqual(<number>). Comment lines are skipped. Scans *.sh, *.ts, *.tsx, *.js and *.mjs under tests/, dashboard/test/ and mcp/trajectory-server/src/test/ (node_modules excepted). Allowlist: tests/l1-lint/no-wall-clock-asserts.allowlist, <path><TAB><substring of the line><TAB><reason>; an entry with no reason or matching no hit fails. The planted cases scan fixtures/no-wall-clock-asserts/: every `VIOLATION` line of bad.sh.txt and bad.ts.txt must be reported and nothing in good.sh.txt or good.ts.txt. The fixtures are .txt so the repo scan never picks them up; the language is the extension before .txt.
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ALLOWLIST, readLines, ROOT, scan, testFiles } from './lib/no-wall-clock-asserts.mjs';

const FIXTURES = 'tests/l1-lint/fixtures/no-wall-clock-asserts';

test('no wall-clock asserts in tests', () => {
  const files = testFiles();
  const r = scan(ALLOWLIST, files);
  assert.ok(
    r.ok,
    `No-wall-clock-asserts: FAIL — a test compares elapsed wall-clock time, which flakes under load.\nAssert the behaviour instead (the timeout fired: exit code, message or marker), or allowlist the line with a reason.\n${r.out.join('\n')}`,
  );
});

describe('planted fixtures and allowlists', () => {
  for (const lang of ['sh', 'ts']) {
    test(`planted bad.${lang}.txt: every VIOLATION line is reported, nothing else`, () => {
      const file = `${FIXTURES}/bad.${lang}.txt`;
      const expected = readLines(join(ROOT, file)).filter((l) => l.includes('VIOLATION')).length;
      const r = scan('/dev/null', [file]);
      const msg = `no-wall-clock-asserts self-test: expected ${expected} violations in bad.${lang}.txt, got:\n${r.out.join('\n')}`;
      assert.equal(r.out.filter((l) => l.includes('VIOLATION')).length, expected, msg);
      assert.ok(r.out.length > 0 && r.out.every((l) => l.includes('VIOLATION')), msg);
    });

    test(`planted good.${lang}.txt: no false positives`, () => {
      const r = scan('/dev/null', [`${FIXTURES}/good.${lang}.txt`]);
      assert.ok(r.ok, `no-wall-clock-asserts self-test: false positives in good.${lang}.txt:\n${r.out.join('\n')}`);
    });
  }

  let tmp;
  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-no-wall-clock-asserts.'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function allowlist(name, text) {
    const path = join(tmp, name);
    writeFileSync(path, `# header\n\n${text}\n`);
    return path;
  }

  const bad = `${FIXTURES}/bad.ts.txt`;

  test('planted allowlist entry exempts its line', () => {
    const r = scan(allowlist('one.allowlist', `${bad}\texpect(elapsed).toBeLessThan(2_000)\tbenchmark`), [bad]);
    assert.ok(!r.out.some((l) => l.includes('toBeLessThan(2_000)')), r.out.join('\n'));
    assert.equal(r.out.length, 7, r.out.join('\n'));
  });

  test('planted allowlist entry with no reason fails', () => {
    const r = scan(allowlist('noreason.allowlist', `${bad}\tassert.ok(elapsed < 5000)\t `), []);
    assert.equal(r.ok, false);
    assert.ok(r.out.some((l) => l.endsWith('noreason.allowlist:3: needs <path><TAB><substring><TAB><reason>')), r.out.join('\n'));
  });

  test('planted stale allowlist entry fails', () => {
    const r = scan(allowlist('stale.allowlist', `${bad}\tno such line\treason`), []);
    assert.equal(r.ok, false);
    assert.ok(r.out.some((l) => l.endsWith(`stale entry (no hit): ${bad}\tno such line`)), r.out.join('\n'));
  });
});
