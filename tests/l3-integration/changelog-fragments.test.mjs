// L3: changelog.d/ fragments (GH 1277, GH 1692): tests/l1-lint/changelog-current.sh
// on a feature branch, scripts/maintenance/lib/changelog-fragments.ts on its own,
// and scripts/maintenance/bump-version.ts assembling the fragments into a
// release section, byte-identically for the same inputs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LINT = join(ROOT, 'tests/l1-lint/changelog-current.sh');
const LIB = join(ROOT, 'scripts/maintenance/lib/changelog-fragments.ts');
const BUMP = join(ROOT, 'scripts/maintenance/bump-version.ts');
const FIXTURE = join(ROOT, 'tests/l3-integration/hooks/fixtures/changelog-fragments');
const TMP = mkdtempSync(join(tmpdir(), 'tmb-changelog-fragments-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const CUTOVER_DAY = '2026-10-12';
const AFTER_CUTOVER = '2026-10-13';
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.io',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.io',
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function edit(path, from, to) {
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(from), `${path} lacks ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

/** A repo with origin/dev at an initial commit and a feature branch checked out. */
function newRepo(name) {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'dev');
  write(join(dir, '.claude-plugin/plugin.json'), '{"version": "1.0.0"}\n');
  write(
    join(dir, 'CHANGELOG.md'),
    '# Changelog\n\n## Unreleased\n\n### Fixed\n- **Old** (GH 100): old.\n\n## v1.0.0 — 2026-01-01\n\n### Added\n- **First** (GH 1): hi.\n',
  );
  write(join(dir, 'changelog.d/README.md'), 'readme\n');
  write(join(dir, 'src.txt'), 'src\n');
  commitAll(dir, 'init');
  git(dir, 'update-ref', 'refs/remotes/origin/dev', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feat/work');
  return dir;
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
}

function touchSource(dir) {
  writeFileSync(join(dir, 'src.txt'), 'src\nchange\n');
}

function lint(dir, today) {
  const r = spawnSync('bash', [LINT, '--root', dir], { env: { ...GIT_ENV, TMB_CHANGELOG_TODAY: today }, encoding: 'utf8' });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

function fragments(cwd, ...args) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', LIB, ...args], { cwd, encoding: 'utf8' });
}

// --- changelog-current.sh ----------------------------------------------------

test('a fragment for the cited issue passes, after the cut-over too', () => {
  const r = newRepo('frag-ok');
  touchSource(r);
  write(join(r, 'changelog.d/2001-thing-works.md'), '### Fixed\n- **Thing works** (GH 2001): it does.\n');
  commitAll(r, '🐛 fix: thing works (GH 2001)');
  assert.equal(lint(r, AFTER_CUTOVER).code, 0, 'fragment → PASS');
});

test('a cited issue with neither a fragment nor a CHANGELOG entry fails', () => {
  const r = newRepo('frag-missing');
  touchSource(r);
  commitAll(r, '🐛 fix: untracked change (GH 2002)');
  const out = lint(r, CUTOVER_DAY);
  assert.equal(out.code, 1, 'missing → FAIL');
  assert.match(out.output, /GH 2002/, 'names the issue');
});

test('editing CHANGELOG.md and adding a fragment fails (pick one)', () => {
  const r = newRepo('both');
  write(join(r, 'changelog.d/2003-both.md'), '### Fixed\n- **Both** (GH 2003): both.\n');
  edit(join(r, 'CHANGELOG.md'), '### Fixed\n', '### Fixed\n- **Both** (GH 2003): both.\n');
  commitAll(r, '🐛 fix: both (GH 2003)');
  const out = lint(r, CUTOVER_DAY);
  assert.equal(out.code, 1, 'both → FAIL');
  assert.match(out.output, /pick one/, 'says pick one');
});

test('a fragment with an unknown section fails', () => {
  const r = newRepo('bad-section');
  write(join(r, 'changelog.d/2004-better.md'), '### Improved\n- **Better** (GH 2004): better.\n');
  commitAll(r, '✨ feat: better (GH 2004)');
  const out = lint(r, CUTOVER_DAY);
  assert.equal(out.code, 1, 'malformed section → FAIL');
  assert.match(out.output, /first line must be one of/, 'explains the section rule');
});

test('fragment filename, issue citation and #<n> ids are validated', () => {
  const r = newRepo('bad-shape');
  write(join(r, 'changelog.d/Fix_Thing.md'), '### Fixed\n- **x** (GH 2006): x.\n');
  write(join(r, 'changelog.d/2007-y.md'), '### Fixed\n- **y** (GH 1): cites another issue.\n');
  write(join(r, 'changelog.d/2008-z.md'), '### Fixed\n- **z** (GH 2008): see #123.\n');
  commitAll(r, '🐛 fix: shapes');
  const out = lint(r, CUTOVER_DAY);
  assert.equal(out.code, 1, 'malformed fragments → FAIL');
  assert.match(out.output, /Fix_Thing\.md: filename must be/, 'bad filename named');
  assert.match(out.output, /must cite GH 2007/, 'missing self-citation named');
  assert.ok(out.output.includes('not "#<n>"'), 'local #id rejected');
});

test('a direct CHANGELOG.md edit passes on the cut-over day and fails after it', () => {
  const r = newRepo('direct');
  edit(join(r, 'CHANGELOG.md'), '### Fixed\n', '### Fixed\n- **Direct** (GH 2005): direct.\n');
  commitAll(r, '🐛 fix: direct (GH 2005)');
  assert.equal(lint(r, CUTOVER_DAY).code, 0, 'cut-over day → PASS');
  const out = lint(r, AFTER_CUTOVER);
  assert.equal(out.code, 1, 'after cut-over → FAIL');
  assert.match(out.output, /edits CHANGELOG\.md directly/, 'names the rule');
});

test('an in-flight branch (every cited issue in the transition list) may still edit CHANGELOG.md', () => {
  const r = newRepo('in-flight');
  edit(join(r, 'CHANGELOG.md'), '### Fixed\n', '### Fixed\n- **Runner** (GH 1245): runner.\n');
  commitAll(r, '🧪 test: runner (GH 1245)');
  assert.equal(lint(r, AFTER_CUTOVER).code, 0, 'transition → PASS');
});

test('a version bump branch assembles CHANGELOG.md without tripping the direct-edit rule', () => {
  const r = newRepo('bump');
  write(join(r, '.claude-plugin/plugin.json'), '{"version": "1.1.0"}\n');
  edit(join(r, 'CHANGELOG.md'), '## Unreleased\n', '## v1.1.0 — 2026-10-20\n');
  commitAll(r, '🔖 chore: bump 1.1.0');
  assert.equal(lint(r, AFTER_CUTOVER).code, 0, 'bump branch → PASS');
});

test('on the base branch the branch rules are skipped', () => {
  const r = newRepo('on-dev');
  git(r, 'checkout', '-q', 'dev');
  assert.match(lint(r, AFTER_CUTOVER).output, /not on a feature branch/, 'skips on dev');
});

// --- lib/changelog-fragments.ts ----------------------------------------------

test('list sorts fragments by issue number then name and skips README, dotfiles and non-.md', () => {
  const dir = join(TMP, 'list/changelog.d');
  for (const f of ['10-ten.md', '9-nine.md', '1277-new-thing.md', '42-hole.md', '300-flag.md']) {
    write(join(dir, f), readFileSync(join(FIXTURE, 'changelog.d', f), 'utf8'));
  }
  write(join(dir, '9-again.md'), 'x\n');
  write(join(dir, 'README.md'), 'readme\n');
  write(join(dir, '.hidden.md'), 'x\n');
  write(join(dir, 'notes.txt'), 'x\n');
  const r = fragments(join(TMP, 'list'), 'list', 'changelog.d');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.stdout.split('\n').filter(Boolean),
    ['9-again.md', '9-nine.md', '10-ten.md', '42-hole.md', '300-flag.md', '1277-new-thing.md'].map((f) => `changelog.d/${f}`),
  );
});

test('validate prints one line per problem and exits 1; a well-formed fragment exits 0 silently', () => {
  const dir = join(TMP, 'validate');
  write(join(dir, '2009-empty.md'), '### Fixed\n\n\n');
  write(join(dir, '2010-nobullet.md'), '### Fixed\nno bullet GH 2010\n');
  write(join(dir, '2011-ok.md'), '### Security\n- **Ok** (GH 2011): fine.\n');
  const bad = fragments(dir, 'validate', '2009-empty.md', '2010-nobullet.md');
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.stdout.split('\n').filter(Boolean), [
    '2009-empty.md: no entry text after the section line',
    '2010-nobullet.md: the entry must start with "- " (one bullet)',
  ]);
  const good = fragments(dir, 'validate', '2011-ok.md');
  assert.equal(good.status, 0);
  assert.equal(good.stdout, '');
  assert.equal(fragments(dir, 'bogus').status, 2, 'unknown subcommand → usage, exit 2');
});

// --- bump-version.ts assembly ------------------------------------------------

function bumpRepo(name) {
  const dir = join(TMP, name);
  for (const f of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'package.json', 'mcp/trajectory-server/package.json']) {
    write(join(dir, f), '{\n  "version": "1.0.0"\n}\n');
  }
  write(join(dir, 'bun.lock'), '{\n  "workspaces": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n');
  mkdirSync(join(dir, 'changelog.d'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'dev');
  copyFileSync(join(FIXTURE, 'CHANGELOG.md'), join(dir, 'CHANGELOG.md'));
  mkdirSync(join(dir, 'scripts/maintenance/lib'), { recursive: true });
  copyFileSync(BUMP, join(dir, 'scripts/maintenance/bump-version.ts'));
  copyFileSync(LIB, join(dir, 'scripts/maintenance/lib/changelog-fragments.ts'));
  return dir;
}

/** bump-version.ts operates on the checkout holding it, so run the temp repo's copy from an unrelated cwd. */
function bump(dir, ...args) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(dir, 'scripts/maintenance/bump-version.ts'), ...args], {
    cwd: TMP,
    encoding: 'utf8',
  });
}

/** Copied in the given order so creation order (and mtimes) differ between copies. */
function addFragments(dir, ...names) {
  for (const f of names) copyFileSync(join(FIXTURE, 'changelog.d', f), join(dir, 'changelog.d', f));
}

/** Every file outside .git with its content, sorted by path. */
function snapshot(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      if (path === '.git') continue;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else out.push(`${path}\n${readFileSync(join(dir, path), 'utf8')}`);
    }
  };
  walk('');
  return out.join('\0');
}

const EXPECTED_BLOCK = readFileSync(join(FIXTURE, 'expected-block.md'), 'utf8');
const ORDER_A = ['10-ten.md', '9-nine.md', '1277-new-thing.md', '42-hole.md', '300-flag.md'];

test('--dry-run prints the expected section and changes nothing', () => {
  const b = bumpRepo('bump-dry');
  addFragments(b, ...ORDER_A);
  const before = snapshot(b);
  const r = bump(b, '--dry-run', '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, EXPECTED_BLOCK, 'dry-run block');
  assert.equal(snapshot(b), before, 'dry-run leaves every file unchanged');
});

test('same inputs in a different creation order → byte-identical section', () => {
  const a = bumpRepo('bump-order-a');
  addFragments(a, ...ORDER_A);
  const b = bumpRepo('bump-order-b');
  addFragments(b, ...[...ORDER_A].reverse());
  assert.equal(bump(b, '--dry-run', '--date', '2026-10-12', '1.1.0').stdout, bump(a, '--dry-run', '--date', '2026-10-12', '1.1.0').stdout);
});

test('the bump writes the section in place of Unreleased and deletes the fragments', () => {
  const b = bumpRepo('bump-write');
  addFragments(b, ...ORDER_A);
  const r = bump(b, '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  const expected = `# Changelog\n\nAll notable changes.\n\n${EXPECTED_BLOCK}## v1.0.0 — 2026-01-01\n\n### Added\n- **First release** (GH 1): hello.\n`;
  assert.equal(readFileSync(join(b, 'CHANGELOG.md'), 'utf8'), expected, 'CHANGELOG.md');
  assert.deepEqual(readdirSync(join(b, 'changelog.d')).filter((f) => f.endsWith('.md')), [], 'fragments deleted');
  assert.match(readFileSync(join(b, '.claude-plugin/plugin.json'), 'utf8'), /"version": "1\.1\.0"/, 'manifest bumped');
});

test('a malformed fragment refuses the bump and leaves every file unchanged', () => {
  const b = bumpRepo('bump-bad');
  addFragments(b, '9-nine.md');
  write(join(b, 'changelog.d/77-nope.md'), '### Tweaked\n- **Nope** (GH 77): nope.\n');
  const before = snapshot(b);
  const r = bump(b, '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 1, 'malformed → exit 1');
  assert.match(r.stderr, /77-nope\.md/, 'names the fragment');
  assert.equal(snapshot(b), before, 'nothing changed');
});
