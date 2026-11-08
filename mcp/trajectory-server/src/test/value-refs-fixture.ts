// A fixture repo for the value-reference, static-receiver, extends and JSX
// caller edges (GH 1988 part E), written to disk and indexed for real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TrajectoryDB } from '../db.js';
import { indexRepoSymbols } from '../symbol-index.js';

export const VALUE_REF_FILES: Record<string, string> = {
  'src/a.ts': [
    'export function alpha(): number {',
    '  return 1;',
    '}',
    'export class Base {}',
    'export class Klass {',
    '  static staticFn(): number {',
    '    return 2;',
    '  }',
    '}',
    'export class Gamma {}',
    'export class Timer {',
    '  setTimeout(): void {}',
    '}',
    '',
  ].join('\n'),
  'src/c.ts': [
    "import { setTimeout as sleep } from 'node:timers/promises';",
    "import { Gamma as BaseGamma } from './a.js';",
    'export async function waits(): Promise<void> {',
    '  await sleep(1);',
    '}',
    'export class Gamma extends BaseGamma {}',
    '',
  ].join('\n'),
  'src/b.ts': [
    "import { alpha, Base, Klass } from './a.js';",
    "import { Base as Alias } from './a.js';",
    'declare function run(f: () => number, o: object): void;',
    'export function passesAlpha(): void {',
    '  run(alpha, { alpha });',
    '}',
    'export function shadowsAlpha(alpha: () => number): void {',
    '  run(alpha, { alpha });',
    '}',
    'export function localAlpha(): void {',
    '  const alpha = () => 3;',
    '  run(alpha, { alpha });',
    '}',
    'export function usesKlass(): number {',
    '  return Klass.staticFn();',
    '}',
    'export class Sub extends Base {}',
    'export class AliasSub extends Alias {}',
    '',
  ].join('\n'),
  'src/ui.tsx': [
    'export function Button(): null {',
    '  return null;',
    '}',
    'export function TreeView(props: { children?: unknown }): null {',
    '  return null;',
    '}',
    'export function Page(): unknown {',
    '  return (',
    '    <div>',
    '      <TreeView>',
    '        <Button />',
    '      </TreeView>',
    '    </div>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

export async function indexValueRefFixture(db: TrajectoryDB, repo: string, root: string): Promise<void> {
  for (const [p, body] of Object.entries(VALUE_REF_FILES)) {
    mkdirSync(join(root, dirname(p)), { recursive: true });
    writeFileSync(join(root, p), body);
    db.run(`INSERT INTO wm_files (repo, path, dir, purpose, content_md5, size_bytes, updated_at) VALUES (?, ?, ?, '', ?, ?, datetime('now'))`, [
      repo,
      p,
      dirname(p),
      createHash('md5').update(body).digest('hex'),
      Buffer.byteLength(body),
    ]);
  }
  const stats = await indexRepoSymbols(db, repo, root);
  assert.equal(stats.files_failed, 0);
}
