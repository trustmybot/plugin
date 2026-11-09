// The ref-move-reindex PostToolUse hook (GH 2584): a Bash command that moves
// the index target ref starts the detached run-scan child, which reindexes the
// repo with trigger 'hook'; any other command costs no git or DB call.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinScanEnv, tempDB, type ScanEnvPin } from './helpers.js';
import { PLUGIN_ROOT } from './hook-sandbox.js';
import { TrajectoryDB } from '../db.js';
import { GraphHolder, WorldModelGraph } from '../graph.js';
import { scanTools } from '../tools/scan.js';
import { reindexIdle, reindexOnRefMove } from '../world-model/freshness.js';
import { __setGitRunnerForTests } from '../utils/git-run.js';
import { cmdStatements } from '../hooks/cmd-analysis/index.js';
import { REAL_SEAMS, moveOf, refMoveReindexWith, type RefMoveSeams, type RepoStamp } from '../hooks/ref-move-reindex.js';

type Raw = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Handlers = Record<string, (args: Record<string, unknown>) => Promise<unknown>>;

const RUN_SCAN = join(PLUGIN_ROOT, 'scripts/maintenance/run-scan.mjs');

let pin: ScanEnvPin;
before(() => {
  pin = pinScanEnv();
});
after(() => pin.restore());
afterEach(async () => {
  __setGitRunnerForTests();
  await reindexIdle();
});

interface Calls {
  statements: string[];
  repoRoot: string[];
  repoStamp: string[];
  targetCommit: string[];
  launch: string[][];
}

function recording(over: Partial<RefMoveSeams> = {}): { seams: RefMoveSeams; calls: Calls } {
  const calls: Calls = { statements: [], repoRoot: [], repoStamp: [], targetCommit: [], launch: [] };
  const base = { ...REAL_SEAMS, ...over };
  const seams: RefMoveSeams = {
    statements: (command, cwd, env) => {
      calls.statements.push(cwd);
      return base.statements(command, cwd, env);
    },
    repoRoot: (dir, cwd, env) => {
      calls.repoRoot.push(dir);
      return base.repoRoot(dir, cwd, env);
    },
    repoStamp: (db, root, env) => {
      calls.repoStamp.push(root);
      return base.repoStamp(db, root, env);
    },
    targetCommit: (root, branch) => {
      calls.targetCommit.push(root);
      return base.targetCommit(root, branch);
    },
    launch: (args) => {
      calls.launch.push([...args]);
    },
  };
  return { seams, calls };
}

function payload(command: string, cwd: string, extra: Record<string, unknown> = {}, response: unknown = { stdout: '', stderr: '', interrupted: false }): string {
  return JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: response, cwd, ...extra });
}

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.email=t@t.io', '-c', 'user.name=t', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

interface Fx {
  ws: string;
  root: string;
  origin: string;
  dbPath: string;
  db: TrajectoryDB;
  env: NodeJS.ProcessEnv;
  commit: (rel: string, body: string) => string;
  originHead: () => string;
  stamp: () => string | null;
  cleanup: () => void;
}

