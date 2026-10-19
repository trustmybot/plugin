import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajectoryDB } from '../db.js';
import { WorldModelGraph } from '../graph-db.js';
import { createProjectLogger } from '../logger.js';
import { DatabaseSync } from 'node:sqlite';
import {
  createClaudeRuntimeContext,
  createCodexRuntimeContext,
  deriveCodexRuntimePaths,
  claudeProjectRootOfDb,
  findExistingClaudeDbUp,
  otherClaudeDbs,
  probeClaudeDb,
  resolveGraphDbPath,
} from '../platform.js';
import { repoRowPath } from '../utils/repo-paths.js';

function fixture(): {
  root: string;
  project: string;
  plugin: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'tmb-platform-'));
  const project = join(root, 'project');
  const plugin = join(root, 'installed-plugin');
  mkdirSync(project);
  mkdirSync(plugin);
  return { root, project, plugin };
}

describe('runtime contexts', () => {
  it('keeps Claude cwd semantics distinct from a trusted Codex project root', () => {
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

  it('resolves Codex state side-effect free from explicit metadata only', () => {
    const { root, project, plugin } = fixture();
    try {
      mkdirSync(join(plugin, '.codex-plugin'));
      writeFileSync(
        join(plugin, '.codex-plugin', 'plugin.json'),
        '{ deliberately invalid placeholder json',
      );

      const context = createCodexRuntimeContext({
        projectRoot: project,
        pluginRoot: plugin,
        pluginName: 'tmb',
        pluginVersion: '1.1.0',
      });
      const canonicalProject = realpathSync(project);
      const canonicalPlugin = realpathSync(plugin);

      assert.equal(context.host, 'codex');
      assert.equal(context.projectRoot, canonicalProject);
      assert.deepEqual(context.plugin, {
        root: canonicalPlugin,
        name: 'tmb',
        version: '1.1.0',
      });
      assert.equal(context.paths.stateDir, join(canonicalProject, '.tmb', 'tmb'));
      assert.equal(
        context.paths.trajectoryDb,
        join(canonicalProject, '.tmb', 'tmb', 'trajectory.db'),
      );
      assert.equal(
        context.paths.graphDb,
        join(canonicalProject, '.tmb', 'tmb', 'world-model.kuzu'),
      );
      assert.equal(
        context.paths.logDir,
        join(canonicalProject, '.tmb', 'tmb', 'logs'),
      );
      assert.ok(!existsSync(join(project, '.tmb')));
      assert.ok(!existsSync(join(project, '.claude')));
      assert.ok(Object.isFrozen(context));
      assert.ok(Object.isFrozen(context.plugin));
      assert.ok(Object.isFrozen(context.paths));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('canonicalizes project-root symlink aliases to one runtime identity', () => {
    const { root, project, plugin } = fixture();
    try {
      const alias = join(root, 'project-alias');
      symlinkSync(project, alias, 'dir');

      const direct = createCodexRuntimeContext({
        projectRoot: project,
        pluginRoot: plugin,
        pluginName: 'tmb',
        pluginVersion: '1.1.0',
      });
      const throughAlias = createCodexRuntimeContext({
        projectRoot: alias,
        pluginRoot: plugin,
        pluginName: 'tmb',
        pluginVersion: '1.1.0',
      });

      assert.equal(throughAlias.projectRoot, direct.projectRoot);
      assert.deepEqual(throughAlias.paths, direct.paths);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe plugin path segments', () => {
    const { root, project, plugin } = fixture();
    try {
      for (const pluginName of ['', '.', '..', '../escape', 'a/b', 'a\\b', ' spaced ']) {
        assert.throws(
          () =>
            createCodexRuntimeContext({
              projectRoot: project,
              pluginRoot: plugin,
              pluginName,
              pluginVersion: '1.1.0',
            }),
          /safe, non-empty path segment/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing, relative, or non-directory roots and empty versions', () => {
    const { root, project, plugin } = fixture();
    try {
      const file = join(root, 'not-a-dir');
      writeFileSync(file, '');
      const base = {
        projectRoot: project,
        pluginRoot: plugin,
        pluginName: 'tmb',
        pluginVersion: '1.1.0',
      };

      assert.throws(
        () => createCodexRuntimeContext({ ...base, projectRoot: 'relative' }),
        /absolute path/,
      );
      assert.throws(
        () => createCodexRuntimeContext({ ...base, projectRoot: join(root, 'missing') }),
        /existing directory/,
      );
      assert.throws(
        () => createCodexRuntimeContext({ ...base, pluginRoot: file }),
        /existing directory/,
      );
      assert.throws(
        () => createCodexRuntimeContext({ ...base, pluginVersion: '   ' }),
        /non-empty string/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an existing state symlink that escapes the trusted project root', () => {
    const { root, project, plugin } = fixture();
    try {
      const outside = join(root, 'outside-state');
      mkdirSync(outside);
      symlinkSync(outside, join(project, '.tmb'), 'dir');

      assert.throws(
        () =>
        createCodexRuntimeContext({
          projectRoot: project,
          pluginRoot: plugin,
          pluginName: 'tmb',
          pluginVersion: '1.1.0',
        }),
        /contains a symbolic link in writable state/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects escaping and dangling symlinks at every derived Codex write target', () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly targetParts: readonly string[];
      readonly kind: 'dir' | 'file';
      readonly dangling?: boolean;
    }> = [
      { name: 'state root', targetParts: ['.tmb'], kind: 'dir' },
      { name: 'plugin state', targetParts: ['.tmb', 'tmb'], kind: 'dir' },
      {
        name: 'trajectory DB',
        targetParts: ['.tmb', 'tmb', 'trajectory.db'],
        kind: 'file',
        dangling: true,
      },
      {
        name: 'graph DB',
        targetParts: ['.tmb', 'tmb', 'world-model.kuzu'],
        kind: 'file',
        dangling: true,
      },
      { name: 'log directory', targetParts: ['.tmb', 'tmb', 'logs'], kind: 'dir' },
      {
        name: 'server log',
        targetParts: ['.tmb', 'tmb', 'logs', 'mcp-server.log'],
        kind: 'file',
      },
      {
        name: 'SQL log',
        targetParts: ['.tmb', 'tmb', 'logs', 'sql.log'],
        kind: 'file',
        dangling: true,
      },
    ];

    for (const testCase of cases) {
      const { root, project, plugin } = fixture();
      try {
        const target = join(project, ...testCase.targetParts);
        mkdirSync(join(target, '..'), { recursive: true });
        const outside = join(root, `outside-${testCase.name.replaceAll(' ', '-')}`);
        if (testCase.dangling !== true) {
          if (testCase.kind === 'dir') {
            mkdirSync(outside);
          } else {
            writeFileSync(outside, 'sentinel');
          }
        }
        symlinkSync(outside, target, testCase.kind);

        assert.throws(
          () =>
            createCodexRuntimeContext({
              projectRoot: project,
              pluginRoot: plugin,
              pluginName: 'tmb',
              pluginVersion: '1.1.0',
            }),
          /escapes the trusted project root|symbolic link/,
          testCase.name,
        );
        if (testCase.dangling === true) {
          assert.equal(existsSync(outside), false, `${testCase.name} target must stay absent`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('initializes two Codex DBs only under their respective .tmb state roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'tmb-platform-projects-'));
    try {
      const plugin = join(root, 'plugin');
      const projectA = join(root, 'project-a');
      const projectB = join(root, 'project-b');
      mkdirSync(plugin);
      mkdirSync(projectA);
      mkdirSync(projectB);

      const contexts = [projectA, projectB].map((projectRoot) =>
        createCodexRuntimeContext({
          projectRoot,
          pluginRoot: plugin,
          pluginName: 'tmb',
          pluginVersion: '1.1.0',
        }),
      );
      for (const context of contexts) {
        const logger = createProjectLogger({
          logDir: context.paths.logDir,
          sqlEnabled: true,
          trustedProjectRoot: context.projectRoot,
        });
        logger.serverLog({ kind: 'project-isolation' });
        logger.sqlLog({ kind: 'project-isolation' });
        const db = new TrajectoryDB(context.paths.trajectoryDb, {
          pluginVersion: context.plugin.version,
          serverLog: logger.serverLog,
          sqlLog: logger.sqlLog,
          trustedProjectRoot: context.projectRoot,
        });
        db.close();
      }

      assert.notEqual(contexts[0]!.paths.trajectoryDb, contexts[1]!.paths.trajectoryDb);
      assert.notEqual(contexts[0]!.paths.graphDb, contexts[1]!.paths.graphDb);
      assert.notEqual(contexts[0]!.paths.logDir, contexts[1]!.paths.logDir);
      assert.ok(existsSync(join(projectA, '.tmb', 'tmb', 'trajectory.db')));
      assert.ok(existsSync(join(projectB, '.tmb', 'tmb', 'trajectory.db')));
      for (const projectRoot of [projectA, projectB]) {
        assert.ok(existsSync(join(projectRoot, '.tmb', 'tmb', 'logs', 'mcp-server.log')));
        assert.ok(existsSync(join(projectRoot, '.tmb', 'tmb', 'logs', 'sql.log')));
      }
      assert.ok(!existsSync(join(projectA, '.claude')));
      assert.ok(!existsSync(join(projectB, '.claude')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates Codex write targets after runtime-context creation', () => {
    const { root, project, plugin } = fixture();
    try {
      const outside = join(root, 'outside-state');
      mkdirSync(outside);
      const context = createCodexRuntimeContext({
        projectRoot: project,
        pluginRoot: plugin,
        pluginName: 'tmb',
        pluginVersion: '1.1.0',
      });
      symlinkSync(outside, join(project, '.tmb'), 'dir');

      assert.throws(
        () =>
          createProjectLogger({
            logDir: context.paths.logDir,
            sqlEnabled: true,
            trustedProjectRoot: context.projectRoot,
          }),
        /symbolic link/,
      );
      assert.throws(
        () =>
          new TrajectoryDB(context.paths.trajectoryDb, {
            pluginVersion: context.plugin.version,
            serverLog: () => {},
            sqlLog: () => {},
            trustedProjectRoot: context.projectRoot,
          }),
        /symbolic link/,
      );
      assert.throws(
        () =>
          new WorldModelGraph(context.paths.graphDb, {
            trustedProjectRoot: context.projectRoot,
          }),
        /symbolic link/,
      );
      assert.equal(existsSync(join(outside, 'tmb')), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('path derivation', () => {
  it('keeps pure Codex derivation separate from filesystem validation', () => {
    const paths = deriveCodexRuntimePaths({
      projectRoot: '/does/not/need/to/exist',
      pluginName: 'tmb',
    });
    assert.equal(
      paths.trajectoryDb,
      join('/does/not/need/to/exist', '.tmb', 'tmb', 'trajectory.db'),
    );
    assert.throws(
      () =>
        deriveCodexRuntimePaths({
          projectRoot: 'relative',
          pluginName: 'tmb',
        }),
      /absolute path/,
    );
  });

  it('maps graph paths one-to-one and reserves graph-shaped DB names', () => {
    assert.equal(resolveGraphDbPath(':memory:'), ':memory:');
    assert.equal(
      resolveGraphDbPath('/project/state/trajectory.db'),
      '/project/state/world-model.kuzu',
    );
    assert.equal(
      resolveGraphDbPath('/project/state/custom.db'),
      '/project/state/custom.db.world-model.kuzu',
    );
    assert.notEqual(
      resolveGraphDbPath('/project/state/a.db'),
      resolveGraphDbPath('/project/state/b.db'),
    );
    for (const reserved of [
      '/project/state/world-model.kuzu',
      '/project/state/custom.db.world-model.kuzu',
      '/project/state/WORLD-MODEL.KUZU',
    ]) {
      assert.throws(() => resolveGraphDbPath(reserved), /reserved for graph storage/);
    }
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
