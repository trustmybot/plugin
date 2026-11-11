/**
 * The leak scan (GH 2929) on real git diffs: only the lines base..commit adds are scanned, a hit
 * names its file, line and rule but never the matched text, the built-in allowlist and the
 * project's .config/tmb/leak-scan.json at the commit admit hits, and an invalid file, a git
 * failure or an inline secretlint-disable comment never lets a hit through.
 * The leaked values are assembled at run time so this file's own lines hold none of them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LEAK_SCAN_FILE, leakScan } from '../hooks/lib/leak-scan.js';

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const GITHUB_TOKEN = ['ghp', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5'].join('_');
const ALICE_EMAIL = ['alice', 'corp.io'].join('@');
const ALICE_HOME = ['', 'Users', 'alice', 'x'].join('/');
const GITHUB_RULE = '@secretlint/secretlint-rule-github';

interface Repo {
  base: string;
  write(path: string, text: string | Buffer): void;
  commit(): string;
  git(...args: string[]): string;
  scan(head?: string): ReturnType<typeof leakScan>;
}

let sandbox: string;
let seq = 0;
before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-leak-scan-')));
});
after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A repo whose base commit holds <files>, checked out on a feature branch. */
function repo(files: Record<string, string> = { 'README.md': 'Hello.\n' }): Repo {
  seq += 1;
  const dir = join(sandbox, `repo-${seq}`);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim();
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'c', '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  for (const [path, text] of Object.entries(files)) write(path, text);
  const base = commit();
  git('checkout', '-q', '-b', 'feat');
  const scan = (head = git('rev-parse', 'HEAD')) => leakScan(dir, base, head, GIT_ENV);
  return { base, write, commit, git, scan };
}

