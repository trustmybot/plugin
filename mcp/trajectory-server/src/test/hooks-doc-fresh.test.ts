/**
 * The docs/reference/REFERENCE.md hook table and hooks/hooks.json agree both
 * ways (GH 1692). Every row is a `<name>.ts` naming a gate source under
 * mcp/trajectory-server/src/hooks/ that hooks.json registers (a gate
 * dist/hooks-router.txt lists for a router entry's event, or the Stop entry
 * `dist/hooks.js liveness-sentinel`, the one registration outside the router),
 * so a deleted or unwired hook cannot leave a stale row; every hook hooks.json
 * registers has a row. scripts/hooks/README.md opens its entry-point section
 * with the router as every registration but that sentinel, and names no shell
 * script and no shell helpers. A self-test plants each failure in a copied tree.
 */
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PLUGIN_ROOT, routerGates, routerTable } from './hooks-router-table.js';

const HOOKS_SRC = 'mcp/trajectory-server/src/hooks';
const REFERENCE = 'docs/reference/REFERENCE.md';
const README = 'scripts/hooks/README.md';
const README_ROUTER = 'Every `hooks/hooks.json` command is the TypeScript router, `node dist/hooks.js <Event> [part]`';
/** A shell script name, or the shell helpers lib/ no longer holds. */
const README_STALE = /\.sh\b|shell helpers/;

/** Every gate hooks.json runs, the router entries expanded to their dist/hooks-router.txt gates. */
function registered(root: string): string[] {
  const json = readFileSync(join(root, 'hooks/hooks.json'), 'utf8');
  const table = routerTable(root);
  const events = new Set([...json.matchAll(/dist\/hooks\.js\\" ([A-Za-z]+)/g)].map((m) => m[1]));
  const direct = [...json.matchAll(/dist\/hooks\.js\\" ([a-z][a-z0-9-]*)"/g)].map((m) => m[1]);
  return [...new Set([...[...events].flatMap((e) => routerGates(table, e)), ...direct])].sort();
}

/** The `<name>.<ext>` cells of the REFERENCE.md hook table (the section under `## Hooks`). */
function rows(root: string): string[] {
  let on = false;
  const out: string[] = [];
  for (const line of readFileSync(join(root, REFERENCE), 'utf8').split('\n')) {
    if (line.startsWith('## Hooks')) {
      on = true;
      continue;
    }
    if (on && line.startsWith('## ')) on = false;
    const m = on ? /^\| `([a-z0-9-]+\.[a-z]+)`/.exec(line) : null;
    if (m !== null) out.push(m[1]);
  }
  return out;
}

function checkTree(root: string): { rows: number; errors: string[] } {
  const errors: string[] = [];
  const gates = registered(root);
  const cells = rows(root);
  for (const row of cells) {
    const hook = row.replace(/\.[^.]*$/, '');
    if (!row.endsWith('.ts') || !existsSync(join(root, HOOKS_SRC, row))) {
      errors.push(`${REFERENCE} lists ${row}, which is not a gate in ${HOOKS_SRC}/`);
    } else if (!gates.includes(hook)) {
      errors.push(`${REFERENCE} lists ${row}, which hooks/hooks.json does not register`);
    }
  }
  for (const hook of gates) {
    if (!cells.includes(`${hook}.ts`)) errors.push(`hooks/hooks.json registers ${hook}, which has no ${hook}.ts row in the ${REFERENCE} hook table`);
  }
  if (cells.length === 0) errors.push(`${REFERENCE} has no hook table under ## Hooks`);
  const readme = readFileSync(join(root, README), 'utf8');
  if (!readme.includes(README_ROUTER)) errors.push(`${README} does not say every hooks/hooks.json command is the router`);
  const stale = README_STALE.exec(readme);
  if (stale) errors.push(`${README} names "${stale[0]}", but no shell script or shell helper remains`);
  return { rows: cells.length, errors };
}

describe('hooks-doc-fresh: the REFERENCE.md hook rows are real, wired hooks', () => {
  it('the REFERENCE.md hook rows and the hooks hooks.json registers match, and scripts/hooks/README.md names the router', () => {
    const { rows: n, errors } = checkTree(PLUGIN_ROOT);
    assert.deepEqual(errors, []);
    assert.ok(n > 0);
  });
});

describe('hooks-doc-fresh self-test: each planted drift fails naming it', () => {
  let tmp: string;
  let tree: string;
  const reference = () => readFileSync(join(PLUGIN_ROOT, REFERENCE), 'utf8');
  const setReference = (text: string) => writeFileSync(join(tree, REFERENCE), text);

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tmb-hooks-doc-fresh-'));
    tree = join(tmp, 't');
    for (const f of ['hooks/hooks.json', 'mcp/trajectory-server/dist/hooks-router.txt', README, REFERENCE]) {
      mkdirSync(dirname(join(tree, f)), { recursive: true });
      cpSync(join(PLUGIN_ROOT, f), join(tree, f));
    }
    cpSync(join(PLUGIN_ROOT, HOOKS_SRC), join(tree, HOOKS_SRC), { recursive: true });
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('a row for a missing gate or a .sh row fails naming it', () => {
    const lines = reference().split('\n');
    const header = lines.findIndex((l) => /^\| Hook \| Trigger \| Purpose \|/.test(l));
    assert.ok(header >= 0, 'REFERENCE.md has the hook table header');
    lines.splice(header + 2, 0, '| `deleted-hook.ts` | Stop | gone |', '| `git-guards.sh` | PreToolUse Bash | a shell row |');
    setReference(lines.join('\n'));
    const { errors } = checkTree(tree);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('deleted-hook.ts')), errors.join('\n'));
    assert.ok(errors.some((e) => e.includes('git-guards.sh, which is not a gate')), errors.join('\n'));
  });

  it('a registered hook with no row fails naming it', () => {
    setReference(reference().split('\n').filter((l) => !l.startsWith('| `orphan-scan.ts` |')).join('\n'));
    const { errors } = checkTree(tree);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((e) => e.includes('orphan-scan, which has no orphan-scan.ts row')), errors.join('\n'));
  });

  for (const [planted, named] of [
    ['Every gate runs through `dispatch.sh`.', '.sh'],
    ['This directory keeps the shared shell helpers in `lib/`.', 'shell helpers'],
  ] as const) {
    it(`a README naming ${named} fails`, () => {
      setReference(reference());
      cpSync(join(PLUGIN_ROOT, README), join(tree, README));
      appendFileSync(join(tree, README), `${planted}\n`);
      const { errors } = checkTree(tree);
      assert.ok(errors.some((e) => e.includes(`scripts/hooks/README.md names "${named}"`)), errors.join('\n'));
    });
  }

  it('a README without the router sentence fails', () => {
    setReference(reference());
    writeFileSync(join(tree, README), readFileSync(join(PLUGIN_ROOT, README), 'utf8').replace(README_ROUTER, 'Gates run.'));
    const { errors } = checkTree(tree);
    assert.ok(errors.some((e) => e.includes('scripts/hooks/README.md does not say')), errors.join('\n'));
  });
});
