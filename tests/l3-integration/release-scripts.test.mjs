// L3: scripts/release.ts, scripts/publish-rc-channel.ts and
// scripts/lib/await-release-gate.ts (GH 1692). Each run copies the scripts into
// a temp plugin root and puts stub git, gh and docker executables first on
// PATH, so nothing reaches the real GitHub remote; prompts are answered on
// stdin. The structural cases carry the rules of the former
// tests/l1-lint/release-script-safety lint over to the TypeScript sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = ['scripts/release.ts', 'scripts/publish-rc-channel.ts', 'scripts/await-payload-tag.ts', 'scripts/lib/await-release-gate.ts'];
const RELEASE_SRC = readFileSync(join(ROOT, 'scripts/release.ts'), 'utf8');
const RC_SRC = readFileSync(join(ROOT, 'scripts/publish-rc-channel.ts'), 'utf8');
const GATE_SRC = readFileSync(join(ROOT, 'scripts/lib/await-release-gate.ts'), 'utf8');
const PLUGIN_REPO = 'https://github.com/trustmybot/plugin.git';
const CATALOG_REPO = 'https://github.com/trustmybot/marketplace-rc.git';
const HEAD = 'a'.repeat(40);

const STUB = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(process.env.STUB_CONFIG, 'utf8'));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify([name, ...args]) + '\\n');
const line = args.join(' ');
for (const rule of config[name] || []) {
  if (!new RegExp(rule.match).test(line)) continue;
  if (rule.copyTo) fs.cpSync(rule.copyTo, args[args.length - 1], { recursive: true });
  if (rule.snapshot) fs.cpSync(args[1], rule.snapshot, { recursive: true });
  if (rule.saveArgAfter) fs.copyFileSync(args[args.indexOf(rule.saveArgAfter) + 1], rule.saveTo);
  if (rule.stdout) process.stdout.write(rule.stdout);
  if (rule.stderr) process.stderr.write(rule.stderr);
  process.exit(rule.status === undefined ? 0 : rule.status);
}
`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function changelog(version, body = '- A change.\n') {
  return `# Changelog\n\n## v${version} — 2026-11-01\n\n${body}\n---\n\n## v1.0.0 — 2026-01-01\n\n- Old.\n`;
}

function fixture(t, { version = '1.2.0', mcpVersion = version, changelogText = changelog(version), catalog = { ref: 'payload/v1.1.0', readme: true } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'plugin');
  for (const rel of SCRIPTS) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(root, rel));
  }
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'mcp/trajectory-server'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'tmb', version }));
  writeFileSync(join(root, 'mcp/trajectory-server/package.json'), JSON.stringify({ version: mcpVersion }));
  writeFileSync(join(root, 'CHANGELOG.md'), changelogText);

  const catalogDir = join(dir, 'catalog');
  mkdirSync(join(catalogDir, '.claude-plugin'), { recursive: true });
  if (catalog.json !== false) {
    writeFileSync(
      join(catalogDir, '.claude-plugin/marketplace.json'),
      `${JSON.stringify({ name: 'trustmybot-rc', plugins: [{ name: 'tmb', source: { source: 'github', repo: 'trustmybot/plugin', ref: catalog.ref } }] }, null, 2)}\n`,
    );
  }
  if (catalog.readme) writeFileSync(join(catalogDir, 'README.md'), '# rc\n');

  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['git', 'gh', 'docker']) {
    writeFileSync(join(bin, name), STUB);
    chmodSync(join(bin, name), 0o755);
  }
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp);
  return { dir, root, bin, tmp, catalogDir, version, tag: `v${version}` };
}

