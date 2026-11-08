import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TrajectoryDB } from '../db.js';
import { envTools } from '../tools/env.js';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FIXTURE = join(PLUGIN_ROOT, 'tests', 'fixtures', 'env', 'pnpm-eslint-tsc-vitest');

type RawResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type Json = Record<string, unknown>;

const temps: string[] = [];
after(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// A file DB holding repo `app` whose path is a fresh copy of a fixture; `migrated` opens it from a v57 shape.
function setup(kind: 'fresh' | 'migrated'): { db: TrajectoryDB; root: string } {
  const dir = tempDir(`tmb-env-store-${kind}-`);
  const dbPath = join(dir, 'trajectory.db');
  if (kind === 'migrated') {
    const v57 = new TrajectoryDB(dbPath);
    v57.run('DROP TABLE repo_env');
    v57.run('UPDATE plugin_meta SET schema_version = 57');
    v57.close();
  }
  const db = new TrajectoryDB(dbPath, undefined, { migrate: true });
  const root = join(dir, 'app');
  cpSync(FIXTURE, root, { recursive: true, filter: (src) => basename(src) !== 'expected.json' });
  db.run(`INSERT INTO repos (name, path) VALUES ('app', ?)`, [root]);
  return { db, root };
}

async function call(db: TrajectoryDB, tool: string, args: Json): Promise<{ isError: boolean; body: Json }> {
  const r = (await envTools(db).handlers[tool]!(args)) as unknown as RawResult;
  return { isError: r.isError === true, body: JSON.parse(r.content[0]!.text) as Json };
}

const candidate = (command: string): Json => ({
  command,
  source: 'package.json:9',
  confidence: 0.9,
  probe: null,
  provenance: { kind: 'existing_repo' },
});

function profile(evidenceHash: string, extra: Json = {}): Json {
  return {
    package_path: '.',
    ecosystem: 'node',
    package_manager: 'pnpm',
    commands: {
      install: [candidate('pnpm install --frozen-lockfile')],
      test: [candidate('pnpm test')],
      lint: [candidate('pnpm lint')],
      format_check: [candidate('pnpm format:check')],
      typecheck: [candidate('pnpm typecheck')],
    },
    globs: ['src/**/*.ts'],
    status: 'detected',
    evidence_hash: evidenceHash,
    ...extra,
  };
}

async function currentHash(db: TrajectoryDB): Promise<string> {
  const detected = await call(db, 'env_detect', { agent: 'swe', repo: 'app' });
  assert.equal(detected.isError, false, JSON.stringify(detected.body));
  return (detected.body['packages'] as Json[])[0]!['evidence_hash'] as string;
}

function row(db: TrajectoryDB): Json {
  return { ...db.get<Json>(`SELECT * FROM repo_env WHERE repo = 'app' AND package_path = '.' AND ecosystem = 'node'`)! };
}

for (const kind of ['fresh', 'migrated'] as const) {
  describe(`GH 2066 repo_env store (${kind} DB)`, () => {
    it('GH 2066 env_record fills every column; overrides, waivers and declined through their own calls', async () => {
      const { db } = setup(kind);
      const hash = await currentHash(db);
      const first = await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash)] });
      assert.equal(first.isError, false, JSON.stringify(first.body));
      const stored = row(db);
      for (const col of ['id', 'repo', 'package_path', 'ecosystem', 'package_manager', 'commands_json', 'globs_json', 'status', 'detected_at', 'evidence_hash', 'updated_at']) {
        assert.notEqual(stored[col], null, col);
      }
      assert.equal(stored['confirmed_by'], null, 'confirmed_by stays null until the Human confirms');
      assert.equal(stored['runner_prefix'], null, 'runner_prefix is null when there is no prefix');
      assert.equal(stored['overrides_json'], null);
      assert.equal(stored['waivers_json'], null);
      assert.equal(stored['declined_json'], null);
      assert.equal(stored['evidence_hash'], hash);

      await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash, { overrides: { test: [candidate('pnpm vitest run --reporter=dot')] } })] });
      await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash, { waivers: [{ category: 'typecheck', reason: 'no types yet' }] })] });
      await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash, { declined: [{ item: 'husky', kind: 'dev_dependency', reason: 'git hook only' }] })] });
      const full = row(db);
      for (const [col, value] of Object.entries(full)) {
        if (col === 'confirmed_by' || col === 'runner_prefix') continue;
        assert.notEqual(value, null, col);
      }
      assert.deepEqual(JSON.parse(full['waivers_json'] as string), [
        { category: 'typecheck', reason: 'no types yet', by: 'bro', at: (JSON.parse(full['waivers_json'] as string) as Json[])[0]!['at'] },
      ]);
      const declined = JSON.parse(full['declined_json'] as string) as Json[];
      assert.equal(declined.length, 1);
      assert.equal(declined[0]!['evidence_hash'], hash, 'declined defaults to the profile evidence_hash');
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM repo_env')!.n, 1, 'one row per key');
      db.close();
    });

    it('GH 2066 an override survives a re-record without overrides; commands are replaced; env_get merges', async () => {
      const { db } = setup(kind);
      const hash = await currentHash(db);
      await call(db, 'env_record', {
        agent: 'bro',
        repo: 'app',
        profiles: [profile(hash, { overrides: { lint: [candidate('pnpm eslint . --max-warnings=0')] } })],
      });
      const changed = profile(hash);
      (changed['commands'] as Json)['test'] = [candidate('pnpm test -- --run')];
      const again = await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [changed] });
      assert.equal(again.isError, false, JSON.stringify(again.body));
      const stored = row(db);
      assert.deepEqual(JSON.parse(stored['overrides_json'] as string), { lint: [candidate('pnpm eslint . --max-warnings=0')] });
      assert.deepEqual((JSON.parse(stored['commands_json'] as string) as Json)['test'], [candidate('pnpm test -- --run')]);

      const got = await call(db, 'env_get', { agent: 'code-reviewer', repo: 'app' });
      assert.equal(got.isError, false);
      const effective = (got.body['profiles'] as Json[])[0]!['effective_commands'] as Json;
      assert.deepEqual(effective['lint'], [candidate('pnpm eslint . --max-warnings=0')]);
      assert.deepEqual(effective['test'], [candidate('pnpm test -- --run')]);
      assert.deepEqual(effective['typecheck'], [candidate('pnpm typecheck')]);

      await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash, { overrides: { lint: null } })] });
      assert.equal(row(db)['overrides_json'], '{}', 'a null override drops that category');
      db.close();
    });

    it('GH 2066 env_record from swe is refused and writes nothing', async () => {
      const { db } = setup(kind);
      const hash = await currentHash(db);
      const refused = await call(db, 'env_record', { agent: 'swe', repo: 'app', profiles: [profile(hash)] });
      assert.equal(refused.isError, true);
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM repo_env')!.n, 0);
      db.close();
    });

    it('GH 2066 env_record refuses an invalid profile without a partial write', async () => {
      const { db } = setup(kind);
      const hash = await currentHash(db);
      const bad = profile(hash, { package_path: 'other' });
      (bad['commands'] as Json)['deploy'] = [];
      const r = await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash), bad] });
      assert.equal(r.isError, true);
      assert.equal(r.body['error'], 'invalid_profile');
      assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM repo_env')!.n, 0);
      const web = profile(hash);
      (web['commands'] as Json)['test'] = [{ ...candidate('pnpm test'), provenance: { kind: 'web' } }];
      assert.equal((await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [web] })).isError, true, 'web provenance needs urls and fetched_at');
      const missing = await call(db, 'env_record', { agent: 'bro', repo: 'nope', profiles: [profile(hash)] });
      assert.equal(missing.body['error'], 'repo_not_found');
      db.close();
    });

    it('GH 2066 env_detect writes nothing and reports drifted after an evidence edit', async () => {
      const { db, root } = setup(kind);
      const hash = await currentHash(db);
      await call(db, 'env_record', { agent: 'bro', repo: 'app', profiles: [profile(hash)] });
      const before = JSON.stringify(row(db));
      const clean = await call(db, 'env_detect', { agent: 'swe', repo: 'app' });
      assert.deepEqual(clean.body['stored'], [{ package_path: '.', ecosystem: 'node', evidence_hash: hash, current_hash: hash, drifted: false }]);
      writeFileSync(join(root, 'package.json'), readFileSync(join(root, 'package.json'), 'utf8').replace('"vitest run"', '"vitest run --coverage"'));
      const drifted = await call(db, 'env_detect', { agent: 'consultant', repo: 'app' });
      const stored = (drifted.body['stored'] as Json[])[0]!;
      assert.equal(stored['drifted'], true);
      assert.notEqual(stored['current_hash'], hash);
      assert.equal(JSON.stringify(row(db)), before, 'env_detect wrote nothing');
      assert.equal((await call(db, 'env_detect', { agent: 'swe', repo: 'nope' })).body['error'], 'repo_not_found');
      db.close();
    });
  });
}
