// L1 lint: validate the shape of the Claude package manifests — typos, missing required fields and structural drift in .claude-plugin/plugin.json, .mcp.json and hooks/hooks.json. When the claude CLI is on PATH and neither TMB_FORBID_LIVE_SYNC nor TMB_L1_OFFLINE is set, it also runs `claude plugin validate --strict` on a `git archive HEAD` export of the plugin root and fails on any warning or error outside STRICT_ACCEPTED. run-all.ts runs L1 with TMB_L1_OFFLINE=1, so the hermetic suite skips it.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const MCP_MANIFEST = '.mcp.json';
const HOOKS_MANIFEST = 'hooks/hooks.json';

// Findings awaiting a Human-owned or prompt-surface change, one "<path relative to the plugin root>|<message prefix>" each.
const STRICT_ACCEPTED = [
  'CLAUDE.md|root: CLAUDE.md at the plugin root is not loaded as project context.',
  'commands/README.md|frontmatter: No frontmatter block found.',
];

const isFile = (rel, root = ROOT) => existsSync(resolve(root, rel)) && statSync(resolve(root, rel)).isFile();
const empty = (v) => v === undefined || v === null || v === false || v === '';

function readJson(rel, root = ROOT) {
  try {
    const v = JSON.parse(readFileSync(join(root, rel), 'utf8'));
    return v === null || v === false ? undefined : v;
  } catch {
    return undefined;
  }
}

function report(t, failures, okMessage) {
  assert.deepEqual(failures, [], `Manifest shape: FAIL\n${failures.map((f) => `  ✗ ${f}`).join('\n')}`);
  t.diagnostic(`✓ ${okMessage}`);
}

export function pluginManifestFailures(root) {
  const m = readJson(PLUGIN_MANIFEST, root);
  const failures = [];
  if (m === undefined) failures.push(`${PLUGIN_MANIFEST} is not valid JSON`);
  else {
    for (const field of ['name', 'version', 'description', 'author', 'license', 'repository']) {
      if (empty(m[field])) failures.push(`${PLUGIN_MANIFEST} missing required field: ${field}`);
    }
    const ver = typeof m.version === 'string' ? m.version : JSON.stringify(m.version ?? null);
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(ver)) {
      failures.push(`${PLUGIN_MANIFEST} .version '${ver}' is not a valid semver (X.Y.Z or X.Y.Z-<pre>)`);
    }
  }
  return failures;
}

test(`${PLUGIN_MANIFEST} has all required fields and a valid semver`, (t) => {
  report(t, pluginManifestFailures(ROOT), `${PLUGIN_MANIFEST} has all required fields and a valid semver`);
});

test(`${MCP_MANIFEST} has MCP servers, all with command + args`, (t) => {
  const m = readJson(MCP_MANIFEST);
  const failures = [];
  if (m === undefined) failures.push(`${MCP_MANIFEST} is not valid JSON`);
  else if (empty(m.mcpServers)) failures.push(`${MCP_MANIFEST} missing .mcpServers`);
  else {
    const servers = Object.keys(m.mcpServers);
    if (servers.length < 1) failures.push(`${MCP_MANIFEST} .mcpServers is empty`);
    for (const s of servers.sort()) {
      if (empty(m.mcpServers[s]?.command)) failures.push(`${MCP_MANIFEST} .mcpServers.${s}.command is missing`);
      if (empty(m.mcpServers[s]?.args)) failures.push(`${MCP_MANIFEST} .mcpServers.${s}.args is missing`);
    }
  }
  report(t, failures, `${MCP_MANIFEST} has its MCP server(s), all with command + args`);
});

function commands(v, out) {
  if (Array.isArray(v)) v.forEach((x) => commands(x, out));
  else if (v && typeof v === 'object') {
    if (typeof v.command === 'string') out.push(v.command);
    Object.values(v).forEach((x) => commands(x, out));
  }
  return out;
}

