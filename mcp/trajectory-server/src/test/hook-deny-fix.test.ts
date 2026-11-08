/**
 * Every hook deny or block names the agent's next move (GH 1914): lib/deny.ts
 * appends ` Allowed form: <form>` or ` This is policy: stop and report.`, no
 * other non-test file under src/hooks/ builds deny or block JSON itself, the
 * preflight's JSON reason carries a `fix` key, and every recorded deny or
 * block in tests/fixtures/hook-golden/ ends with one of the two endings.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { codeReviewerPreflight } from '../hooks/code-reviewer-preflight.js';
import {
  ALLOWED_FORM,
  blockResult,
  denyJson,
  denyResult,
  endsWithFix,
  fixedReason,
  passthroughDeny,
  POLICY_ENDING,
  structuredDenyResult,
} from '../hooks/lib/deny.js';
import { GOLDEN_DIR } from './golden.js';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS_SRC = join(SERVER_ROOT, 'src/hooks');
const DENY_LITERAL = /permissionDecision\s*:\s*['"]deny['"]|decision\s*:\s*['"]block['"]/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}

/** Each deny or block reason in <text>: one per JSON line that is a PreToolUse deny or a block. */
function reasonsIn(text: string): string[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trimStart().startsWith('{')) return [];
    let o: { hookSpecificOutput?: { permissionDecision?: unknown; permissionDecisionReason?: unknown }; decision?: unknown; reason?: unknown };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      return [];
    }
    if (o.hookSpecificOutput?.permissionDecision === 'deny') return [String(o.hookSpecificOutput.permissionDecisionReason ?? '')];
    if (o.decision === 'block') return [String(o.reason ?? '')];
    return [];
  });
}

function structuredFix(reason: string): unknown {
  try {
    const parsed = JSON.parse(reason) as unknown;
    return parsed !== null && typeof parsed === 'object' && 'fix' in parsed ? (parsed as { fix: unknown }).fix : undefined;
  } catch {
    return undefined;
  }
}

describe('hook deny fix', () => {
  describe('lib/deny.ts', () => {
    it('appends the allowed-form ending, dropping trailing whitespace', () => {
      const r = fixedReason('BLOCKED: x. ', { allowed: 'git -C <path> status' });
      assert.equal(r, `BLOCKED: x.${ALLOWED_FORM}git -C <path> status`);
      assert.ok(r.endsWith(' Allowed form: git -C <path> status'));
      assert.ok(endsWithFix(r));
    });

    it('appends the policy ending', () => {
      const r = fixedReason('BLOCKED: x.', 'policy');
      assert.equal(r, 'BLOCKED: x. This is policy: stop and report.');
      assert.ok(r.endsWith(POLICY_ENDING));
      assert.ok(endsWithFix(r));
    });

    it('endsWithFix rejects a reason with no ending or an empty allowed form', () => {
      assert.equal(endsWithFix('BLOCKED: x.'), false);
      assert.equal(endsWithFix(`BLOCKED: x.${ALLOWED_FORM} `), false);
    });

    it('every builder emits its reason with the ending', () => {
      const fix = { allowed: 'the same call again' } as const;
      const deny = JSON.parse(denyJson('BLOCKED: d.', fix));
      assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(deny.hookSpecificOutput.permissionDecisionReason, fixedReason('BLOCKED: d.', fix));
      assert.equal(denyResult('BLOCKED: d.', 'policy').stdout, `${denyJson('BLOCKED: d.', 'policy')}\n`);
      assert.deepEqual(JSON.parse(blockResult('BLOCKED: b.', 'policy').stdout), { decision: 'block', reason: fixedReason('BLOCKED: b.', 'policy') });
      const structured = JSON.parse(structuredDenyResult({ check: 'c' }, fix).stdout);
      assert.deepEqual(JSON.parse(structured.hookSpecificOutput.permissionDecisionReason), { check: 'c', fix });
    });

    it('the router passthrough re-emits a reason unchanged', () => {
      const reason = fixedReason('BLOCKED: r.', 'policy');
      assert.equal(JSON.parse(passthroughDeny(reason, 'PreToolUse')).hookSpecificOutput.permissionDecisionReason, reason);
      assert.deepEqual(JSON.parse(passthroughDeny(reason, 'Stop')), { decision: 'block', reason });
    });
  });

  it('no non-test file under src/hooks/ but lib/deny.ts builds deny or block JSON', () => {
    const offenders = tsFiles(HOOKS_SRC)
      .filter((path) => relative(HOOKS_SRC, path) !== join('lib', 'deny.ts'))
      .filter((path) => DENY_LITERAL.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SERVER_ROOT, path));
    assert.deepEqual(offenders, []);
  });

  it('the lint pattern catches each spelling', () => {
    for (const text of ["permissionDecision: 'deny'", 'permissionDecision: "deny"', "decision: 'block'", 'decision: "block"']) {
      assert.ok(DENY_LITERAL.test(text), text);
    }
  });

  describe('code-reviewer-preflight', () => {
    let root: string;
    before(() => {
      root = mkdtempSync(join(tmpdir(), 'tmb-deny-fix-'));
    });
    after(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("a deny's parsed reason carries a non-null fix", async () => {
      const db = join(root, '.claude/tmb/trajectory.db');
      mkdirSync(dirname(db), { recursive: true });
      const d = new DatabaseSync(db);
      d.exec(readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8'));
      const now = '2026-11-08T10:00:00.000Z';
      d.prepare("INSERT INTO repos (name, path, target_branch) VALUES ('repo', ?, 'dev')").run(join(root, 'missing-repo'));
      d.prepare("INSERT INTO issues (id, objective, status, created_at, updated_at) VALUES (9, 'o', 'open', ?, ?)").run(now, now);
      d.prepare(
        "INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, description, status, repo, created_at, updated_at) VALUES (3, 9, 'feat/3-x', 'dev', 'd', 'closed', 'repo', ?, ?)",
      ).run(now, now);
      d.close();
      const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'code-reviewer', prompt: 'task_id=3' } });
      const r = await codeReviewerPreflight(payload, { PATH: process.env.PATH, HOME: join(root, 'home'), TRAJECTORY_DB_PATH: db });
      const reasons = reasonsIn(r.stdout);
      assert.equal(reasons.length, 1, r.stdout);
      const fix = structuredFix(reasons[0]) as { allowed?: unknown } | undefined;
      assert.ok(fix !== undefined && fix !== null, reasons[0]);
      assert.equal(typeof fix.allowed, 'string');
    });
  });

  it('every deny or block reason in the hook goldens ends with an ending', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const name of readdirSync(GOLDEN_DIR).filter((n) => n.endsWith('.json'))) {
      const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as unknown;
      for (const reason of strings(golden).flatMap(reasonsIn)) {
        seen += 1;
        const fix = structuredFix(reason);
        if (endsWithFix(reason) || (fix !== undefined && fix !== null)) continue;
        bad.push(`${name}: ${reason.slice(-160)}`);
      }
    }
    assert.ok(seen > 0, 'expected recorded denies');
    assert.deepEqual(bad, []);
  });
});