async function fixture(): Promise<Fx> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ref-move-')));
  const ws = join(base, 'ws');
  const root = join(ws, 'app');
  const origin = join(base, 'origin.git');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  gitIn(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-qm', 'init');
  gitIn(root, 'remote', 'add', 'origin', origin);
  gitIn(root, 'push', '-q', '-u', 'origin', 'main');
  const dbPath = join(base, 'trajectory.db');
  const db = tempDB({ path: dbPath });
  const graph = new WorldModelGraph(db);
  const scan = scanTools(db, GraphHolder.fixed(graph), dbPath).handlers as Handlers;
  const r = (await scan['scan_run']!({ agent: 'bro', session_dir: ws, source: 'user_manual' })) as Raw;
  assert.ok(!r.isError, JSON.stringify(r));
  await reindexIdle();
  db.run(`UPDATE repos SET target_branch = 'main' WHERE name = 'app'`);
  const env: NodeJS.ProcessEnv = { ...process.env, TRAJECTORY_DB_PATH: dbPath, CLAUDE_PROJECT_DIR: ws };
  delete env.TMB_SKIP_AUTO_RESCAN;
  return {
    ws,
    root,
    origin,
    dbPath,
    db,
    env,
    commit: (rel, body) => {
      writeFileSync(join(root, rel), body);
      gitIn(root, 'add', '-A');
      gitIn(root, 'commit', '-qm', `change ${rel}`);
      return gitIn(root, 'rev-parse', 'HEAD');
    },
    originHead: () => gitIn(origin, 'rev-parse', 'main'),
    stamp: () => db.get<{ c: string | null }>(`SELECT indexed_commit AS c FROM repos WHERE name = 'app'`)!.c,
    cleanup: () => {
      db.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function runChild(fx: Fx, args: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TRAJECTORY_DB_PATH: fx.dbPath };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--experimental-sqlite', '--no-warnings', RUN_SCAN, ...args], { env, encoding: 'utf8', timeout: 120_000 });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('moveOf', () => {
  it('names git fetch, pull, push, merge, rebase, reset, checkout and switch, and gh pr merge, glab mr merge or gh repo sync', () => {
    assert.equal(moveOf('git fetch origin'), 'git');
    assert.equal(moveOf('git -C /x pull --rebase'), 'git');
    assert.equal(moveOf('git push -u origin feat'), 'git');
    assert.equal(moveOf('git merge --ff-only main'), 'git');
    assert.equal(moveOf('git rebase origin/main'), 'git');
    assert.equal(moveOf('git reset --hard origin/main'), 'git');
    assert.equal(moveOf('git checkout main'), 'git');
    assert.equal(moveOf('git -C /x switch -c feat'), 'git');
    assert.equal(moveOf('gh pr merge 12 --squash'), 'forge');
    assert.equal(moveOf('glab mr merge 3'), 'forge');
    assert.equal(moveOf('gh repo sync'), 'forge');
    assert.equal(moveOf('gh repo sync owner/fork --branch main'), 'forge');
  });

  it('names nothing for any other command', () => {
    assert.equal(moveOf('git log --oneline main'), null);
    assert.equal(moveOf('git commit -m "merge, rebase, reset, checkout and switch"'), null);
    assert.equal(moveOf('git merge-base main HEAD'), null);
    assert.equal(moveOf('gh pr view 12'), null);
    assert.equal(moveOf('gh repo view'), null);
    assert.equal(moveOf('gh pr sync'), null);
    assert.equal(moveOf('echo git push'), null);
    assert.equal(moveOf('echo git checkout main'), null);
  });

  for (const [name, command] of [
    ['git merge', 'git merge --ff-only main'],
    ['git rebase', 'git rebase origin/main'],
    ['git reset', 'git reset --hard origin/main'],
    ['git checkout', 'git checkout main'],
    ['git switch', 'git switch main'],
    ['gh repo sync', 'gh repo sync'],
  ] as const) {
    it(`${name} parsed from a command line is a move; the same words in a heredoc or quoted text are not`, async () => {
      const moves = async (cmd: string) => {
        const parsed = await cmdStatements(cmd, '', process.env);
        assert.ok(parsed.ok, cmd);
        return parsed.statements.map(({ stmt }) => moveOf(stmt));
      };
      assert.deepEqual(await moves(`cd /x && ${command}`), [null, command.startsWith('gh ') ? 'forge' : 'git']);
      assert.ok((await moves(`cat <<'EOF' > notes.txt\n${command}\nEOF`)).every((m) => m === null));
      assert.ok((await moves(`echo "${command}" && printf '%s' '${command}'`)).every((m) => m === null));
    });
  }
});

describe('SC1: a command with no ref-moving statement', () => {
  const dbFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-move-db-'));
    const path = join(dir, 'trajectory.db');
    writeFileSync(path, '');
    return path;
  };

  for (const [name, command] of [
    ['unrelated', 'ls -la && npm test'],
    ['heredoc', "cat <<'EOF' > notes.txt\ngit push origin main\ngh pr merge 12 --squash\nEOF"],
    ['quoted', 'echo "git push origin main" && printf \'%s\' "gh pr merge 12"'],
    ['commit message', 'git commit -m "fetch, pull, push and merge"'],
    ['merge-base', 'git merge-base main HEAD'],
    ['quoted checkout', 'echo "git checkout main; git switch dev; gh repo sync"'],
  ] as const) {
    it(`${name}: spawns nothing and runs no git or DB call`, async () => {
      const db = dbFile();
      const gitCalls: string[][] = [];
      __setGitRunnerForTests((args) => {
        gitCalls.push(args);
        throw new Error('no git call expected');
      });
      const { seams, calls } = recording();
      const out = await refMoveReindexWith(seams)(payload(command, '/nowhere'), { ...process.env, TRAJECTORY_DB_PATH: db });
      assert.deepEqual(out, { stdout: '', code: 0 });
      assert.ok(calls.statements.every((cwd) => cwd === ''), `statements ran with a cwd: ${calls.statements.join(',')}`);
      assert.deepEqual([calls.repoRoot, calls.repoStamp, calls.targetCommit, calls.launch], [[], [], [], []]);
      assert.deepEqual(gitCalls, []);
    });
  }

  it('a command with no ref-moving word never parses', async () => {
    const { seams, calls } = recording();
    await refMoveReindexWith(seams)(payload('ls -la', '/nowhere'), process.env);
    assert.deepEqual(calls.statements, []);
  });

  it('a failed command or TMB_SKIP_AUTO_RESCAN=1 exits before parsing', async () => {
    const { seams, calls } = recording();
    const gate = refMoveReindexWith(seams);
    await gate(payload('gh pr merge 12', '/nowhere', {}, { stdout: '', stderr: 'pull request is not mergeable' }), process.env);
    await gate(payload('git push', '/nowhere'), { ...process.env, TMB_SKIP_AUTO_RESCAN: '1' });
    assert.deepEqual(calls.statements, []);
    assert.deepEqual(calls.launch, []);
  });
});

