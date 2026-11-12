// L3: changelog.d/ fragments (GH 1277, GH 1692): changelogCurrent from
// tests/l1-lint/changelog-current.test.mjs on a feature branch, scripts/maintenance/lib/changelog-fragments.ts on its own,
// and scripts/maintenance/bump-version.ts assembling the fragments into a
// release section, byte-identically for the same inputs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { changelogCurrent } from '../l1-lint/changelog-current.test.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = join(ROOT, 'scripts/maintenance/lib/changelog-fragments.ts');
const BUMP = join(ROOT, 'scripts/maintenance/bump-version.ts');
const IMPACT_LIB = join(ROOT, 'scripts/maintenance/lib/measured-impact.ts');
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
  return changelogCurrent(dir, { today, env: GIT_ENV });
}

function fragments(cwd, ...args) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', LIB, ...args], { cwd, encoding: 'utf8' });
}

// --- changelog-current.test.mjs ----------------------------------------------

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

test('a redaction-only CHANGELOG.md edit passes after the cut-over', () => {
  const r = newRepo('redaction');
  edit(join(r, 'CHANGELOG.md'), '- **First** (GH 1): hi.\n', '- **First** (GH 1): hi, trimmed.\n');
  commitAll(r, '🐛 fix: trim a released entry');
  const out = lint(r, AFTER_CUTOVER);
  assert.equal(out.code, 0, out.output);
  assert.match(out.output, /redaction-only/, 'names the exception');
});

