// Temp fixture dirs under mcp/trajectory-server/src/eslint-fixture-*: the server tsconfig excludes them,
// so each carries its own tsconfig.json for typescript-eslint's projectService to find.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp', 'trajectory-server', 'src');

export function makeFixtureDir() {
  const dir = mkdtempSync(join(SERVER_SRC, 'eslint-fixture-'));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { rootDir: '.' }, include: ['*.ts'], exclude: [] }),
  );
  return dir;
}
