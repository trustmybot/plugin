// L1 lint: no hook lib (scripts/hooks/lib/*.sh) decides an agent's role from a path. Flagged: a function whose name names a role (role, swe_context, swe_ctx, is_swe, is_bro, agent_type) that reads $PWD / $CWD / .cwd / a worktrees path; a role variable (AGENT_TYPE, AGENT_ROLE, ROLE, SWE_CTX, IS_SWE) assigned on a line that reads one; and, inside `case "$PWD"` / `case "$CWD"` (or another *CWD / *PWD variable), an arm that assigns a role variable or echoes yes / a role name. Every run also checks fixtures/bare-role-compare/role-from-path.sh is caught.
import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'l1-lint', 'fixtures', 'bare-role-compare', 'role-from-path.sh');
const HOOKS_LIB = join(ROOT, 'scripts', 'hooks', 'lib');
const FN_DEF = /^\s*(function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/;
const ROLE_FN = /(role|swe_context|swe_ctx|is_swe|is_bro|agent_type)/;
const PATH_READ = /(\$\{?PWD|\$\{?[A-Z_]*CWD|\.cwd|worktrees)/;
const ROLE_ASSIGN = /(AGENT_TYPE|AGENT_ROLE|ROLE|SWE_CTX|IS_SWE)=/;
const CASE_ON_PATH = /case\s+"?\$\{?[A-Z_]*(PWD|CWD)\}?"?\s+in/;
const ESAC = /(^|[\s;])esac([\s;]|$)/;
const ROLE_ECHO = /echo\s+"?(yes|swe|bro|code-reviewer)"?/;

function count(text, ch) {
  return text.split(ch).length - 1;
}

export function roleFromPath(file, label) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  let infn = '';
  let depth = 0;
  let incase = false;
  lines.forEach((raw, i) => {
    const report = (msg) => out.push(`${label}:${i + 1}: ${msg}`);
    const line = raw.replace(/^\s*#.*/, '');
    if (FN_DEF.test(line)) {
      const name = line.replace(/^\s*(function\s+)?/, '').replace(/\s*\(.*/, '');
      infn = ROLE_FN.test(name.toLowerCase()) ? name : '';
      depth = 0;
    }
    if (infn !== '') {
      if (PATH_READ.test(line)) report(`function ${infn} decides a role from a path`);
      depth += count(line, '{') - count(line, '}');
      if (depth <= 0 && line.includes('}')) infn = '';
    }
    if (/(^|[^A-Za-z0-9_])(AGENT_TYPE|AGENT_ROLE|ROLE|SWE_CTX|IS_SWE)=/.test(line) && PATH_READ.test(line)) report('role variable assigned from a path');
    if (CASE_ON_PATH.test(line)) incase = true;
    else if (incase && ESAC.test(line)) incase = false;
    else if (incase && (ROLE_ASSIGN.test(line) || ROLE_ECHO.test(line))) report('case on a path decides a role');
  });
  return out;
}

test('the role-from-path fixture is caught (at least three hits)', () => {
  assert.ok(existsSync(FIXTURE), `no-bare-role-compare self-test: fixture missing: ${FIXTURE}`);
  const hits = roleFromPath(FIXTURE, 'role-from-path.sh');
  assert.ok(hits.length >= 3, `no-bare-role-compare self-test: FAIL (role-from-path fixture: ${hits.length} hits, want >= 3)`);
  assert.ok(hits.some((h) => h.endsWith('function guess_role decides a role from a path')));
  assert.ok(hits.some((h) => h.endsWith('role variable assigned from a path')));
  assert.ok(hits.some((h) => h.endsWith('case on a path decides a role')));
});

test('no hook lib decides a role from a path', () => {
  const out = readdirSync(HOOKS_LIB, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && e.name.endsWith('.sh'))
    .map((e) => e.name)
    .sort()
    .flatMap((name) => roleFromPath(join(HOOKS_LIB, name), `scripts/hooks/lib/${name}`));
  assert.deepEqual(out, [], `${out.join('\n')}\n\nno-bare-role-compare: FAIL`);
});