test('a CHANGELOG.md edit that adds a line or touches a heading still fails after the cut-over', () => {
  const added = newRepo('redaction-net-add');
  edit(join(added, 'CHANGELOG.md'), '- **First** (GH 1): hi.\n', '- **First** (GH 1): hi.\n- **Second** (GH 1): more.\n');
  commitAll(added, '🐛 fix: add a line');
  const addedOut = lint(added, AFTER_CUTOVER);
  assert.equal(addedOut.code, 1, 'net +1 → FAIL');
  assert.match(addedOut.output, /edits CHANGELOG\.md directly/, 'net +1 names the rule');

  const heading = newRepo('redaction-heading');
  edit(join(heading, 'CHANGELOG.md'), '### Added\n', '### Changed\n');
  commitAll(heading, '🐛 fix: rename a heading');
  const headingOut = lint(heading, AFTER_CUTOVER);
  assert.equal(headingOut.code, 1, 'heading swap → FAIL');
  assert.match(headingOut.output, /edits CHANGELOG\.md directly/, 'heading swap names the rule');

  const dropped = newRepo('redaction-heading-removed');
  edit(join(dropped, 'CHANGELOG.md'), '### Fixed\n- **Old** (GH 100): old.\n', '- **Old** (GH 100): old, trimmed.\n');
  commitAll(dropped, '🐛 fix: drop a heading');
  const droppedOut = lint(dropped, AFTER_CUTOVER);
  assert.equal(droppedOut.code, 1, 'removed heading → FAIL');
  assert.match(droppedOut.output, /edits CHANGELOG\.md directly/, 'removed heading names the rule');
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
  for (const f of ['.claude-plugin/plugin.json', 'package.json', 'mcp/trajectory-server/package.json']) {
    write(join(dir, f), '{\n  "version": "1.0.0"\n}\n');
  }
  write(join(dir, 'bun.lock'), '{\n  "workspaces": {\n    "": {\n      "version": "1.0.0"\n    }\n  }\n}\n');
  mkdirSync(join(dir, 'changelog.d'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'dev');
  copyFileSync(join(FIXTURE, 'CHANGELOG.md'), join(dir, 'CHANGELOG.md'));
  mkdirSync(join(dir, 'scripts/maintenance/lib'), { recursive: true });
  copyFileSync(BUMP, join(dir, 'scripts/maintenance/bump-version.ts'));
  copyFileSync(LIB, join(dir, 'scripts/maintenance/lib/changelog-fragments.ts'));
  copyFileSync(IMPACT_LIB, join(dir, 'scripts/maintenance/lib/measured-impact.ts'));
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
  assert.doesNotMatch(r.stdout, /Measured impact/, 'no Measured impact section without --impact-db');
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

test('a fragment with a second section line fails validate and refuses the bump (GH 2599)', () => {
  const twoSections = '### Changed\n- **One** (GH 78): one.\n\n### Removed\n- **Two** (GH 78): two.\n';
  const dir = join(TMP, 'validate-two-sections');
  write(join(dir, '78-two.md'), twoSections);
  const v = fragments(dir, 'validate', '78-two.md');
  assert.equal(v.status, 1, 'second section → exit 1');
  assert.deepEqual(v.stdout.split('\n').filter(Boolean), [
    '78-two.md:4: a second section line "### Removed"; one section per fragment, so split it into two fragments (changelog.d/README.md)',
  ]);

  const b = bumpRepo('bump-two-sections');
  addFragments(b, '9-nine.md');
  write(join(b, 'changelog.d/78-two.md'), twoSections);
  const before = snapshot(b);
  const r = bump(b, '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 1, 'second section → bump exits 1');
  assert.match(r.stderr, /78-two\.md:4: a second section line "### Removed"/, 'names the fragment, line and header');
  assert.equal(snapshot(b), before, 'nothing changed');
});

test('a final Metric: line with a registry id passes; every other Metric: line is a problem at file:line (GH 2600)', () => {
  const dir = join(TMP, 'validate-metric');
  const cases = {
    '2600-ok.md': '### Added\n- **Ok** (GH 2600): fine.\n\nMetric: swe_rework_ratio lower\n',
    '2601-unknown.md': '### Added\n- **A** (GH 2601): a.\nMetric: nope_metric lower\n',
    '2602-direction.md': '### Added\n- **A** (GH 2602): a.\nMetric: swe_rework_ratio down\n',
    '2603-extra.md': '### Added\n- **A** (GH 2603): a.\nMetric: swe_rework_ratio lower please\n',
    '2604-missing.md': '### Added\n- **A** (GH 2604): a.\nMetric: swe_rework_ratio\n',
    '2605-not-last.md': '### Added\n- **A** (GH 2605): a.\nMetric: swe_rework_ratio lower\n  a continuation line.\n',
    '2606-two.md': '### Added\n- **A** (GH 2606): a.\nMetric: swe_rework_ratio lower\nMetric: tokens_per_task lower\n',
  };
  for (const [name, text] of Object.entries(cases)) write(join(dir, name), text);
  const ok = fragments(dir, 'validate', '2600-ok.md');
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(ok.stdout, '');
  const bad = fragments(dir, 'validate', ...Object.keys(cases).slice(1));
  assert.equal(bad.status, 1);
  assert.deepEqual(bad.stdout.split('\n').filter(Boolean), [
    '2601-unknown.md:3: unknown metric "nope_metric"; one of swe_rework_ratio, tokens_per_task, reworks_per_task, review_fail_rate, verification_pass_rate, hook_block_tokens_per_run, bro_tokens_per_session',
    '2602-direction.md:3: the Metric: line must be exactly "Metric: <metric id> lower|higher" (got "Metric: swe_rework_ratio down")',
    '2603-extra.md:3: the Metric: line must be exactly "Metric: <metric id> lower|higher" (got "Metric: swe_rework_ratio lower please")',
    '2604-missing.md:3: the Metric: line must be exactly "Metric: <metric id> lower|higher" (got "Metric: swe_rework_ratio")',
    '2605-not-last.md:3: the Metric: line must be the last line of the entry',
    '2606-two.md:3: a second Metric: line; a fragment declares at most one, as its last line',
  ]);
});

test('bump-version leaves the Metric: line out of CHANGELOG.md, entry text byte-identical (GH 2600)', () => {
  const declared = '### Fixed\n- **Nine** (GH 9): first fragment in Fixed.\n\nMetric: swe_rework_ratio lower\n';
  const plain = bumpRepo('bump-metric-plain');
  addFragments(plain, ...ORDER_A);
  const expected = bump(plain, '--dry-run', '--date', '2026-10-12', '1.1.0');
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(expected.stdout, EXPECTED_BLOCK);

  const b = bumpRepo('bump-metric');
  addFragments(b, ...ORDER_A.filter((f) => f !== '9-nine.md'));
  write(join(b, 'changelog.d/9-nine.md'), declared);
  const dry = bump(b, '--dry-run', '--date', '2026-10-12', '1.1.0');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, EXPECTED_BLOCK, 'dry-run block equals the plain one');
  assert.doesNotMatch(dry.stdout, /Metric:/);
  const r = bump(b, '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  const changelog = readFileSync(join(b, 'CHANGELOG.md'), 'utf8');
  assert.equal(changelog, `# Changelog\n\nAll notable changes.\n\n${EXPECTED_BLOCK}## v1.0.0 — 2026-01-01\n\n### Added\n- **First release** (GH 1): hello.\n`);
  assert.doesNotMatch(changelog, /Metric:/);
});

// --- bump-version.ts --impact-db --------------------------------------------

const NINE_DECLARED = '### Fixed\n- **Nine** (GH 9): first fragment in Fixed.\n\nMetric: swe_rework_ratio lower\n';
const IMPACT_JSON = {
  source: 'plugin_version',
  id: '123',
  metrics: [
    { id: 'swe_rework_ratio', ratio_of_medians: 0.8, ratio_ci: [0.65, 0.95], verdict: 'improved' },
    { id: 'tokens_per_task', ratio_of_medians: 1.1, ratio_ci: [0.9, 1.3], verdict: 'no_change' },
  ],
  declared: [{ metric: 'swe_rework_ratio', direction: 'lower', outcome: 'as_declared' }],
};

/** A fake dist/change-impact/cli.js that logs its argv to <log> and prints <stdout> / <stderr> with <status>. */
function stubCli(dir, log, { stdout = '', stderr = '', status = 0 } = {}) {
  write(
    join(dir, 'mcp/trajectory-server/dist/change-impact/cli.js'),
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
      `process.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exitCode = ${status};\n`,
  );
}

/** measuredImpactBullets(<impacts>) from lib/measured-impact.ts, run under --experimental-strip-types. */
function measuredImpactBullets(impacts) {
  const code = `import { measuredImpactBullets } from ${JSON.stringify(pathToFileURL(IMPACT_LIB).href)};
process.stdout.write(JSON.stringify(measuredImpactBullets(JSON.parse(process.env.IMPACTS))));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], {
    env: { ...process.env, IMPACTS: JSON.stringify(impacts) },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** A bump repo with ORDER_A whose 9-nine.md declares a metric, committed with a `(#123)` subject. */
function impactRepo(name, nine = NINE_DECLARED, subject = '✨ feat: nine (#123)') {
  const b = bumpRepo(name);
  addFragments(b, ...ORDER_A.filter((f) => f !== '9-nine.md'));
  write(join(b, 'changelog.d/9-nine.md'), nine);
  commitAll(b, subject);
  return b;
}

const AS_DECLARED = '- #123 `swe_rework_ratio`, expected lower: as declared (median ratio 0.80, 95% CI 0.65–0.95)';

test('--impact-db appends a Measured impact section, last, with the declared bullet and its ratio (GH 2600)', () => {
  const b = impactRepo('impact-ok');
  const log = join(TMP, 'impact-ok.log');
  stubCli(b, log, { stdout: JSON.stringify(IMPACT_JSON) });
  const dry = bump(b, '--dry-run', '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
  assert.equal(dry.status, 0, dry.stderr);
  const expectedBlock = `${EXPECTED_BLOCK}### Measured impact\n${AS_DECLARED}\n\n`;
  assert.equal(dry.stdout, expectedBlock, 'dry-run prints the section after every other one');
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').trim()), ['--db', join(realpathSync(TMP), 'some.db'), '--source', 'plugin_version', '--id', '123'], 'CLI argv, db resolved from the cwd');

  const r = bump(b, '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  const changelog = readFileSync(join(b, 'CHANGELOG.md'), 'utf8');
  assert.equal(changelog, `# Changelog\n\nAll notable changes.\n\n${expectedBlock}## v1.0.0 — 2026-01-01\n\n### Added\n- **First release** (GH 1): hello.\n`);
  assert.doesNotMatch(changelog, /Metric:/, 'the Metric: line still stays out');
});

test('--impact-db renders each outcome, sorts by PR then metric, and omits the ratio when there is not enough data', () => {
  const ratio = (id, verdict) => ({ id, ratio_of_medians: 1.5, ratio_ci: [1.25, 1.75], verdict });
  assert.deepEqual(
    measuredImpactBullets([
      {
        pr: 20,
        declared: [
          { metric: 'tokens_per_task', direction: 'lower', outcome: 'wrong_way' },
          { metric: 'review_fail_rate', direction: 'lower', outcome: 'not_moved' },
        ],
        metrics: [ratio('tokens_per_task', 'regressed'), ratio('review_fail_rate', 'no_change')],
      },
      {
        pr: 3,
        declared: [
          { metric: 'verification_pass_rate', direction: 'higher', outcome: 'not_enough_data' },
          { metric: 'swe_rework_ratio', direction: 'lower', outcome: 'as_declared' },
        ],
        metrics: [ratio('verification_pass_rate', 'not_enough_data')],
      },
    ]),
    [
      '- #3 `swe_rework_ratio`, expected lower: as declared',
      '- #3 `verification_pass_rate`, expected higher: not enough data',
      '- #20 `review_fail_rate`, expected lower: did not move (median ratio 1.50, 95% CI 1.25–1.75)',
      '- #20 `tokens_per_task`, expected lower: moved the wrong way (median ratio 1.50, 95% CI 1.25–1.75)',
    ],
  );
});

test('--impact-db with no declared metric adds no section and never spawns the CLI', () => {
  const b = bumpRepo('impact-none');
  addFragments(b, ...ORDER_A);
  commitAll(b, '✨ feat: plain (#124)');
  const log = join(TMP, 'impact-none.log');
  stubCli(b, log, { stdout: JSON.stringify(IMPACT_JSON) });
  const r = bump(b, '--dry-run', '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, EXPECTED_BLOCK);
  assert.throws(() => statSync(log), 'CLI never spawned');
});

test('--impact-db skips a declaring fragment whose adding commit has no (#N), naming it on stderr', () => {
  const b = impactRepo('impact-no-pr', NINE_DECLARED, '✨ feat: nine, no PR');
  const log = join(TMP, 'impact-no-pr.log');
  stubCli(b, log, { stdout: JSON.stringify(IMPACT_JSON) });
  const r = bump(b, '--dry-run', '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, EXPECTED_BLOCK);
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1);
  assert.match(r.stderr, /changelog\.d\/9-nine\.md/);
  assert.throws(() => statSync(log), 'CLI never spawned');
});

test('--impact-db: an unknown change reads not enough data, with no ratio', () => {
  const b = impactRepo('impact-unknown');
  stubCli(b, join(TMP, 'impact-unknown.log'), { stderr: 'unknown change plugin_version:123\n', status: 1 });
  const r = bump(b, '--dry-run', '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${EXPECTED_BLOCK}### Measured impact\n- #123 \`swe_rework_ratio\`, expected lower: not enough data\n\n`);
});

test('--impact-db: a missing CLI or another CLI failure exits non-zero and changes nothing', () => {
  const missing = impactRepo('impact-missing');
  const before = snapshot(missing);
  const r = bump(missing, '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
  assert.notEqual(r.status, 0, 'missing CLI → non-zero');
  assert.match(r.stderr, /dist\/change-impact\/cli\.js/);
  assert.equal(snapshot(missing), before, 'nothing changed');

  for (const [name, stub] of [
    ['impact-fail', { stderr: 'database is locked\n', status: 1 }],
    ['impact-garbage', { stdout: 'not json' }],
  ]) {
    const b = impactRepo(name);
    stubCli(b, join(TMP, `${name}.log`), stub);
    const prior = snapshot(b);
    const out = bump(b, '--impact-db', 'some.db', '--date', '2026-10-12', '1.1.0');
    assert.notEqual(out.status, 0, `${name} → non-zero`);
    assert.match(out.stderr, /#123/);
    assert.equal(snapshot(b), prior, `${name}: nothing changed`);
  }
});

test('--version-only ignores --impact-db', () => {
  const b = impactRepo('impact-version-only');
  const before = readFileSync(join(b, 'CHANGELOG.md'), 'utf8');
  const r = bump(b, '--version-only', '--impact-db', 'some.db', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(b, 'CHANGELOG.md'), 'utf8'), before);
  assert.match(readFileSync(join(b, 'package.json'), 'utf8'), /"version": "1\.1\.0"/);
});

test('versions are matched literally, never as regex patterns', () => {
  const b = bumpRepo('bump-literal');
  const odd = '1.0.0+build(1)';
  for (const f of ['.claude-plugin/plugin.json', 'package.json', 'mcp/trajectory-server/package.json']) {
    edit(join(b, f), '"1.0.0"', `"${odd}"`);
  }
  edit(join(b, 'bun.lock'), '"1.0.0"', `"${odd}"`);
  edit(join(b, 'CHANGELOG.md'), '## v1.0.0 — 2026-01-01', '## v1x1x0 — 2026-01-01');
  addFragments(b, '9-nine.md');
  const r = bump(b, '--date', '2026-10-12', '1.1.0');
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['.claude-plugin/plugin.json', 'bun.lock']) {
    assert.match(readFileSync(join(b, f), 'utf8'), /"version": "1\.1\.0"/, `${f} bumped from a metachar version`);
  }
  assert.match(readFileSync(join(b, 'CHANGELOG.md'), 'utf8'), /^## v1\.1\.0 — 2026-10-12$/m, 'v1x1x0 is not taken for v1.1.0');
});
