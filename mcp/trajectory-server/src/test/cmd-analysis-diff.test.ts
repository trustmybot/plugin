/**
 * The TypeScript write-path analyzer against tmb_cmd_write_paths (GH 1692):
 * every corpus row of tests/fixtures/cmd-analysis/write-paths.jsonl runs
 * through one bash process that sources cmd-analysis.sh once, and through
 * writePaths. A non-deferred row prints the same lines; a row in
 * divergences.jsonl still differs exactly as recorded; a deferred row prints
 * an `UNRESOLVED:$(deferred):` line. Layout rows also compare
 * tmb_path_canonical with pathCanonical on every absolute line.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathCanonical, writePaths } from '../hooks/cmd-analysis/index.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURES = join(PLUGIN_ROOT, 'tests/fixtures/cmd-analysis');
const LIB = join(PLUGIN_ROOT, 'scripts/hooks/lib/cmd-analysis.sh');
const MIN_NON_DEFERRED = 300;
const DEFERRED = 'UNRESOLVED:$(deferred):';
const PARSE = 'UNRESOLVED:$(parse):';
const LAYOUT = 'repo-worktree-symlink';

interface Row {
  cmd: string;
  cwd?: string;
  raw?: boolean;
  root?: string;
  tag?: string;
  layout?: string;
}

interface Divergence {
  cmd: string;
  sh: string[];
  ts: string[];
  reason: string;
}

interface ShResult {
  lines: string[];
  canonical: string[];
}

function jsonl<T>(file: string): T[] {
  return readFileSync(join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as T);
}

function lines(text: string): string[] {
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function makeLayout(tmp: string): void {
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'layout\n');
  git(repo, 'add', 'README.md');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', join(tmp, 'wt'), '-b', 'wt');
  symlinkSync(repo, join(tmp, 'link'));
}

const SCRIPT = `. "$1"
while IFS= read -r -d '' c && IFS= read -r -d '' w && IFS= read -r -d '' r && IFS= read -r -d '' t && IFS= read -r -d '' k; do
  ( tmb_cmd_write_paths "$c" "$w" "$r" "$t" ) </dev/null
  printf '\\0'
  if [ -n "$k" ]; then
    ( tmb_cmd_write_paths "$c" "$w" "$r" "$t" ) </dev/null | while IFS= read -r l; do
      case "$l" in /*) tmb_path_canonical "$l" ;; esac
    done
  fi
  printf '\\0'
done`;

describe('TS write-path analyzer vs cmd-analysis.sh (GH 1692)', () => {
  const rows = jsonl<Row>('write-paths.jsonl');
  const divergences = new Map(jsonl<Divergence>('divergences.jsonl').map((d) => [d.cmd, d]));
  let tmp = '';
  let env: NodeJS.ProcessEnv = {};
  let sh: ShResult[] = [];
  const sub = (s: string | undefined): string => (s ?? '').replace(/\$TMP(?![A-Za-z0-9_])/g, tmp);
  const back = (l: string): string => l.split(tmp).join('$TMP');
  const ts = (r: Row): Promise<string[]> =>
    writePaths(sub(r.cmd), { cwd: sub(r.cwd), raw: r.raw === true, root: sub(r.root), env });

  before(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cmd-analysis-diff-')));
    for (const d of ['home', 'tmpdir', 'project', 'models']) mkdirSync(join(tmp, d));
    makeLayout(tmp);
    env = {
      PATH: process.env.PATH,
      HOME: join(tmp, 'home'),
      TMPDIR: `${join(tmp, 'tmpdir')}/`,
      CLAUDE_PROJECT_DIR: join(tmp, 'project'),
      TMB_MODEL_CACHE_DIR: join(tmp, 'models'),
      LC_ALL: 'C',
    };
    const input = rows
      .map((r) => [sub(r.cmd), sub(r.cwd), r.raw ? 'raw' : '', sub(r.root), r.layout ? 'canon' : ''].join('\0') + '\0')
      .join('');
    const res = spawnSync('bash', ['-c', SCRIPT, 'bash', LIB], { input, env, maxBuffer: 1 << 28 });
    assert.equal(res.status, 0, res.stderr.toString());
    const chunks = res.stdout.toString('utf8').split('\0');
    sh = rows.map((_, i) => ({ lines: lines(chunks[2 * i]!), canonical: lines(chunks[2 * i + 1]!) }));
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it(`has at least ${MIN_NON_DEFERRED} non-deferred rows, each in the corpus once`, () => {
    const keys = rows.map((r) => JSON.stringify([r.cmd, r.cwd ?? '', r.raw === true, r.root ?? '']));
    assert.equal(new Set(keys).size, rows.length);
    assert.ok(rows.filter((r) => r.tag !== 'deferred').length >= MIN_NON_DEFERRED);
  });

  it('prints the same lines as tmb_cmd_write_paths on every non-deferred row', async () => {
    const mismatches: string[] = [];
    let same = 0;
    for (const [i, r] of rows.entries()) {
      if (r.tag === 'deferred' || divergences.has(r.cmd)) continue;
      const got = await ts(r);
      if (JSON.stringify(got) === JSON.stringify(sh[i]!.lines)) same++;
      else mismatches.push(`${JSON.stringify(r)}\n  sh: ${JSON.stringify(sh[i]!.lines.map(back))}\n  ts: ${JSON.stringify(got.map(back))}`);
    }
    assert.deepEqual(mismatches, []);
    assert.ok(same >= MIN_NON_DEFERRED);
  });

  it('still diverges exactly as divergences.jsonl records, each with a reason', async () => {
    for (const d of divergences.values()) {
      assert.ok(d.reason.trim() !== '', `no reason for ${JSON.stringify(d.cmd)}`);
      const i = rows.findIndex((r) => r.cmd === d.cmd);
      assert.ok(i >= 0, `divergence not in the corpus: ${JSON.stringify(d.cmd)}`);
      assert.deepEqual(sh[i]!.lines.map(back), d.sh, `sh for ${JSON.stringify(d.cmd)}`);
      assert.deepEqual((await ts(rows[i]!)).map(back), d.ts, `ts for ${JSON.stringify(d.cmd)}`);
    }
  });

  it('prints a deferred line on every deferred row', async () => {
    const missing: string[] = [];
    for (const r of rows.filter((x) => x.tag === 'deferred')) {
      if (!(await ts(r)).some((l) => l.startsWith(DEFERRED))) missing.push(r.cmd);
    }
    assert.deepEqual(missing, []);
  });

  it('canonicalizes every absolute line of a layout row as tmb_path_canonical does', async () => {
    const layoutRows = rows.flatMap((r, i) => (r.layout === LAYOUT ? [i] : []));
    assert.ok(layoutRows.length > 0);
    for (const i of layoutRows) {
      const got = (await ts(rows[i]!)).filter((l) => l.startsWith('/')).map(pathCanonical);
      assert.deepEqual(got, sh[i]!.canonical, JSON.stringify(rows[i]));
    }
  });

  it('follows a symlinked prefix and keeps the missing tail', () => {
    assert.equal(pathCanonical(join(tmp, 'link/missing/../file')), join(tmp, 'repo/file'));
    assert.equal(pathCanonical('relative/x'), 'relative/x');
    if (process.platform === 'darwin') assert.equal(pathCanonical('/tmp/x'), '/private/tmp/x');
  });

  describe('deferred shapes', () => {
    const shapes: Array<[string, string]> = [
      ['python -c', `python -c "open('a.txt','w')"`],
      ['node -e', `node -e "require('fs').writeFileSync('n.txt','x')"`],
      ['a heredoc to python3', `python3 <<'EOF'\nopen('hd.txt','w')\nEOF`],
      ['find -exec', `find . -name '*.tmp' -exec rm {} \\;`],
      ['find -delete', 'find . -type f -delete'],
      ['xargs', 'ls | xargs rm'],
      ['for f in $(find …)', `for f in $(find . -name '*.md'); do rm "$f"; done`],
      ['… | while read f', `find . -name '*.sh' | while read f; do chmod +x "$f"; done`],
    ];
    for (const [name, cmd] of shapes) {
      it(`${name} prints a deferred line`, async () => {
        const out = await writePaths(cmd, { cwd: '/w/repo', root: '/w/repo', env: { PATH: process.env.PATH } });
        assert.ok(out.some((l) => l.startsWith(DEFERRED)), JSON.stringify(out));
      });
    }
  });

  describe('parse errors', () => {
    for (const [name, cmd] of [
      ['an unclosed quote', 'echo "abc > out.txt'],
      ['an unclosed $(', 'echo $(ls > out.txt'],
    ]) {
      it(`${name} prints exactly one parse line`, async () => {
        const out = await writePaths(cmd!, { cwd: '/w/repo', env: { PATH: process.env.PATH } });
        assert.equal(out.length, 1);
        assert.equal(out[0], `${PARSE}${cmd}`);
      });
    }

    it('keeps the first 80 characters of the command', async () => {
      const cmd = `echo "${'x'.repeat(200)}`;
      const out = await writePaths(cmd, { cwd: '/w/repo', env: { PATH: process.env.PATH } });
      assert.deepEqual(out, [`${PARSE}${cmd.slice(0, 80)}`]);
    });
  });
});