describe('SC2, SC3: git push to a local bare remote', () => {
  let fx: Fx;
  before(async () => {
    fx = await fixture();
  });
  after(() => fx.cleanup());

  it('SC3: with the stamp at the target, a push or fetch spawns nothing', async () => {
    assert.equal(fx.stamp(), fx.originHead());
    const { seams, calls } = recording();
    const gate = refMoveReindexWith(seams);
    gitIn(fx.root, 'push', '-q', 'origin', 'main');
    await gate(payload('git push origin main', fx.root), fx.env);
    await gate(payload('git fetch origin', fx.root), fx.env);
    assert.deepEqual(calls.launch, []);
    assert.deepEqual(calls.repoStamp, [fx.root, fx.root]);
  });

  it('an unregistered repo exits silently', async () => {
    const other = join(fx.ws, '..', 'unregistered');
    mkdirSync(other, { recursive: true });
    gitIn(other, 'init', '-q', '-b', 'main');
    const { seams, calls } = recording();
    await refMoveReindexWith(seams)(payload('git fetch', other), fx.env);
    assert.deepEqual(calls.targetCommit, []);
    assert.deepEqual(calls.launch, []);
  });

  it('SC2: a push that moves origin/main spawns one reindex, and the child brings the stamp to it with trigger hook', async () => {
    const before = fx.stamp();
    const pushed = fx.commit('b.ts', "import { alpha } from './a.js';\n\nexport function beta(): number {\n  return alpha();\n}\n");
    gitIn(fx.root, 'push', '-q', 'origin', 'main');
    assert.equal(gitIn(fx.root, 'rev-parse', 'refs/remotes/origin/main'), pushed);
    assert.notEqual(before, pushed);

    const { seams, calls } = recording();
    await refMoveReindexWith(seams)(payload('git add -A && git push origin main', fx.root), fx.env);
    assert.deepEqual(calls.launch, [[fx.root, 'hook', 'app']]);

    const r = runChild(fx, calls.launch[0]!);
    assert.equal(r.status, 0, r.out);
    assert.equal(fx.stamp(), pushed);
    const reindex = fx.db.get<{ trigger: string; to: string }>(
      `SELECT json_extract(content_json, '$.trigger') AS trigger, json_extract(content_json, '$.to_commit') AS "to"
         FROM audit WHERE event_type = 'wm_reindex' ORDER BY id DESC LIMIT 1`,
    );
    assert.deepEqual({ ...reindex }, { trigger: 'hook', to: pushed });
    const fresh = fx.db.get<{ t: string }>(`SELECT reindex_trigger AS t FROM wm_freshness WHERE repo = 'app'`);
    assert.equal(fresh?.t, 'hook');

    const again = recording();
    await refMoveReindexWith(again.seams)(payload('git push origin main', fx.root), fx.env);
    assert.deepEqual(again.calls.launch, []);
  });
});

