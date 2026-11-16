/**
 * The builtin skill seed in schema.sql carries each skills/<name>/SKILL.md
 * frontmatter description verbatim (GH 3059, 3067, 3121), and because the seed
 * is an upsert re-run on every open, an existing DB holding older text is
 * rewritten to it (GH 3124) while a reopen of a current DB writes nothing.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { TrajectoryDB } from '../db.js';
import { installRoot } from '../hooks/lib/project-env.js';
import { SCHEMA_V36_SQL } from './fixtures/schema-v36.js';
import { tempDB } from './helpers.js';

const PLUGIN_ROOT = installRoot(dirname(fileURLToPath(import.meta.url))) as string;

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmb-skill-seed-sync-'));
  tmpDirs.push(dir);
  return join(dir, 'trajectory.db');
}

/** The one-line `description:` value of a SKILL.md frontmatter block. */
function frontmatterDescription(skillMdPath: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(skillMdPath, 'utf8'));
  assert.ok(match, `${skillMdPath} has no frontmatter block`);
  const line = match[1].split('\n').find((l) => l.startsWith('description:'));
  assert.ok(line, `${skillMdPath} frontmatter has no description`);
  const value = line.slice('description:'.length).trim();
  assert.ok(
    value !== '' && !/^["'>|]/.test(value),
    `${skillMdPath} description must be a plain one-line scalar for this check to read it`,
  );
  return value;
}

type BuiltinRow = { name: string; description: string; file_path: string };

function builtinRows(db: TrajectoryDB): BuiltinRow[] {
  return db.all<BuiltinRow>(
    `SELECT name, description, file_path FROM cheatcodes WHERE origin = 'builtin' AND kind = 'skill' ORDER BY name`,
  );
}

function expectedDescriptions(rows: BuiltinRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.name, frontmatterDescription(join(PLUGIN_ROOT, r.file_path))]));
}

function assertMatchesFrontmatter(rows: BuiltinRow[]): void {
  const expected = expectedDescriptions(rows);
  for (const row of rows) {
    assert.equal(row.description, expected.get(row.name), `${row.name} seed description must equal its SKILL.md frontmatter`);
  }
}

function allCheatcodes(db: TrajectoryDB): Record<string, unknown>[] {
  return db.all<Record<string, unknown>>('SELECT * FROM cheatcodes ORDER BY id').map((r) => ({ ...r }));
}

describe('builtin skill seed — descriptions track SKILL.md frontmatter', () => {
  it('a fresh DB seeds all 13 builtin skills, each with its SKILL.md frontmatter description', () => {
    const db = tempDB();
    const rows = builtinRows(db);
    assert.equal(rows.length, 13, 'the seed holds the 13 shipped skills');
    for (const row of rows) {
      assert.equal(row.file_path, `skills/${row.name}/SKILL.md`, `${row.name} file_path`);
      assert.ok(existsSync(join(PLUGIN_ROOT, row.file_path)), `${row.name} is seeded but ${row.file_path} does not exist`);
    }
    assertMatchesFrontmatter(rows);
    db.close();
  });

  it('reopening a DB whose builtin rows hold old text rewrites them, and leaves non-builtin rows alone', () => {
    const dbPath = tmpDbPath();
    const first = new TrajectoryDB(dbPath);
    const stale = '2026-01-01T00:00:00.000Z';
    first.run(`UPDATE cheatcodes SET description = 'old text', updated_at = ? WHERE origin = 'builtin'`, [stale]);
    // A marketplace skill that took a builtin's name must keep its own text.
    first.run(`DELETE FROM cheatcodes WHERE name = 'tmb_review' AND origin = 'builtin'`);
    first.run(
      `INSERT INTO cheatcodes (name, kind, origin, description, source_url, file_path, scope, status, installed_at, created_at, updated_at)
       VALUES ('tmb_review', 'skill', 'marketplace', 'third-party review skill', 'https://example.test/tmb_review',
               '.claude/skills/tmb_review/SKILL.md', 'project-local', 'installed', ?, ?, ?)`,
      [stale, stale, stale],
    );
    first.run(
      `INSERT INTO cheatcodes (name, kind, origin, description, source_url, scope, status, installed_at, created_at, updated_at)
       VALUES ('pdf', 'plugin', 'marketplace', 'pdf tooling', 'https://example.test/pdf', 'project-local', 'installed', ?, ?, ?)`,
      [stale, stale, stale],
    );
    const nonBuiltinBefore = first.all<Record<string, unknown>>(
      `SELECT * FROM cheatcodes WHERE origin != 'builtin' ORDER BY id`,
    ).map((r) => ({ ...r }));
    first.close();

    const db = new TrajectoryDB(dbPath);
    const rows = builtinRows(db);
    assert.equal(rows.length, 12, 'every builtin but the displaced tmb_review is present');
    assertMatchesFrontmatter(rows);
    for (const row of db.all<{ name: string; updated_at: string }>(
      `SELECT name, updated_at FROM cheatcodes WHERE origin = 'builtin'`,
    )) {
      assert.notEqual(row.updated_at, stale, `${row.name} updated_at moves when its description is rewritten`);
    }
    const nonBuiltinAfter = db.all<Record<string, unknown>>(
      `SELECT * FROM cheatcodes WHERE origin != 'builtin' ORDER BY id`,
    ).map((r) => ({ ...r }));
    assert.deepEqual(nonBuiltinAfter, nonBuiltinBefore, 'non-builtin rows are untouched by the reseed');
    db.close();
  });

  it('migrating a DB built from the frozen v36 schema rewrites its old builtin descriptions', () => {
    const dbPath = tmpDbPath();
    const raw = new DatabaseSync(dbPath);
    raw.exec(SCHEMA_V36_SQL);
    const oldPlanning = raw
      .prepare(`SELECT description FROM cheatcodes WHERE name = 'tmb_planning'`)
      .get() as { description: string };
    raw.close();

    const db = new TrajectoryDB(dbPath, undefined, { migrate: true });
    const rows = builtinRows(db);
    assert.equal(rows.length, 13);
    assertMatchesFrontmatter(rows);
    const planning = rows.find((r) => r.name === 'tmb_planning');
    assert.notEqual(planning?.description, oldPlanning.description, 'the v36 fixture text is replaced');
    db.close();
  });

  it('reopening a current DB changes no cheatcodes row', () => {
    const dbPath = tmpDbPath();
    const first = new TrajectoryDB(dbPath);
    const before = allCheatcodes(first);
    first.close();

    const db = new TrajectoryDB(dbPath);
    assert.deepEqual(allCheatcodes(db), before, 'a reopen leaves every cheatcodes row, updated_at included, as it was');
    db.close();
  });
});
