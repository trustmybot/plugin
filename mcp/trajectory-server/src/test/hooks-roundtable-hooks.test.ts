/**
 * Unit tests of the TypeScript roundtable and consultant hooks (GH 1692): the
 * divergences from their scripts/hooks/<gate>.sh that decision 703 allows
 * (no jq, no sqlite3 CLI, a multibyte character cut at byte 200), and the
 * bash read and jq semantics the parity corpus leans on.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { consultantPersistenceGate, recoveryMessage, stoppingAgent } from '../hooks/consultant-persistence-gate.js';
import { commandOnPath } from '../hooks/lib/persona.js';
import { roundtableAuqShape, shapeViolations } from '../hooks/roundtable-auq-shape.js';
import { missingSurfaces, roundtableCleanupPostcheck, roundtableIdField } from '../hooks/roundtable-cleanup-postcheck.js';
import { promptSummary, roundtableSlashDetect, slashInvoked } from '../hooks/roundtable-slash-detect.js';
import { buildSandbox } from './hooks-roundtable-parity.suite.js';

const CLOSE = 'mcp__plugin_tmb_trajectory-server__roundtable_close';

function slashRows(db: string): { summary: string; hex: string }[] {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    return d
      .prepare("SELECT summary, hex(summary) AS hex FROM audit WHERE event_type = 'roundtable_slash_invoked' ORDER BY id")
      .all() as unknown as { summary: string; hex: string }[];
  } finally {
    d.close();
  }
}

describe('roundtable and consultant hooks without jq or the sqlite3 CLI (decision 703)', () => {
  let base: string;
  let s: string;
  let emptyBin: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'tmb-roundtable-hooks-')));
    s = join(base, 'sandbox');
    emptyBin = join(base, 'empty-bin');
    mkdirSync(emptyBin);
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  const db = (): string => join(s, 'project/.claude/tmb/trajectory.db');
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: join(s, 'home'),
    CLAUDE_PROJECT_DIR: join(s, 'project'),
    TRAJECTORY_DB_PATH: db(),
    PATH: emptyBin,
    LC_ALL: 'C',
    ...extra,
  });

  it('the PATH under test holds neither jq nor sqlite3', () => {
    assert.equal(commandOnPath('jq', env()), false);
    assert.equal(commandOnPath('sqlite3', env()), false);
  });

  it('roundtable-slash-detect records the row through node:sqlite, where the .sh exits without jq or sqlite3', () => {
    buildSandbox(s);
    assert.deepEqual(roundtableSlashDetect('{"prompt":"/roundtable no tools"}', env()), { stdout: '', code: 0 });
    assert.deepEqual(
      slashRows(db()).map((r) => r.summary),
      ['User typed /roundtable: /roundtable no tools'],
    );
  });

  it('roundtable-cleanup-postcheck advises, where the .sh exits without jq or sqlite3', () => {
    buildSandbox(s);
    const r = roundtableCleanupPostcheck(JSON.stringify({ tool_name: CLOSE, tool_input: { roundtable_id: 3 } }), env());
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /^\[tmb roundtable-cleanup\] roundtable_id=3 closed but the following capture surfaces are missing: roundtable\.outcome votes\. /);
  });

  it('roundtable-auq-shape asks, where the .sh exits without jq or sqlite3', () => {
    buildSandbox(s);
    const payload = JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ multiSelect: false }, { multiSelect: true }] } });
    const out = JSON.parse(roundtableAuqShape(payload, env()).stdout) as { hookSpecificOutput: { permissionDecision: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(
      out.hookSpecificOutput.additionalContext,
      'roundtable-auq-shape: AskUserQuestion shape is invalid for ratification (roundtable #5 awaiting human).\n' +
        '  - Q1 must have multiSelect:true (agreements checkbox) during ratification\n' +
        '  - Q2 must not use multiSelect (disagreement radios only) during ratification\n\n' +
        'Expected shape: Q1 multiSelect=true (agreements); Q2..Qn radio (disagreements); total ≤4.',
    );
  });

  it('consultant-persistence-gate blocks, where the .sh lets the consultant stop without jq or sqlite3', () => {
    buildSandbox(s);
    const r = consultantPersistenceGate('{"subagent_type":"pm"}', env());
    assert.deepEqual(JSON.parse(r.stdout), { decision: 'block', reason: recoveryMessage('pm', '2') });
  });

  it('consultant-persistence-gate blocks on a corrupt DB, naming the DB it could not read', () => {
    buildSandbox(s);
    const bad = join(s, 'bad/.claude/tmb/trajectory.db');
    const r = consultantPersistenceGate('{"subagent_type":"pm"}', env({ TRAJECTORY_DB_PATH: bad }));
    const out = JSON.parse(r.stdout) as { decision: string; reason: string };
    assert.equal(out.decision, 'block');
    assert.equal(
      out.reason,
      `BLOCKED: trajectory DB unavailable — consultant-persistence-gate could not read ${bad} (read error: busy, corrupt, or unreadable), so it refuses to fail open. Check the trajectory DB and retry.`,
    );
  });

  it('roundtable-slash-detect stores U+FFFD for a multibyte character cut at byte 200, where the .sh stored its lone first byte', () => {
    buildSandbox(s);
    const prompt = `/roundtable ${'a'.repeat(187)}€ tail`;
    roundtableSlashDetect(JSON.stringify({ prompt }), env());
    const [row] = slashRows(db());
    assert.ok(row.hex.endsWith('61EFBFBD'), row.hex);
    assert.equal(row.summary, `User typed /roundtable: /roundtable ${'a'.repeat(187)}�`);
  });
});

describe('roundtable hook helpers', () => {
  it('promptSummary cuts at 200 bytes and drops trailing newlines like a $(...) capture', () => {
    assert.equal(promptSummary(`/roundtable ${'b'.repeat(300)}`), `/roundtable ${'b'.repeat(188)}`);
    assert.equal(promptSummary('/roundtable go\n\n\n'), '/roundtable go');
    assert.equal(promptSummary(`${'é'.repeat(100)}x`), 'é'.repeat(100));
  });

  it('slashInvoked matches the .sh case arms only', () => {
    assert.equal(slashInvoked('/roundtable x'), true);
    assert.equal(slashInvoked('a\n/roundtable'), true);
    assert.equal(slashInvoked('a /roundtable'), true);
    assert.equal(slashInvoked('docs/roundtable'), false);
    assert.equal(slashInvoked('a\t/roundtable'), false);
  });

  it('missingSurfaces reads the row like bash 3.2 `IFS=| read`, a lone trailing pipe of the outcome dropped', () => {
    assert.deepEqual(missingSurfaces('1|1|1|1|1|closed|proceed'), []);
    assert.deepEqual(missingSurfaces('1|1|1|1|1|closed||'), ['roundtable.outcome']);
    assert.deepEqual(missingSurfaces('1|1|1|1|1|closed|'), ['roundtable.outcome']);
    assert.deepEqual(missingSurfaces('1|1|1|1|1|closed|a|b'), []);
    assert.deepEqual(missingSurfaces('1|1|1|1|1|closed|||'), []);
    assert.deepEqual(missingSurfaces('1|1|1|1|1|closed|line one\nline two'), []);
    assert.deepEqual(missingSurfaces('2|1|0|0|0|collecting|'), [
      'decision-discussions',
      'roundtable.status=closed',
      'roundtable.outcome',
      'votes',
      'audit(roundtable_summary)',
    ]);
    assert.equal(missingSurfaces(''), null);
    assert.equal(missingSurfaces('x|1|1|1|1|closed|y'), null);
  });

  it('roundtableIdField keeps a number literal as jq prints it', () => {
    assert.equal(roundtableIdField('{"tool_input":{"roundtable_id":2}}\n'), '2');
    assert.equal(roundtableIdField('{"tool_input":{"roundtable_id":2.0}}\n'), '2.0');
    assert.equal(roundtableIdField('{"tool_input":{}}\n'), '');
  });

  it('shapeViolations follows jq length and indexing over non-array questions', () => {
    const auq = (questions: unknown): string => `${JSON.stringify({ tool_input: { questions } })}\n`;
    const q1 = 'Q1 must have multiSelect:true (agreements checkbox) during ratification';
    assert.equal(shapeViolations(auq([])), null);
    assert.equal(shapeViolations('{"tool_input":{}}\n'), null);
    assert.deepEqual(shapeViolations(auq([{ multiSelect: true }, { multiSelect: false }])), []);
    assert.deepEqual(shapeViolations(auq([{ multiSelect: true }, null, { multiSelect: null }])), []);
    assert.deepEqual(shapeViolations(auq([{ multiSelect: 'true' }])), [q1]);
    assert.deepEqual(shapeViolations(auq({ a: 1 })), [q1]);
    assert.deepEqual(shapeViolations(auq('ab')), [q1]);
    assert.deepEqual(shapeViolations(auq(3)), [q1]);
    assert.deepEqual(shapeViolations(auq(Array.from({ length: 5 }, () => ({ multiSelect: true })))), [
      'AUQ has 5 questions; max 4 allowed during ratification',
      'Q2 must not use multiSelect (disagreement radios only) during ratification',
      'Q3 must not use multiSelect (disagreement radios only) during ratification',
      'Q4 must not use multiSelect (disagreement radios only) during ratification',
      'Q5 must not use multiSelect (disagreement radios only) during ratification',
    ]);
  });

  it('stoppingAgent takes agent_type, then subagent_type, then tool_input.subagent_type, normalized', () => {
    assert.equal(stoppingAgent('{"agent_type":"tmb:cto","subagent_type":"pm"}\n'), 'cto');
    assert.equal(stoppingAgent('{"subagent_type":"pm"}\n'), 'pm');
    assert.equal(stoppingAgent('{"tool_input":{"subagent_type":"ceo"}}\n'), 'ceo');
    assert.equal(stoppingAgent('{}\n'), '');
  });
});