describe('SC4: gh pr merge fetches the target branch first', () => {
  const stamp: RepoStamp = { name: 'app', indexed_commit: 'c'.repeat(40), target_branch: 'main' };
  const seamsFor = () =>
    recording({
      statements: cmdStatements,
      repoRoot: async () => '/repo',
      repoStamp: () => stamp,
      targetCommit: () => stamp.indexed_commit,
    });
  const env = (): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-move-db-'));
    writeFileSync(join(dir, 'trajectory.db'), '');
    return { ...process.env, TRAJECTORY_DB_PATH: join(dir, 'trajectory.db') };
  };

  it('as bro, the child is spawned with --fetch even when the local stamp matches', async () => {
    const { seams, calls } = seamsFor();
    await refMoveReindexWith(seams)(payload('gh pr merge 12 --squash', '/repo'), env());
    assert.deepEqual(calls.launch, [['/repo', 'hook', 'app', '--fetch']]);
    assert.deepEqual(calls.targetCommit, []);
  });

  for (const role of ['tmb:swe', 'swe', 'tmb:code-reviewer', 'code-reviewer']) {
    it(`as ${role}, no fetch: the stamp check alone decides`, async () => {
      const { seams, calls } = seamsFor();
      await refMoveReindexWith(seams)(payload('glab mr merge 3', '/repo', { agent_id: 'a1', agent_type: role }), env());
      assert.deepEqual(calls.launch, []);
      assert.deepEqual(calls.targetCommit, ['/repo']);
    });
  }

  it('the child fetches origin <target branch> with a 5 s cap, then reindexes to the fetched commit', async () => {
    const fx = await fixture();
    try {
      const peer = join(fx.ws, '..', 'peer');
      execFileSync('git', ['clone', '-q', fx.origin, peer]);
      writeFileSync(join(peer, 'c.ts'), 'export const gamma = 3;\n');
      gitIn(peer, 'add', '-A');
      gitIn(peer, 'commit', '-qm', 'merged on the forge');
      gitIn(peer, 'push', '-q', 'origin', 'main');
      const merged = fx.originHead();
      assert.notEqual(fx.stamp(), merged);

      const seen: Array<{ args: string[]; timeout: number | undefined }> = [];
      __setGitRunnerForTests((args, options) => {
        seen.push({ args, timeout: options.timeout });
        return spawnSync('git', args, options);
      });
      const fresh = await reindexOnRefMove(fx.db, new WorldModelGraph(fx.db), 'app', { dbPath: fx.dbPath, fetch: true });
      __setGitRunnerForTests();
      assert.deepEqual(seen[0], { args: ['-C', fx.root, 'fetch', '-q', 'origin', 'main'], timeout: 5000 });
      assert.equal(fresh?.indexed_commit, merged);
      assert.equal(fx.stamp(), merged);
    } finally {
      fx.cleanup();
    }
  });

  it('without --fetch the child runs no fetch', async () => {
    const fx = await fixture();
    try {
      const seen: string[][] = [];
      __setGitRunnerForTests((args, options) => {
        seen.push(args);
        return spawnSync('git', args, options);
      });
      await reindexOnRefMove(fx.db, new WorldModelGraph(fx.db), 'app', { dbPath: fx.dbPath });
      __setGitRunnerForTests();
      assert.ok(!seen.some((a) => a.includes('fetch')), JSON.stringify(seen));
    } finally {
      fx.cleanup();
    }
  });
});

describe('local ref moves and gh repo sync', () => {
  const stamp: RepoStamp = { name: 'app', indexed_commit: 'c'.repeat(40), target_branch: 'main' };
  const env = (): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), 'ref-move-db-'));
    writeFileSync(join(dir, 'trajectory.db'), '');
    return { ...process.env, TRAJECTORY_DB_PATH: join(dir, 'trajectory.db') };
  };
  const seamsAt = (target: string) =>
    recording({ statements: cmdStatements, repoRoot: async () => '/repo', repoStamp: () => stamp, targetCommit: () => target });

  for (const command of ['git merge --ff-only main', 'git rebase main', 'git reset --hard HEAD~1', 'git checkout main', 'git switch main']) {
    it(`${command}: the stamp check alone decides`, async () => {
      const moved = seamsAt('d'.repeat(40));
      await refMoveReindexWith(moved.seams)(payload(command, '/repo'), env());
      assert.deepEqual(moved.calls.launch, [['/repo', 'hook', 'app']]);

      const still = seamsAt(stamp.indexed_commit);
      await refMoveReindexWith(still.seams)(payload(command, '/repo'), env());
      assert.deepEqual(still.calls.targetCommit, ['/repo']);
      assert.deepEqual(still.calls.launch, []);
    });
  }

  it('gh repo sync spawns the child with --fetch as bro, and only on a moved target as swe', async () => {
    const bro = seamsAt(stamp.indexed_commit);
    await refMoveReindexWith(bro.seams)(payload('gh repo sync', '/repo'), env());
    assert.deepEqual(bro.calls.launch, [['/repo', 'hook', 'app', '--fetch']]);

    const swe = seamsAt(stamp.indexed_commit);
    await refMoveReindexWith(swe.seams)(payload('gh repo sync', '/repo', { agent_id: 'a1', agent_type: 'tmb:swe' }), env());
    assert.deepEqual(swe.calls.launch, []);
  });

  it('a local reset in a repo with no origin brings the stamp to HEAD with trigger hook', async () => {
    const fx = await fixture();
    try {
      gitIn(fx.root, 'remote', 'remove', 'origin');
      gitIn(fx.root, 'update-ref', '-d', 'refs/remotes/origin/main');
      const first = fx.stamp()!;
      const next = fx.commit('b.ts', 'export const beta = 2;\n');
      const { seams, calls } = recording();
      await refMoveReindexWith(seams)(payload('git reset --hard HEAD', fx.root), fx.env);
      assert.deepEqual(calls.launch, [[fx.root, 'hook', 'app']]);
      assert.equal(runChild(fx, calls.launch[0]!).status, 0);
      assert.equal(fx.stamp(), next);
      assert.notEqual(first, next);
    } finally {
      fx.cleanup();
    }
  });
});