describe('leak_scan', () => {
  it('denies a token, an email and a home path, naming file, line and rule but none of the matched text', async () => {
    const r = repo();
    r.write('src/a.ts', `export const x = 1;\nconst t = "${GITHUB_TOKEN}";\n`);
    r.write('docs/b.md', `Mail ${ALICE_EMAIL} for access.\n`);
    r.write('notes.txt', `one\ntwo\ncd ${ALICE_HOME}\n`);
    const head = r.commit();
    const failure = await r.scan();
    assert.ok(failure);
    assert.equal(failure.check, 'leak_scan');
    assert.equal(failure.actual, `docs/b.md:1 email; notes.txt:3 home_path; src/a.ts:2 ${GITHUB_RULE}`);
    assert.match(failure.expected ?? '', new RegExp(`${r.base}\\.\\.${head}`));
    assert.match(failure.expected ?? '', /\.config\/tmb\/leak-scan\.json/);
    for (const leaked of [GITHUB_TOKEN, GITHUB_TOKEN.slice(4), ALICE_EMAIL, 'alice']) {
      assert.ok(!JSON.stringify(failure).includes(leaked), `the failure holds ${leaked.slice(0, 3)}…`);
    }
  });

  it('passes a clean docs-only diff', async () => {
    const r = repo();
    r.write('docs/guide.md', '# Guide\n\nRun the build, then the tests.\n');
    r.commit();
    assert.equal(await r.scan(), null);
  });

  it('passes the built-in allowlist: noreply@, example.com|org|net, placeholder and generic home names', async () => {
    const r = repo();
    r.write(
      'docs/contact.md',
      [
        'Co-Authored-By: Claude <noreply@anthropic.com>',
        'foo@example.com, ops@mail.example.org and a@example.net',
        'Install under /Users/<name>/.claude and /home/<user>/x/',
        'CI runs in /home/runner/work/ and /Users/me/ or /home/user/ or /Users/you/',
        'C:\\Users\\<name>\\AppData and $HOME is /home/$USER/',
      ].join('\n') + '\n',
    );
    r.commit();
    assert.equal(await r.scan(), null);
  });

  it('scans only added lines: an unchanged line, a deletion, a pure rename and a binary file never hit', async () => {
    const r = repo({ 'keep.txt': `${ALICE_EMAIL}\nb\n`, 'gone.txt': `${ALICE_EMAIL}\n`, 'old/name.txt': `${ALICE_HOME}\n` });
    r.write('keep.txt', `${ALICE_EMAIL}\nb\nc\n`);
    r.git('rm', '-q', 'gone.txt');
    r.git('mv', 'old/name.txt', 'renamed.txt');
    r.write('blob.bin', Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(` ${ALICE_EMAIL} `)]));
    r.commit();
    assert.equal(await r.scan(), null);
  });

  it('numbers a hit by its line in the new file', async () => {
    const r = repo({ 'src/long.txt': 'a\nb\nc\nd\ne\n' });
    r.write('src/long.txt', `a\nb\nc\nd\n${ALICE_EMAIL}\ne\n`);
    r.commit();
    assert.equal((await r.scan())?.actual, 'src/long.txt:5 email');
  });

  it('names a path git quotes as the path itself', async () => {
    const r = repo();
    r.write('we"ird dir/a b.txt', `${ALICE_EMAIL}\n`);
    r.commit();
    assert.equal((await r.scan())?.actual, 'we"ird dir/a b.txt:1 email');
  });

  it('flags a Windows home path', async () => {
    const r = repo();
    r.write('a.ps1', `Set-Location ${['C:', 'Users', 'bob', 'repo'].join('\\')}\n`);
    r.commit();
    assert.equal((await r.scan())?.actual, 'a.ps1:1 home_path');
  });

  it('does not honor an inline secretlint-disable comment', async () => {
    const r = repo();
    r.write('a.ts', `const t = "${GITHUB_TOKEN}"; // secretlint-disable-line\n`);
    r.commit();
    assert.equal((await r.scan())?.actual, `a.ts:1 ${GITHUB_RULE}`);
  });

  it('denies as leak_scan when git cannot diff (fail closed)', async () => {
    const r = repo();
    r.write('a.txt', 'x\n');
    const head = r.commit();
    const failure = await leakScan(r.git('rev-parse', '--show-toplevel'), 'f'.repeat(40), head, GIT_ENV);
    assert.equal(failure?.check, 'leak_scan');
    assert.match(failure?.actual ?? '', /^git diff f{40}\.\.[0-9a-f]{40} failed: /);
  });

  describe(LEAK_SCAN_FILE, () => {
    const config = (body: unknown) => `${JSON.stringify(body, null, 2)}\n`;

    it('admits a hit an allow entry with a reason matches, and only for its rule', async () => {
      const r = repo();
      r.write(
        LEAK_SCAN_FILE,
        config({ version: 1, allow: [{ rule: 'email', pattern: '@corp\\.io$', reason: 'the team alias is public' }] }),
      );
      r.write('a.md', `${ALICE_EMAIL}\n${['bob', 'other.io'].join('@')}\n`);
      r.commit();
      assert.equal((await r.scan())?.actual, 'a.md:2 email');
    });

    it('admits any rule with an allow entry that names none', async () => {
      const r = repo();
      r.write(LEAK_SCAN_FILE, config({ version: 1, allow: [{ pattern: 'alice', reason: 'fixture user' }] }));
      r.write('a.md', `${ALICE_EMAIL} ${ALICE_HOME}\n`);
      r.commit();
      assert.equal(await r.scan(), null);
    });

    it('turns a rule off with disable_rules', async () => {
      const r = repo();
      r.write(LEAK_SCAN_FILE, config({ version: 1, disable_rules: [{ rule: 'home_path', reason: 'docs show real layouts' }] }));
      r.write('a.md', `${ALICE_HOME}\n${ALICE_EMAIL}\n`);
      r.commit();
      assert.equal((await r.scan())?.actual, 'a.md:2 email');
    });

    it('turns a secretlint rule off by its id', async () => {
      const r = repo();
      r.write(LEAK_SCAN_FILE, config({ version: 1, disable_rules: [{ rule: GITHUB_RULE, reason: 'token fixtures' }] }));
      r.write('a.ts', `const t = "${GITHUB_TOKEN}";\n`);
      r.commit();
      assert.equal(await r.scan(), null);
    });

    for (const [name, body, error] of [
      ['an allow entry without a reason', { version: 1, allow: [{ pattern: 'alice' }] }, /allow\[0\] needs a non-empty reason/],
      ['an allow entry with a blank reason', { version: 1, allow: [{ pattern: 'alice', reason: '  ' }] }, /allow\[0\] needs a non-empty reason/],
      ['a disable entry without a reason', { version: 1, disable_rules: [{ rule: 'email' }] }, /disable_rules\[0\] needs a non-empty reason/],
      ['an unknown rule', { version: 1, disable_rules: [{ rule: 'emails', reason: 'r' }] }, /unknown rule "emails"/],
      ['an invalid regex', { version: 1, allow: [{ pattern: '(', reason: 'r' }] }, /not a valid regex/],
      ['an unknown key', { version: 1, allows: [] }, /unknown key\(s\) allows/],
      ['version 2', { version: 2 }, /version must be 1/],
    ] as const) {
      it(`denies ${name} with leak_scan_config`, async () => {
        const r = repo();
        r.write(LEAK_SCAN_FILE, config(body));
        r.write('a.md', `${ALICE_EMAIL}\n`);
        const head = r.commit();
        const failure = await r.scan();
        assert.equal(failure?.check, 'leak_scan_config');
        assert.match(failure?.actual ?? '', error);
        assert.match(failure?.expected ?? '', new RegExp(`leak-scan\\.json at ${head}`));
      });
    }

    it('denies a file that is not JSON with leak_scan_config', async () => {
      const r = repo();
      r.write(LEAK_SCAN_FILE, '{ version: 1 ');
      r.commit();
      assert.match((await r.scan())?.actual ?? '', /not valid JSON/);
    });

    it('reads the file as committed, not from the working tree', async () => {
      const r = repo();
      r.write('a.md', `${ALICE_EMAIL}\n`);
      r.commit();
      r.write(LEAK_SCAN_FILE, config({ version: 1, allow: [{ pattern: 'alice', reason: 'uncommitted' }] }));
      assert.equal((await r.scan())?.actual, 'a.md:1 email');
    });
  });
});
