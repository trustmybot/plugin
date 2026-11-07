// L1 lint: every script a hooks/hooks.json command runs is tracked with git mode 100755 (CC execs hook commands directly, so a 644 hook never fires); a router command's built, git-ignored bundle must be on disk, a hand-written one only tracked.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTER_RE = /(^|[;&|\s])node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/;
const PREFIX = '${CLAUDE_PLUGIN_ROOT}/';

function hookCommands(root) {
  const { hooks } = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'));
  const cmds = Object.values(hooks ?? {})
    .flatMap((groups) => (Array.isArray(groups) ? groups : []))
    .flatMap((group) => group?.hooks ?? [])
    .map((h) => h?.command)
    .filter((c) => typeof c === 'string' && c !== '');
  return [...new Set(cmds)].sort();
}

function gitIgnored(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function gitMode(root, rel) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-s', '--', rel], { encoding: 'utf8' });
  return out.split(/\s/)[0] || '';
}

export function hookProblems(root) {
  const problems = [];
  let checked = 0;
  for (const cmd of hookCommands(root)) {
    const router = ROUTER_RE.exec(cmd);
    if (router) {
      const rel = router[2];
      checked += 1;
      if (gitIgnored(root, rel)) {
        if (!(existsSync(join(root, rel)) && statSync(join(root, rel)).isFile())) {
          problems.push(`hooks-executable: MISSING built bundle (run bun run build:payload): ${rel}`);
        }
      } else if (gitMode(root, rel) === '') {
        problems.push(`hooks-executable: MISSING from git: ${rel}`);
      }
      continue;
    }
    const quoted = cmd.startsWith('"');
    const unquoted = quoted ? cmd.slice(1) : cmd;
    if (!unquoted.startsWith(PREFIX)) continue;
    const rest = unquoted.slice(PREFIX.length);
    const rel = rest.split(quoted ? '"' : ' ')[0];
    checked += 1;
    const mode = gitMode(root, rel);
    if (mode === '') problems.push(`hooks-executable: MISSING from git: ${rel}`);
    else if (mode !== '100755') problems.push(`hooks-executable: not executable (mode ${mode}): ${rel}`);
  }
  if (checked === 0) problems.push('hooks-executable: parsed 0 commands — jq path wrong?');
  return { checked, problems };
}

function hookRepo(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-hooks-executable-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  mkdirSync(join(dir, 'hooks'));
  const hooks = { PreToolUse: [{ hooks: commands.map((command) => ({ type: 'command', command })) }] };
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
  return dir;
}

test('a 644 hook script, an untracked one and a missing built bundle are each caught', () => {
  const dir = hookRepo([
    '"${CLAUDE_PLUGIN_ROOT}/scripts/plain.sh" arg',
    '${CLAUDE_PLUGIN_ROOT}/scripts/exec.sh arg',
    '${CLAUDE_PLUGIN_ROOT}/scripts/untracked.sh',
    'node "${CLAUDE_PLUGIN_ROOT}/dist/hooks.js" PreToolUse',
    'echo not a plugin script',
  ]);
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, '.gitignore'), 'dist/\n');
    writeFileSync(join(dir, 'scripts', 'plain.sh'), '#!/bin/sh\n', { mode: 0o644 });
    writeFileSync(join(dir, 'scripts', 'exec.sh'), '#!/bin/sh\n', { mode: 0o755 });
    execFileSync('git', ['-C', dir, 'add', 'scripts/plain.sh', 'scripts/exec.sh']);
    execFileSync('git', ['-C', dir, 'update-index', '--chmod=-x', 'scripts/plain.sh']);
    execFileSync('git', ['-C', dir, 'update-index', '--chmod=+x', 'scripts/exec.sh']);
    const { checked, problems } = hookProblems(dir);
    assert.equal(checked, 4);
    assert.deepEqual(problems.sort(), [
      'hooks-executable: MISSING built bundle (run bun run build:payload): dist/hooks.js',
      'hooks-executable: MISSING from git: scripts/untracked.sh',
      'hooks-executable: not executable (mode 100644): scripts/plain.sh',
    ]);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'hooks.js'), 'export {};\n');
    assert.equal(hookProblems(dir).problems.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a hooks.json with no commands fails', () => {
  const dir = hookRepo([]);
  try {
    assert.deepEqual(hookProblems(dir), { checked: 0, problems: ['hooks-executable: parsed 0 commands — jq path wrong?'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every hooks.json command runs an executable or built script', () => {
  const { problems } = hookProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.join('\n')}\nhooks-executable: FAIL`);
});
