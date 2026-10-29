/** Owned, fail-closed scratch fixtures for the L5/L6 scorer tests. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export interface FixtureOperations {
  allocate: (prefix: string) => string;
  git: (project: string, args: string[], env: NodeJS.ProcessEnv) => string;
  initializeDatabase: (path: string) => void;
}
export const fixtureOperations: FixtureOperations = {
  allocate: mkdtempSync,
  git(project, args, env) {
    const run = spawnSync('git', ['-C', project, ...args], { env, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
    if (run.error || run.status !== 0) throw new Error(`git ${args[0]}: ${run.error?.message || run.stderr.trim() || `exit ${run.status ?? run.signal}`}`);
    return run.stdout.trim();
  },
  initializeDatabase(path) {
    const db = new DatabaseSync(path);
    try { db.exec(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../schema.sql'), 'utf8')); }
    finally { db.close(); }
  },
};

export function createScorerFixtures(parent = tmpdir(), overrides: Partial<FixtureOperations> = {}) {
  const ops = { ...fixtureOperations, ...overrides };
  const canonicalParent = realpathSync(parent);
  const root = ops.allocate(join(canonicalParent, 'scorers-test-'));
  // Never adopt an allocator's empty, unrelated or non-directory return value.
  if (!root || dirname(root) !== canonicalParent || !basename(root).startsWith('scorers-test-') || realpathSync(root) !== root) {
    throw new Error('invalid scorer scratch root');
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const allocate = (prefix: string): string => {
    const path = ops.allocate(join(root, prefix));
    if (!path || dirname(path) !== root || !basename(path).startsWith(prefix) || realpathSync(path) !== path) throw new Error('invalid scorer fixture path');
    return path;
  };
  let env: NodeJS.ProcessEnv;
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    const globalConfig = join(home, '.gitconfig');
    writeFileSync(globalConfig, '');
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig });
  } catch (error) { cleanup(); throw error; }
  return {
    root, env, cleanup,
    create() {
      try {
        const project = allocate('project-');
        const git = (...args: string[]) => ops.git(project, args, env);
        git('init', '-q', '-b', 'main');
        git('config', 'user.email', 'fixture@example.test');
        git('config', 'user.name', 'Fixture');
        writeFileSync(join(project, 'README.md'), 'init\n');
        git('add', '.');
        git('commit', '-qm', 'init');
        mkdirSync(join(project, '.claude/tmb'), { recursive: true });
        const dbPath = join(project, '.claude/tmb/trajectory.db');
        ops.initializeDatabase(dbPath);
        const scorerDir = allocate('flow-');
        return { project, scorerDir, dbPath, git };
      } catch (error) { cleanup(); throw error; }
    },
  };
}
