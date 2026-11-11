import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { DatabaseSync } from 'node:sqlite';
import {
  createClaudeRuntimeContext,
  claudeProjectRootOfDb,
  findExistingClaudeDbUp,
  otherClaudeDbs,
  probeClaudeDb,
} from '../platform.js';
import { repoRowPath } from '../utils/repo-paths.js';

describe('runtime contexts', () => {
  it('keeps Claude cwd semantics: the cwd seeds the DB walk, not a trusted project root', () => {
    const context = createClaudeRuntimeContext({
      env: {},
      cwd: '/invocation/cwd',
      home: '/user/home',
    });

    assert.equal(context.host, 'claude');
    assert.equal(context.cwd, '/invocation/cwd');
    assert.ok(!('projectRoot' in context));
    assert.equal(
      context.paths.trajectoryDb,
      join('/invocation/cwd', '.claude', 'tmb', 'trajectory.db'),
    );
    assert.equal(
      context.paths.logDir,
      join('/invocation/cwd', '.claude', 'tmb', 'logs'),
    );
  });
});

describe('findExistingClaudeDbUp (the one DB-location rule)', () => {
  function plant(root: string, schema: 'current' | 'stale' = 'current'): string {
    const dir = join(root, '.claude', 'tmb');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'trajectory.db');
    const db = new DatabaseSync(path);
    db.exec(
      schema === 'current'
        ? 'CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER)'
        : 'CREATE TABLE tasks (id INTEGER PRIMARY KEY)',
    );
    db.close();
    return path;
  }

  function layout(): { root: string; home: string; ws: string; inner: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-dbrule-')));
    const home = join(root, 'home');
    const ws = join(root, 'ws');
    const inner = join(ws, 'plugin', 'src');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(ws, 'plugin', '.git'), { recursive: true });
    mkdirSync(inner, { recursive: true });
    return { root, home, ws, inner };
  }

  it('1: TRAJECTORY_DB_PATH wins when it exists, and is unresolved when it does not', () => {
    const { root, home, ws, inner } = layout();
    try {
      plant(ws);
      const explicit = join(root, 'explicit.db');
      writeFileSync(explicit, '');
      assert.equal(
        findExistingClaudeDbUp(inner, 'tmb', { home, env: { TRAJECTORY_DB_PATH: explicit } }),
        explicit,
      );
      assert.equal(
        findExistingClaudeDbUp(inner, 'tmb', {
          home,
          env: { TRAJECTORY_DB_PATH: join(root, 'missing.db') },
        }),
        null,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('2: the walk starts at CLAUDE_PROJECT_DIR and reaches the workspace DB above it (GH 1553)', () => {
    const { root, home, ws, inner } = layout();
    try {
      const workspaceDb = plant(ws);
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      assert.equal(
        findExistingClaudeDbUp(elsewhere, 'tmb', { home, env: { CLAUDE_PROJECT_DIR: ws } }),
        workspaceDb,
      );
      assert.equal(
        findExistingClaudeDbUp(elsewhere, 'tmb', { home, env: { CLAUDE_PROJECT_DIR: join(ws, 'plugin') } }),
        workspaceDb,
      );
      assert.equal(
        findExistingClaudeDbUp(inner, 'tmb', { home, env: { CLAUDE_PROJECT_DIR: elsewhere } }),
        null,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('2: a standalone DB ends the walk and wins over the outer workspace DB (GH 1553)', () => {
    const { root, home, ws, inner } = layout();
    try {
      plant(ws);
      const repoDb = plant(join(ws, 'plugin'));
      writeFileSync(join(ws, 'plugin', '.claude', 'tmb', 'standalone'), '');
      assert.equal(findExistingClaudeDbUp(inner, 'tmb', { home, env: {} }), repoDb);
      assert.equal(
        findExistingClaudeDbUp(root, 'tmb', { home, env: { CLAUDE_PROJECT_DIR: inner } }),
        repoDb,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('3: the fallback walk picks the outermost DB, past .git, skipping a stale schema', () => {
    const { root, home, ws, inner } = layout();
    try {
      const workspaceDb = plant(ws);
      plant(join(ws, 'plugin'));
      assert.equal(findExistingClaudeDbUp(inner, 'tmb', { home, env: {} }), workspaceDb);

      rmSync(join(ws, '.claude'), { recursive: true, force: true });
      plant(ws, 'stale');
      assert.equal(
        findExistingClaudeDbUp(inner, 'tmb', { home, env: {} }),
        join(ws, 'plugin', '.claude', 'tmb', 'trajectory.db'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('3: a candidate whose read fails is kept (resolved, so the error surfaces)', () => {
    const { root, home, ws, inner } = layout();
    try {
      mkdirSync(join(ws, '.claude', 'tmb'), { recursive: true });
      const corrupt = join(ws, '.claude', 'tmb', 'trajectory.db');
      writeFileSync(corrupt, 'not a sqlite database at all, just text padding the header');
      assert.equal(probeClaudeDb(corrupt), 'error');
      assert.equal(findExistingClaudeDbUp(inner, 'tmb', { home, env: {} }), corrupt);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('3: the walk never enters HOME from below it', () => {
    const { root } = layout();
    try {
      const home = join(root, 'ws');
      plant(home);
      const below = join(home, 'plugin', 'src');
      assert.equal(findExistingClaudeDbUp(below, 'tmb', { home, env: {} }), null);
      assert.equal(
        findExistingClaudeDbUp(home, 'tmb', { home, env: {} }),
        join(home, '.claude', 'tmb', 'trajectory.db'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('3: a home-level workspace pointer is never consulted', () => {
    const { root, home, ws } = layout();
    try {
      plant(ws);
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'tmb-active-workspace'), `${ws}\n`);
      assert.equal(findExistingClaudeDbUp(elsewhere, 'tmb', { home, env: {} }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('4: unresolved when no DB exists anywhere', () => {
    const { root, home, inner } = layout();
    try {
      assert.equal(findExistingClaudeDbUp(inner, 'tmb', { home, env: {} }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('3: a HOME DB is never picked from a CLAUDE_PROJECT_DIR below it (GH 1553)', () => {
    const { root } = layout();
    try {
      const home = join(root, 'ws');
      plant(home);
      const below = join(home, 'plugin', 'src');
      assert.equal(findExistingClaudeDbUp(root, 'tmb', { home, env: { CLAUDE_PROJECT_DIR: below } }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('otherClaudeDbs (GH 1553)', () => {
  function plant(root: string, rows: { issues?: number; tasks?: number } = {}): string {
    const dir = join(root, '.claude', 'tmb');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'trajectory.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER)');
    db.exec('CREATE TABLE issues (id INTEGER PRIMARY KEY)');
    for (let i = 0; i < (rows.issues ?? 0); i += 1) db.exec('INSERT INTO issues DEFAULT VALUES');
    for (let i = 0; i < (rows.tasks ?? 0); i += 1) db.exec('INSERT INTO tasks (prompt_bearing) VALUES (0)');
    db.close();
    return path;
  }

  it('lists the DBs on the walk and below the root with their counts, skipping standalone and dot dirs', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-others-')));
    try {
      const home = join(root, 'home');
      const ws = join(root, 'ws');
      mkdirSync(home);
      const wsDb = plant(ws, { issues: 2, tasks: 3 });
      const nestedDb = plant(join(ws, 'a', 'b'));
      const deepDb = plant(join(ws, 'x', 'y', 'z'), { tasks: 1 });
      plant(join(ws, 'too', 'deep', 'to', 'be', 'seen'));
      plant(join(ws, '.hidden'));
      plant(join(ws, 'own'));
      writeFileSync(join(ws, 'own', '.claude', 'tmb', 'standalone'), '');
      plant(join(ws, 'own', 'inside'));

      assert.equal(claudeProjectRootOfDb(wsDb), ws);
      assert.equal(claudeProjectRootOfDb(':memory:'), null);
      assert.equal(otherClaudeDbs(join(root, 'x.db'), { sessionDir: ws, home }), null);

      const others = otherClaudeDbs(wsDb, { sessionDir: join(ws, 'a', 'b'), home }) ?? [];
      assert.deepEqual(
        others.map((o) => [o.path, o.issues, o.tasks, o.empty]).sort(),
        [
          [deepDb, 0, 1, false],
          [nestedDb, 0, 0, true],
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repoRowPath (GH 1553)', () => {
  it('resolves a relative repos.path against the project root holding the DB', () => {
    const fake = { dbPath: '/ws/.claude/tmb/trajectory.db' } as unknown as TrajectoryDB;
    assert.equal(repoRowPath(fake, 'plugin'), '/ws/plugin');
    assert.equal(repoRowPath(fake, '.'), '/ws');
    assert.equal(repoRowPath(fake, '/abs/repo'), '/abs/repo');
  });
});