function baseRules(f) {
  const tag = esc(f.tag);
  return {
    git: [
      { match: '^branch --show-current$', stdout: 'main\n' },
      { match: '^rev-parse (main|origin/main)$', stdout: `${HEAD}\n` },
      { match: `^rev-parse ${tag}$`, status: 1 },
      { match: `^ls-remote --tags origin refs/tags/${tag}$`, stdout: '' },
      { match: ` tag --list v\\*-rc\\.\\* --merged HEAD`, stdout: 'v1.2.0-rc.2\nv1.2.0-rc.1\n' },
      { match: `^ls-remote --tags ${esc(PLUGIN_REPO)} refs/tags/payload/${tag} `, stdout: `${'p'.repeat(40)}\trefs/tags/payload/${f.tag}\n` },
      { match: `^ls-remote --tags ${esc(PLUGIN_REPO)} refs/tags/${tag}$`, stdout: `${HEAD}\trefs/tags/${f.tag}\n` },
      { match: `^clone --quiet --depth 1 ${esc(CATALOG_REPO)} `, copyTo: f.catalogDir },
    ],
    gh: [
      { match: '^run list ', stdout: '[{"databaseId":1,"status":"completed","conclusion":"success","url":"https://example.invalid/run/1"}]\n' },
      { match: '^release view ', status: 1 },
    ],
    docker: [],
  };
}