export function hooksManifestFailures(root) {
  const failures = [];
  const m = isFile(HOOKS_MANIFEST, root) ? readJson(HOOKS_MANIFEST, root) : null;
  if (m === null) failures.push(`${HOOKS_MANIFEST} does not exist`);
  else if (m === undefined) failures.push(`${HOOKS_MANIFEST} is not valid JSON`);
  else if (empty(m.hooks)) failures.push(`${HOOKS_MANIFEST} missing .hooks`);
  else {
    for (const script of commands(m, [])) {
      const r = /\$\{?CLAUDE_PLUGIN_ROOT\}?\/([^" ]+)/.exec(script);
      let local = r ? `./${r[1]}` : script.replace(/^node /, '');
      local = local.startsWith('"') ? local.slice(1).split('"')[0] : local.split(' ')[0];
      if (!isFile(local, root)) failures.push(`${HOOKS_MANIFEST} references missing script: ${script} (resolved: ${local})`);
    }
  }
  return failures;
}

test(`${HOOKS_MANIFEST} is valid + all referenced scripts exist`, (t) => {
  report(t, hooksManifestFailures(ROOT), `${HOOKS_MANIFEST} is valid + all referenced scripts exist`);
});

test('a broken plugin.json and a hooks.json naming a missing script are caught', () => {
  const tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-manifest-shape.'));
  try {
    mkdirSync(join(tmp, '.claude-plugin'));
    mkdirSync(join(tmp, 'hooks'));
    writeFileSync(join(tmp, PLUGIN_MANIFEST), JSON.stringify({ name: 'tmb', version: '1.2', description: 'd', author: { name: 'a' }, repository: 'r' }));
    writeFileSync(
      join(tmp, HOOKS_MANIFEST),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gone.mjs"' }] }] } }),
    );
    assert.deepEqual(pluginManifestFailures(tmp), [
      `${PLUGIN_MANIFEST} missing required field: license`,
      `${PLUGIN_MANIFEST} .version '1.2' is not a valid semver (X.Y.Z or X.Y.Z-<pre>)`,
    ]);
    assert.deepEqual(hooksManifestFailures(tmp), [
      `${HOOKS_MANIFEST} references missing script: node "\${CLAUDE_PLUGIN_ROOT}/scripts/gone.mjs" (resolved: ./scripts/gone.mjs)`,
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function onPath(cmd) {
  return (process.env.PATH ?? '').split(delimiter).some((d) => {
    try {
      return d !== '' && statSync(join(d, cmd)).isFile() && (statSync(join(d, cmd)).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}

export function strictFindings(output, root) {
  const out = [];
  let f = '';
  let notes = false;
  for (const line of output.split('\n')) {
    const v = /^Validating [^:]+: (.*)$/.exec(line);
    if (v) {
      f = v[1].startsWith(`${root}/`) ? v[1].slice(root.length + 1) : v[1];
      notes = false;
      continue;
    }
    if (/^\s*About these checks:?\s*$/.test(line) || /^\s*These plugin directory checks do not change the result/.test(line)) notes = true;
    if (notes) continue;
    const m = /^\s*❯ (.*)$/.exec(line);
    if (m) out.push(`${f}|${m[1]}`);
  }
  return out;
}

export const strictUnaccepted = (findings) => findings.filter((f) => !STRICT_ACCEPTED.some((a) => f.startsWith(a)));

test('strict-validate parsing keeps accepted findings out and reports the rest', () => {
  const out = [
    'Validating plugin manifest: /r/.claude-plugin/plugin.json',
    '  ❯ icon: No icon (ICON_MISSING).',
    'Validating file: /r/CLAUDE.md',
    '  ❯ root: CLAUDE.md at the plugin root is not loaded as project context. More text.',
  ].join('\n');
  const findings = strictFindings(out, '/r');
  assert.deepEqual(findings, [
    '.claude-plugin/plugin.json|icon: No icon (ICON_MISSING).',
    'CLAUDE.md|root: CLAUDE.md at the plugin root is not loaded as project context. More text.',
  ]);
  assert.deepEqual(strictUnaccepted(findings), ['.claude-plugin/plugin.json|icon: No icon (ICON_MISSING).']);
});

test('strict-validate parsing skips the CLI notes after the About these checks heading', () => {
  const out = [
    'Validating command: /r/commands/x.md',
    '  ❯ frontmatter: Bad key (FRONTMATTER_KEY).',
    'Plugin directory checks for /r. The plugin directory is the catalog that plugins are submitted to.',
    'About these checks:',
    '  ❯ This folder also holds a marketplace manifest. The plugin directory treats such a folder as a plugin.',
    'These plugin directory checks do not change the result of this command.',
    '  ❯ Another informational note.',
  ].join('\n');
  assert.deepEqual(strictFindings(out, '/r'), ['commands/x.md|frontmatter: Bad key (FRONTMATTER_KEY).']);
});

test('claude plugin validate --strict reports no finding outside STRICT_ACCEPTED', (t) => {
  if (!onPath('claude') || process.env.TMB_FORBID_LIVE_SYNC || process.env.TMB_L1_OFFLINE) {
    t.skip('manifest-shape: claude CLI absent or TMB_FORBID_LIVE_SYNC / TMB_L1_OFFLINE set — strict validate skipped');
    return;
  }
  // The CLI writes .claude.json under its config dir; a throwaway one keeps the Human's untouched.
  const home = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-manifest-shape.'));
  const tree = join(home, 'tree');
  let output;
  let rc;
  try {
    mkdirSync(tree);
    const exported = spawnSync('bash', ['-c', 'set -o pipefail; git -C "$1" archive HEAD | tar -x -C "$2"', 'export', ROOT, tree], { encoding: 'utf8' });
    assert.equal(exported.status, 0, `git archive HEAD export failed: ${exported.stderr}`);
    const log = join(home, 'validate.log');
    const fd = openSync(log, 'w');
    try {
      rc = spawnSync('claude', ['plugin', 'validate', '--strict', tree], {
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
        stdio: ['ignore', fd, fd],
      }).status;
    } finally {
      closeSync(fd);
    }
    output = readFileSync(log, 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const findings = strictFindings(output, tree);
  const unexpected = strictUnaccepted(findings);
  assert.deepEqual(unexpected, [], `Manifest shape: FAIL\n${unexpected.map((f) => `  ✗ strict validate: ${f}`).join('\n')}`);
  assert.ok(
    rc === 0 || findings.length > 0,
    `claude plugin validate --strict exited ${rc} with no parsed finding: ${output.replace(/\n$/, '').split('\n').slice(-3).join('\n')}`,
  );
});
