// L1 lint: keeps prompts independent of the session working directory. A subagent inherits bro's cwd and bro's cwd can sit in a subdir or a worktree, so a prompt names every project path and every branch-moving git command explicitly. Flags, in agents/*.md, commands/*.md and every *.md under skills/*/: a relative `.claude/` path (one not preceded by `<placeholder>/` such as `<project>/`, `<repo path>/`, `<worktree_path>/`, or by `~/` or `$HOME/`), and `git push`, `git switch`, `git checkout` or `git pull` with no `-C <dir>`. scan(root) checks the plugin tree at root; the cases below plant prompts through it.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ANCHORS = ['~/', '$HOME/', '${HOME}/'];
const BARE_GIT = /(^|[^A-Za-z0-9_-])git\s+(push|switch|checkout|pull)([^A-Za-z0-9_-]|$)/;

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function markdown(dir, depth, minDepth, maxDepth, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (depth >= minDepth && e.name.endsWith('.md') && !e.isDirectory()) out.push(path);
    if (e.isDirectory() && depth < maxDepth) markdown(path, depth + 1, minDepth, maxDepth, out);
  }
}

function anchored(before) {
  if (ANCHORS.some((a) => before.endsWith(a))) return true;
  if (!before.endsWith('>/')) return false;
  const inner = before.slice(0, -2);
  const open = inner.lastIndexOf('<');
  return open >= 0 && open < inner.length - 1 && !inner.slice(open + 1).includes('>');
}

function bareClaude(line) {
  for (let i = line.indexOf('.claude/'); i >= 0; i = line.indexOf('.claude/', i + 1)) {
    if (!anchored(line.slice(0, i))) return true;
  }
  return false;
}

function prompts(root) {
  const out = [];
  for (const d of ['agents', 'commands']) {
    if (isDir(join(root, d))) markdown(join(root, d), 1, 1, 1, out);
  }
  if (isDir(join(root, 'skills'))) markdown(join(root, 'skills'), 1, 2, Infinity, out);
  return out.sort();
}

export function scan(root = ROOT) {
  const out = [];
  for (const f of prompts(root)) {
    const rel = f.slice(root.length + 1);
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (bareClaude(line)) {
        out.push(`${rel}:${i + 1}: relative .claude/ path — anchor it as <project>/.claude/...`);
      }
    });
    lines.forEach((line, i) => {
      if (BARE_GIT.test(line)) out.push(`${rel}:${i + 1}: git command without -C — use git -C <repo path> ...`);
    });
  }
  return { ok: out.length === 0, out: out.join('\n') };
}

test('explicit paths and git -C in prompts', () => {
  const r = scan();
  assert.ok(r.ok, `${r.out}\n\nprompt-explicit-paths: FAIL`);
});

describe('planted prompts', () => {
  let tmp;
  before(() => {
    tmp = mkdtempSync(join((process.env.TMPDIR || tmpdir()).replace(/\/+$/, ''), 'tmb-prompt-explicit-paths.'));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function plant(name, rel, line) {
    const root = join(tmp, name);
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), `---\nname: x\n---\n\n${line}\n`);
    return root;
  }

  for (const [label, name, rel, line, phrase] of [
    ['a relative .claude/ path in a command', 'rel-claude', 'commands/x.md', 'Write the file to `.claude/x`.', 'commands/x.md:5: relative .claude/ path'],
    ['an anchored and a bare .claude/ path on one line', 'mixed-claude', 'commands/x.md', 'Copy `<project>/.claude/x` to `.claude/y`.', 'commands/x.md:5: relative .claude/ path'],
    ['a bare git push in a skill', 'bare-push', 'skills/tmb_x/SKILL.md', 'Then `git push origin <feature>`.', 'skills/tmb_x/SKILL.md:5: git command without -C'],
    ['bare git switch, checkout and pull in an agent', 'bare-verbs', 'agents/a.md', 'Run `git switch dev`, `git checkout -b x` and `git pull --ff-only`.', 'agents/a.md:5: git command without -C'],
  ]) {
    test(`fails on ${label}, naming the file and line`, () => {
      const r = scan(plant(name, rel, line));
      assert.equal(r.ok, false, r.out);
      assert.ok(r.out.includes(phrase), r.out);
    });
  }

  for (const [label, name, rel, line] of [
    ['<project>/.claude/x, ~/.claude/y and $HOME/.claude/z', 'anchored-claude', 'commands/x.md', 'Write the file to `<project>/.claude/x`, `~/.claude/y` or `$HOME/.claude/z`.'],
    ['git -C <repo path> push and pull', 'anchored-push', 'skills/tmb_x/SKILL.md', 'Then `git -C <repo path> push origin <feature>` and `git -C <repo path> pull --ff-only`.'],
  ]) {
    test(`passes ${label}`, () => {
      const r = scan(plant(name, rel, line));
      assert.ok(r.ok, r.out);
    });
  }
});