function runScript(f, script, { args = [], input = '', rules = {}, env = {} } = {}) {
  const base = baseRules(f);
  const config = Object.fromEntries(Object.keys(base).map((k) => [k, [...(rules[k] ?? []), ...base[k]]]));
  const configPath = join(f.dir, 'stub-config.json');
  const logPath = join(f.dir, 'stub.log');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(logPath, '');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(f.root, script), ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${f.bin}${delimiter}${process.env.PATH}`,
      STUB_CONFIG: configPath,
      STUB_LOG: logPath,
      TMPDIR: f.tmp,
      NODE_OPTIONS: '--no-warnings',
      TMB_GATE_TIMEOUT: '0',
      TMB_PAYLOAD_TIMEOUT: '0',
      TMB_CANARY_TIMEOUT: '',
      ...env,
    },
  });
  const calls = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { ...r, calls, lines: calls.map((c) => c.join(' ')) };
}

const release = (f, opts) => runScript(f, 'scripts/release.ts', opts);
const publish = (f, opts) => runScript(f, 'scripts/publish-rc-channel.ts', opts);
const ran = (r, re) => r.lines.some((l) => re.test(l));
const indexOf = (r, re) => r.lines.findIndex((l) => re.test(l));

// ---------- structural rules (formerly tests/l1-lint/release-script-safety) ----------

test('G1: release.ts checks the remote for the tag (git ls-remote --tags origin refs/tags/<tag>) before any retag', () => {
  assert.match(RELEASE_SRC, /\['ls-remote', '--tags', 'origin', `refs\/tags\/\$\{tag\}`\]/);
  const check = RELEASE_SRC.indexOf('const publishedSha = remoteTagSha(newTag)');
  const retag = RELEASE_SRC.indexOf("git(['tag', '-d', newTag]");
  assert.ok(check > 0 && retag > check, 'the remote check precedes the local retag');
});

test("G2: release.ts carries the explicit 'Refusing to re-tag a PUBLISHED release' guard", () => {
  assert.ok(RELEASE_SRC.includes('Refusing to re-tag a PUBLISHED release'));
});

test('G3: release.ts exits 1 within 30 lines of the published-retag refusal message', () => {
  const lines = RELEASE_SRC.split('\n');
  const at = lines.findIndex((l) => l.includes('Refusing to re-tag a PUBLISHED release'));
  assert.ok(at >= 0);
  assert.ok(lines.slice(at, at + 31).some((l) => /^\s*throw new Exit\(1\);\s*$/.test(l)), 'no exit 1 near the refusal: the guard would be advisory only');
});

test('G4: release.ts documents the doctrinal alternative (ship a NEW version with the fix)', () => {
  assert.ok(RELEASE_SRC.includes('ship a NEW version with the fix'));
});

test('G5: release.ts never pushes a tag deletion to origin', () => {
  assert.doesNotMatch(RELEASE_SRC, /:refs\/tags/);
});

test('R1: every shell-out uses an argument array, never a shell string', () => {
  for (const [name, src] of [['release.ts', RELEASE_SRC], ['publish-rc-channel.ts', RC_SRC], ['await-release-gate.ts', GATE_SRC]]) {
    assert.doesNotMatch(src, /shell:\s*true|execSync\(|\bexec\(/, `${name} runs a shell string`);
  }
});

test('R2: publish-rc-channel.ts enforces the rc-version regex (X.Y.Z-rc.N)', () => {
  assert.ok(RC_SRC.includes('/^[0-9]+\\.[0-9]+\\.[0-9]+-rc\\.[0-9]+$/'));
});

test('R3: publish-rc-channel.ts verifies the tag on origin (git ls-remote --tags)', () => {
  assert.match(RC_SRC, /\['ls-remote', '--tags', PLUGIN_REPO, `refs\/tags\/\$\{tag\}`\]/);
});

test('R4: publish-rc-channel.ts clones into a temp dir, never a hardcoded catalog path', () => {
  assert.match(RC_SRC, /workDir = mkdtempSync\(join\(tmpdir\(\), 'tmb-rc-catalog-'\)\)/);
  assert.match(RC_SRC, /\['clone', '--quiet', '--depth', '1', CATALOG_REPO, clone\]/);
});

test('R5: publish-rc-channel.ts removes the temp clone on every exit', () => {
  assert.match(RC_SRC, /function finish\(code: number\): void \{[\s\S]*?rmSync\(workDir, \{ recursive: true, force: true \}\)/);
  assert.match(RC_SRC, /main\(\)\.then\(\s*\(\) => finish\(0\),[\s\S]*?finish\(e instanceof Exit \? e\.code : 1\)/);
});

test('R6: --stable-repin enforces the stable-tag regex (X.Y.Z)', () => {
  assert.ok(RC_SRC.includes("'--stable-repin'"));
  assert.ok(RC_SRC.includes('/^v?[0-9]+\\.[0-9]+\\.[0-9]+$/'));
});

test('S1: release.ts step 6 re-pins the rc channel with publish-rc-channel.ts --stable-repin', () => {
  assert.match(RELEASE_SRC, /join\(PLUGIN_ROOT, 'scripts\/publish-rc-channel\.ts'\), '--stable-repin', '--yes', newVersion\]/);
});

test('P1: publish-rc-channel.ts pins and checks idempotency against payload/<tag>, never the bare tag', () => {
  assert.ok(RC_SRC.includes('const payloadRef = `payload/${tag}`;'));
  assert.ok(RC_SRC.includes('catalog.plugins[0].source.ref = payloadRef;'));
  assert.ok(RC_SRC.includes('currentRef === payloadRef'));
  assert.doesNotMatch(RC_SRC, /source\.ref = tag\b/);
});

test('P2: publish-rc-channel.ts awaits payload/<tag> after the gate and before the clone, exiting on failure', () => {
  const gate = RC_SRC.indexOf('await awaitReleaseGate(tag, PLUGIN_ROOT)');
  const helper = RC_SRC.indexOf("'scripts/await-payload-tag.ts'), tag, '--remote', PLUGIN_REPO]");
  const exits = RC_SRC.indexOf('must(payload);');
  const clone = RC_SRC.indexOf("['clone', ");
  assert.ok(gate > 0 && helper > gate && exits > helper && clone > exits, `order gate=${gate} helper=${helper} exits=${exits} clone=${clone}`);
});

test('P3: scripts/await-payload-tag.ts exists', () => {
  assert.ok(existsSync(join(ROOT, 'scripts/await-payload-tag.ts')));
});

test('P4: release.ts step 6 names payload/<tag>; the summary verifies it and stable-build', () => {
  assert.ok(RELEASE_SRC.includes('Re-pin the rc channel to payload/${newTag}?'));
  assert.ok(RELEASE_SRC.includes('refs/tags/payload/${newTag}'));
  assert.ok(RELEASE_SRC.includes('refs/heads/stable-build'));
});

test('the release-gate await lives only in scripts/lib/await-release-gate.ts', () => {
  assert.match(GATE_SRC, /export async function awaitReleaseGate\(/);
  assert.match(GATE_SRC, /export function resolveGateTag\(/);
  for (const src of [RELEASE_SRC, RC_SRC]) {
    assert.match(src, /from '\.\/lib\/await-release-gate\.ts'/);
    assert.doesNotMatch(src, /'run', 'list'/);
  }
});

// ---------- release.ts behaviour ----------

test('release.ts refuses off main (exit 1)', (t) => {
  const f = fixture(t);
  const r = release(f, { rules: { git: [{ match: '^branch --show-current$', stdout: 'dev\n' }] } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Refusing to run\. Current branch: dev — must be 'main'\.\n {3}Run: git checkout main && git pull origin main\n/);
  assert.ok(!ran(r, /^git tag /));
});

test('release.ts refuses a dirty tree (exit 1)', (t) => {
  const f = fixture(t);
  const r = release(f, { rules: { git: [{ match: '^diff --cached --quiet$', status: 1 }] } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Refusing to run\. Working tree has uncommitted changes\./);
  assert.ok(!ran(r, /^git fetch/));
});

test('release.ts refuses when local main and origin/main differ (exit 1)', (t) => {
  const f = fixture(t);
  const r = release(f, { rules: { git: [{ match: '^rev-parse origin/main$', stdout: `${'b'.repeat(40)}\n` }] } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Local main \(aaaaaaaa\) != origin\/main \(bbbbbbbb\)/);
});

test('release.ts refuses when the mcp package version disagrees with plugin.json (exit 1)', (t) => {
  const f = fixture(t, { mcpVersion: '1.1.0' });
  const r = release(f);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /mcp\/trajectory-server\/package\.json version is 1\.1\.0 — expected 1\.2\.0 \(from plugin\.json\)\.\n {3}Bump both in the same release-prep PR\./);
});

test('release.ts refuses when CHANGELOG.md has no section for the plugin.json version (exit 1)', (t) => {
  const f = fixture(t, { changelogText: changelog('1.1.0') });
  const r = release(f);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Refusing to run\. CHANGELOG\.md has no '## v1\.2\.0' section\./);
  assert.ok(!ran(r, /^git (tag|push)/));
});

test('release.ts refuses without gh on PATH (exit 1)', (t) => {
  const f = fixture(t);
  rmSync(join(f.bin, 'gh'));
  const r = release(f, { env: { PATH: f.bin } });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, '❌ gh CLI is required.\n');
});

test('release.ts refuses to re-tag a published release (exit 1) and moves no tag', (t) => {
  const f = fixture(t);
  const r = release(f, {
    rules: {
      git: [
        { match: '^rev-parse v1\\.2\\.0(\\^\\{commit\\})?$', stdout: `${'b'.repeat(40)}\n` },
        { match: '^ls-remote --tags origin refs/tags/v1\\.2\\.0$', stdout: `${'c'.repeat(40)}\trefs/tags/v1.2.0\n` },
      ],
    },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Refusing to re-tag a PUBLISHED release\.\n\n {2}v1\.2\.0 is already on origin \(sha=cccccccc\)\./);
  assert.match(r.stderr, /ship a NEW version with the fix:\n {4}1\. Bump plugin\.json \+ mcp pkg\.json \+ root pkg\.json to v1\.2\.<next-patch>/);
  assert.ok(!ran(r, /^git tag /));
});

test('release.ts moves a local-only tag without pushing a tag deletion', (t) => {
  const f = fixture(t);
  const r = release(f, {
    input: 'y\nn\n',
    rules: { git: [{ match: '^rev-parse v1\\.2\\.0(\\^\\{commit\\})?$', stdout: `${'b'.repeat(40)}\n` }] },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Local-only v1\.2\.0 exists at bbbbbbbb but points at bbbbbbbb, not main HEAD aaaaaaaa\./);
  assert.match(r.stdout, / {2}Move v1\.2\.0 to current main HEAD\? \[y\/N\] {3}✓ v1\.2\.0 re-tagged locally on aaaaaaaa\n/);
  assert.match(r.stdout, /Skipped — exiting \(release-create needs the remote tag\)\.\n$/);
  assert.ok(indexOf(r, /^git tag -d v1\.2\.0$/) < indexOf(r, /^git tag -a v1\.2\.0 -m v1\.2\.0$/));
  assert.ok(!ran(r, /^git push/));
});

test('release.ts exits 1 when step 1 is declined', (t) => {
  const f = fixture(t);
  const r = release(f, { input: 'n\n' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Step 1: Tag main HEAD as v1\.2\.0\? \[y\/N\] {3}Skipped — exiting \(downstream steps depend on the tag\)\.\n$/);
  assert.ok(!ran(r, /^git tag /));
});

test('release.ts treats EOF on stdin as No', (t) => {
  const f = fixture(t);
  const r = release(f, { input: '' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Skipped — exiting \(downstream steps depend on the tag\)\./);
});

for (const [name, run, code, stderr] of [
  ['concluded failure', '[{"status":"completed","conclusion":"failure","url":"u"}]', 3, /❌ release-gate for v1\.2\.0-rc\.2 concluded failure — refusing to publish\./],
  ['found no run', '[]', 2, /❌ No release-gate run found for tag v1\.2\.0-rc\.2\./],
  ['is still queued at the timeout', '[{"status":"queued","conclusion":"","url":"u"}]', 4, /❌ release-gate for v1\.2\.0-rc\.2 still queued after 0s — timed out\./],
  ['reports an unexpected status at the timeout', '[{"status":"weird","url":"u"}]', 4, /unexpected status 'weird' after 0s — timed out\./],
]) {
  test(`release.ts refuses when the promoted rc's release gate ${name} (exit ${code}) and creates no release`, (t) => {
    const f = fixture(t);
    const r = release(f, { input: 'y\ny\n', rules: { gh: [{ match: '^run list ', stdout: run }] } });
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stderr, stderr);
    assert.match(r.stdout, /Step 3: Awaiting the release-gate run for v1\.2\.0-rc\.2 \(the promoted rc's verdict for v1\.2\.0\) \.\.\./);
    assert.ok(ran(r, /^gh run list --repo trustmybot\/plugin --workflow=release-gate --branch v1\.2\.0-rc\.2 /));
    assert.ok(!ran(r, /^gh release (view|create)/));
  });
}

