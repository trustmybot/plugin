// L1 lint: tests assert behaviour, not wall-clock budgets (GH 1645, GH 1677). An elapsed-time bound flakes on a loaded runner; assert the timeout path fired instead (its exit code, message or marker file). Shell (*.sh): a `$SECONDS` or `date +%s` difference against a variable (an elapsed time, not an epoch shifted by a literal), inline or through a variable assigned from it, compared with -lt/-le/-gt/-ge or inside (( )). TS/JS: a `Date.now() - x` or `performance.now() - x` result, inline or through a variable assigned from it, compared to a numeric literal with < <= > >= or expect(...).toBeLessThan/…OrEqual/toBeGreaterThan/…OrEqual(<number>). Comment lines are skipped. Scans *.sh, *.ts, *.tsx, *.js and *.mjs under tests/, dashboard/test/ and mcp/trajectory-server/src/test/ (node_modules excepted). Allowlist: tests/l1-lint/no-wall-clock-asserts.allowlist, <path><TAB><substring of the line><TAB><reason>; an entry with no reason or matching no hit fails. The planted cases scan fixtures/no-wall-clock-asserts/: every `VIOLATION` line of bad.sh.txt and bad.ts.txt must be reported and nothing in good.sh.txt or good.ts.txt. The fixtures are .txt so the repo scan never picks them up; the language is the extension before .txt.
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST = 'tests/l1-lint/no-wall-clock-asserts.allowlist';
const FIXTURES = 'tests/l1-lint/fixtures/no-wall-clock-asserts';
const DIRS = ['tests', 'dashboard/test', 'mcp/trajectory-server/src/test'];
const EXTS = ['.sh', '.ts', '.tsx', '.js', '.mjs'];

const VAR = String.raw`[A-Za-z_]\w*`;
const NUM = String.raw`\d[\d_]*(?:\.\d+)?`;
const SH_DIFF = String.raw`(?:\bSECONDS|date\s+\+%s\)?)\s*-\s*\$?\{?${VAR}`;
const TS_DIFF = String.raw`(?:Date\.now|performance\.now)\(\)\s*-\s*[A-Za-z_$][\w.$]*`;
const TS_CMP = String.raw`(?:<=?|>=?)\s*${NUM}\b`;
const TS_RCMP = String.raw`\b${NUM}\s*(?:<=?|>=?)`;
const TS_MATCHER = String.raw`\.to(?:BeLessThan|BeLessThanOrEqual|BeGreaterThan|BeGreaterThanOrEqual)\(\s*${NUM}\s*\)`;

const COMMENT = /^\s*(?:#|\/\/|\*|\/\*)/;
const SH_FILE = /\.sh(?:\.txt)?$/;
const SH_ASSIGN = new RegExp(String.raw`^\s*(?:local\s+|export\s+|readonly\s+)?(${VAR})=.*${SH_DIFF}`);
const SH_DIFF_RE = new RegExp(SH_DIFF);
const SH_TEST_CMP = /\s-(?:lt|le|gt|ge)\s/;
const SH_ARITH_CMP = /\(\(.*[<>]/;
const TS_ASSIGN = new RegExp(String.raw`\b(?:const|let|var)\s+(${VAR})\s*(?::\s*\w+\s*)?=\s*${TS_DIFF}`);
const TS_INLINE = [
  new RegExp(String.raw`${TS_DIFF}\s*\)?\s*${TS_CMP}`),
  new RegExp(String.raw`${TS_RCMP}\s*\(?\s*${TS_DIFF}`),
  new RegExp(String.raw`expect\(\s*\(?\s*${TS_DIFF}\s*\)?\s*\)${TS_MATCHER}`),
];

function shVarHits(v) {
  return [new RegExp(String.raw`\$\{?${v}\b`), new RegExp(String.raw`\(\(.*\b${v}\b\s*[<>]`)];
}

function tsVarHits(v) {
  return [
    new RegExp(String.raw`(?<![\w.$])${v}\s*${TS_CMP}`),
    new RegExp(String.raw`${TS_RCMP}\s*${v}\b`),
    new RegExp(String.raw`expect\(\s*${v}\s*\)${TS_MATCHER}`),
  ];
}

function readLines(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function loadAllowlist(allowlist, out) {
  const allow = [];
  let lines;
  try {
    lines = readLines(allowlist.startsWith('/') ? allowlist : join(ROOT, allowlist));
  } catch {
    return { allow, bad: false };
  }
  let bad = false;
  lines.forEach((line, i) => {
    if (/^\s*(?:#|$)/.test(line)) return;
    const t1 = line.indexOf('\t');
    const t2 = t1 < 0 ? -1 : line.indexOf('\t', t1 + 1);
    const reason = t2 < 0 ? '' : line.slice(t2 + 1);
    if (t2 < 0 || !/\S/.test(reason)) {
      out.push(`ALLOWLIST ${allowlist}:${i + 1}: needs <path><TAB><substring><TAB><reason>`);
      bad = true;
      return;
    }
    allow.push({ path: line.slice(0, t1), sub: line.slice(t1 + 1, t2), used: false });
  });
  return { allow, bad };
}

function isHit(line, sh, elapsed) {
  if (sh) {
    if (!SH_TEST_CMP.test(line) && !SH_ARITH_CMP.test(line)) return false;
    if (SH_DIFF_RE.test(line)) return true;
    return [...elapsed].some((v) => shVarHits(v).some((re) => re.test(line)));
  }
  if (TS_INLINE.some((re) => re.test(line))) return true;
  return [...elapsed].some((v) => tsVarHits(v).some((re) => re.test(line)));
}

export function scan(allowlist, files) {
  const out = [];
  const { allow, bad: allowBad } = loadAllowlist(allowlist, out);
  let bad = allowBad;
  for (const file of files) {
    const sh = SH_FILE.test(file);
    const elapsed = new Set();
    let lines;
    try {
      lines = readLines(join(ROOT, file));
    } catch {
      continue;
    }
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      const assigned = (sh ? SH_ASSIGN : TS_ASSIGN).exec(line);
      if (assigned) elapsed.add(assigned[1]);
      if (!isHit(line, sh, elapsed)) return;
      const ok = allow.find((a) => a.path === file && line.includes(a.sub));
      if (ok) {
        ok.used = true;
        return;
      }
      out.push(`${file}:${i + 1}: ${line.replace(/^\s+/, '')}`);
      bad = true;
    });
  }
  for (const a of allow.filter((x) => !x.used)) {
    out.push(`ALLOWLIST ${allowlist}: stale entry (no hit): ${a.path}\t${a.sub}`);
    bad = true;
  }
  return { ok: !bad, out };
}

function walk(dir, out) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(rel, out);
    } else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) {
      out.push(rel);
    }
  }
}

export function testFiles() {
  const out = [];
  for (const d of DIRS) {
    let dir = false;
    try {
      dir = statSync(join(ROOT, d)).isDirectory();
    } catch {}
    if (dir) walk(d, out);
  }
  return out.sort();
}

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