test('release.ts refuses a stable tag with no rc tag in HEAD ancestry (exit 2)', (t) => {
  const f = fixture(t);
  const r = release(f, { input: 'y\ny\n', rules: { git: [{ match: ' tag --list ', stdout: '' }] } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /❌ resolve_gate_tag: no v\*-rc\.\* tag in HEAD's ancestry for stable tag v1\.2\.0\./);
  assert.ok(!ran(r, /^gh /));
});

test('release.ts awaits an rc tag gate on the tag itself', (t) => {
  const f = fixture(t, { version: '1.3.0-rc.1' });
  const r = release(f, { input: 'y\ny\nn\nn\nn\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Step 3: Awaiting the release-gate run for v1\.3\.0-rc\.1 \.\.\.\n✓ release-gate for v1\.3\.0-rc\.1 concluded success\./);
  assert.ok(!ran(r, / tag --list /));
});

test('release.ts refuses to create a release with empty CHANGELOG notes (exit 1)', (t) => {
  const f = fixture(t, { changelogText: '## v1.2.0 — 2026-11-01\n---\n## v1.0.0 — x\n' });
  const r = release(f, { input: 'y\ny\ny\n' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Failed to extract v1\.2\.0 notes from CHANGELOG\.md — aborting\./);
  assert.ok(!ran(r, /^gh release create/));
});

test('release.ts runs every step in order and re-pins the rc channel through publish-rc-channel.ts', (t) => {
  const f = fixture(t);
  const notes = join(f.dir, 'notes.md');
  const r = release(f, {
    input: 'y\ny\ny\nn\ny\n',
    rules: { gh: [{ match: '^release create ', saveArgAfter: '--notes-file', saveTo: notes }] },
  });
  assert.equal(r.status, 0, r.stderr);
  const steps = [
    '✓ Pre-flight checks passed.',
    'Step 1: Tag main HEAD as v1.2.0? [y/N]   ✓ v1.2.0 tagged on aaaaaaaa',
    'Step 2: Push v1.2.0 to origin? [y/N]   ✓ v1.2.0 pushed',
    "Step 3: Awaiting the release-gate run for v1.2.0-rc.2 (the promoted rc's verdict for v1.2.0) ...",
    '✓ release-gate for v1.2.0-rc.2 concluded success.',
    'Step 4: Create GitHub release v1.2.0 with the CHANGELOG body? [y/N]   ✓ GitHub release v1.2.0 created',
    "Step 5: Run L5 release canary (re-clone tag in Docker, run install-smoke)? [y/N]   Skipped — run 'node --experimental-strip-types tests/l0-install/run-docker.ts install' manually before announcing.",
    'Step 6: Re-pin the rc channel to payload/v1.2.0? [y/N] Re-pinning the rc channel to the stable tag v1.2.0 (no gate — gated at its rc) ...',
    '✓ Published v1.2.0 to the rc channel.',
    '  ✓ rc channel re-pinned to payload/v1.2.0',
    'Done. Verify:',
    '  - git ls-remote origin refs/heads/stable-build   (should match refs/tags/payload/v1.2.0)',
  ];
  let at = -1;
  for (const s of steps) {
    const next = r.stdout.indexOf(s, at + 1);
    assert.ok(next > at, `missing or out of order: ${s}\n${r.stdout}`);
    at = next;
  }
  assert.equal(readFileSync(notes, 'utf8'), '\n- A change.\n\n\n');
  const order = [/^git tag -a v1\.2\.0 -m v1\.2\.0$/, /^git push origin v1\.2\.0$/, /^gh run list /, /^gh release create v1\.2\.0 --title v1\.2\.0 --notes-file /, /^git -C .* push origin main$/];
  const idx = order.map((re) => indexOf(r, re));
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, r.lines.join('\n'));
  assert.ok(idx.every((i) => i >= 0), r.lines.join('\n'));
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('release.ts skips steps already done (tag at HEAD, tag on origin, release exists)', (t) => {
  const f = fixture(t);
  const r = release(f, {
    input: 'n\nn\n',
    rules: {
      git: [
        { match: '^rev-parse v1\\.2\\.0(\\^\\{commit\\})?$', stdout: `${HEAD}\n` },
        { match: '^ls-remote --tags origin refs/tags/v1\\.2\\.0$', stdout: `${HEAD}\trefs/tags/v1.2.0\n` },
      ],
      gh: [{ match: '^release view ', status: 0 }],
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Step 1: v1\.2\.0 already points at HEAD — skipping retag\./);
  assert.match(r.stdout, /Step 2: v1\.2\.0 already pushed to origin — skipping\./);
  assert.match(r.stdout, /Step 4: GitHub release v1\.2\.0 already exists — skipping\./);
  assert.match(r.stdout, /re-pin manually before the next rc cycle:\n {6}node --experimental-strip-types scripts\/publish-rc-channel\.ts --stable-repin 1\.2\.0\n/);
  assert.ok(!ran(r, /^git (tag|push)/));
});

test('release.ts fails the canary when the docker build fails (exit 1)', (t) => {
  const f = fixture(t);
  const r = release(f, {
    input: 'y\ny\nn\ny\n',
    rules: {
      git: [{ match: '^clone --quiet --depth 1 --branch v1\\.2\\.0 ', copyTo: f.catalogDir }],
      docker: [{ match: '^build ', status: 1 }],
    },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /⚠️ {2}CANARY FAILED — published v1\.2\.0 does NOT install cleanly!/);
  assert.ok(ran(r, /^docker build -f tests\/l0-install\/install-smoke\.Dockerfile -t tmb-canary-1\.2\.0 --no-cache --quiet \.$/));
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('release.ts passes the canary when the docker build succeeds', (t) => {
  const f = fixture(t);
  const r = release(f, {
    input: 'y\ny\nn\ny\nn\n',
    rules: { git: [{ match: '^clone --quiet --depth 1 --branch v1\\.2\\.0 ', copyTo: f.catalogDir }] },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ Canary PASSED — published v1\.2\.0 installs cleanly from a fresh clone/);
});

test('release.ts warns and continues when the step-6 re-pin fails', (t) => {
  const f = fixture(t);
  const r = release(f, {
    input: 'y\ny\nn\nn\ny\n',
    rules: { git: [{ match: `^ls-remote --tags ${esc(PLUGIN_REPO)} refs/tags/v1\\.2\\.0$`, stdout: '' }] },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /⚠️ {2}rc-channel re-pin FAILED — v1\.2\.0 is already public\.\n.*\n {7}node --experimental-strip-types scripts\/publish-rc-channel\.ts --stable-repin 1\.2\.0\n/);
});

// ---------- publish-rc-channel.ts behaviour ----------

const RC = { version: '1.2.0-rc.1', catalog: { ref: 'payload/v1.1.0-rc.1', readme: false } };

test('publish-rc-channel.ts refuses a non-rc version (exit 1)', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { args: ['1.2.0'] });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(
    r.stderr,
    "❌ Refusing to publish. Version '1.2.0' is not an rc version.\n   The rc channel only serves rc tags (e.g. 0.10.0-rc.2).\n   For a stable tag, re-pin the rc channel with --stable-repin.\n",
  );
  assert.deepEqual(r.calls, []);
});

test('publish-rc-channel.ts --stable-repin refuses an rc version (exit 1)', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { args: ['--stable-repin', '1.2.0-rc.1'] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Refusing to re-pin\. Version '1\.2\.0-rc\.1' is not a stable version\./);
  assert.deepEqual(r.calls, []);
});

test('publish-rc-channel.ts refuses an unknown flag and a second version (exit 1)', (t) => {
  const f = fixture(t, RC);
  const flag = publish(f, { args: ['--bogus'] });
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /❌ Unknown flag: --bogus\n {3}Usage: node --experimental-strip-types scripts\/publish-rc-channel\.ts \[version\]/);
  const two = publish(f, { args: ['1.2.0-rc.1', '1.2.0-rc.2'] });
  assert.equal(two.status, 1);
  assert.equal(two.stderr, '❌ Multiple versions given: 1.2.0-rc.1 and 1.2.0-rc.2\n');
});

test('publish-rc-channel.ts refuses a tag that is not on origin (exit 1)', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { rules: { git: [{ match: `^ls-remote --tags ${esc(PLUGIN_REPO)} refs/tags/v1\\.2\\.0-rc\\.1$`, stdout: '' }] } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ Refusing to publish\. Tag v1\.2\.0-rc\.1 is not on origin\.\n {3}Push the rc tag first \(scripts\/release\.ts tags \+ pushes it\),/);
  assert.ok(!ran(r, /^gh /));
});

for (const [name, run, code] of [
  ['concluded failure', '[{"status":"completed","conclusion":"failure","url":"u"}]', 3],
  ['found no run', '', 2],
  ['is still in progress at the timeout', '[{"status":"in_progress","url":"u"}]', 4],
]) {
  test(`publish-rc-channel.ts refuses when the release gate ${name} (exit ${code}), before the payload wait and the clone`, (t) => {
    const f = fixture(t, RC);
    const r = publish(f, { rules: { gh: [{ match: '^run list ', stdout: run }] } });
    assert.equal(r.status, code, r.stderr);
    assert.match(r.stdout, /^Checking the release-gate run for v1\.2\.0-rc\.1 \.\.\.\n/);
    assert.ok(!ran(r, /refs\/tags\/payload\//));
    assert.ok(!ran(r, /^git clone/));
  });
}

test('publish-rc-channel.ts refuses when payload/<tag> never reaches origin (await-payload-tag exit 4)', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { args: ['--dry-run'], rules: { git: [{ match: 'refs/tags/payload/', stdout: '' }] } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /❌ await-payload-tag: payload\/v1\.2\.0-rc\.1 is still not on https:\/\/github\.com\/trustmybot\/plugin\.git after 0s\./);
  assert.ok(indexOf(r, /^gh run list /) < indexOf(r, /refs\/tags\/payload\//));
  assert.ok(!ran(r, /^git clone/));
});

test('publish-rc-channel.ts refuses a catalog with no marketplace.json (exit 1) and removes the temp clone', (t) => {
  const f = fixture(t, { ...RC, catalog: { json: false } });
  const r = publish(f, { args: ['--yes'] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /❌ https:\/\/github\.com\/trustmybot\/marketplace-rc\.git has no \.claude-plugin\/marketplace\.json — unexpected catalog layout\./);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('publish-rc-channel.ts exits with git status when the clone fails', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { args: ['--yes'], rules: { git: [{ match: '^clone ', status: 128 }] } });
  assert.equal(r.status, 128, r.stderr);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('publish-rc-channel.ts exits 0 with nothing to do when already published', (t) => {
  const f = fixture(t, { ...RC, catalog: { ref: 'payload/v1.2.0-rc.1', readme: true } });
  const r = publish(f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ Already published — ref is payload\/v1\.2\.0-rc\.1 and README\.md is present\. Nothing to do\.\n$/);
  assert.ok(!ran(r, /^git -C /));
});

test('publish-rc-channel.ts --dry-run shows the plan and never commits or pushes', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { args: ['--dry-run'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /source\.ref: {4}payload\/v1\.1\.0-rc\.1 → payload\/v1\.2\.0-rc\.1\n {2}README\.md: {5}create \(was missing\)/);
  assert.match(r.stdout, /✓ --dry-run: would set ref to payload\/v1\.2\.0-rc\.1 and create README\.md\. No commit, no push\.\n$/);
  assert.ok(ran(r, /^git -C .* --no-pager diff$/));
  assert.ok(!ran(r, /^git -C .* (add|commit|push)/));
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('publish-rc-channel.ts aborts when the push is declined (exit 1)', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { input: 'n\n' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /Commit and push this to marketplace-rc main\? \[y\/N\] Aborted — no changes pushed\.\n$/);
  assert.ok(!ran(r, /^git -C .* (add|commit|push)/));
});

test('publish-rc-channel.ts pins payload/<tag>, writes the README and pushes after a yes', (t) => {
  const f = fixture(t, RC);
  const snapshot = join(f.dir, 'pushed');
  const r = publish(f, { input: 'y\n', rules: { git: [{ match: '^-C .* push origin main$', snapshot }] } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ Published v1\.2\.0-rc\.1 to the rc channel\.\n {2}Installs of tmb@trustmybot-rc now serve v1\.2\.0-rc\.1 \(payload\/v1\.2\.0-rc\.1\)\.\n$/);
  const pinned = JSON.parse(readFileSync(join(snapshot, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(pinned.plugins[0].source.ref, 'payload/v1.2.0-rc.1');
  assert.equal(pinned.plugins[0].source.repo, 'trustmybot/plugin');
  assert.match(readFileSync(join(snapshot, 'README.md'), 'utf8'), /^# TMB plugin marketplace — RC\n/);
  const order = [/^gh run list .*--branch v1\.2\.0-rc\.1 /, /refs\/tags\/payload\/v1\.2\.0-rc\.1/, /^git clone /, /^git -C .* add \.claude-plugin\/marketplace\.json README\.md$/, /^git -C .* commit -m 🚀 chore\(rc\): publish v1\.2\.0-rc\.1 to the rc channel$/, /^git -C .* push origin main$/];
  const idx = order.map((re) => indexOf(r, re));
  assert.ok(idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1])), r.lines.join('\n'));
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('publish-rc-channel.ts exits with git status when the push fails', (t) => {
  const f = fixture(t, RC);
  const r = publish(f, { args: ['--yes'], rules: { git: [{ match: '^-C .* push origin main$', status: 7 }] } });
  assert.equal(r.status, 7, r.stderr);
  assert.doesNotMatch(r.stdout, /Published/);
  assert.deepEqual(readdirSync(f.tmp), []);
});

test('publish-rc-channel.ts --stable-repin accepts a leading v and skips the gate', (t) => {
  const f = fixture(t, { version: '1.2.0', catalog: { ref: 'payload/v1.2.0-rc.2', readme: true } });
  const r = publish(f, { args: ['--stable-repin', '--yes', 'v1.2.0'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Re-pinning the rc channel to the stable tag v1\.2\.0 \(no gate — gated at its rc\) \.\.\.\n/);
  assert.ok(!ran(r, /^gh /));
  assert.ok(ran(r, /^git -C .* push origin main$/));
});
