/**
 * The incremental bro-turn-usage read (GH 2699): a per-session cursor next to
 * the trajectory DB lets each Stop read only the appended transcript tail, and
 * the row it finishes deep-equals turnUsage over the whole file. Every
 * cursor that no longer fits falls back to the full read.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { broTurnUsage, cursorPath, transcriptRead, transcriptUsage, turnUsage, type TurnUsage } from '../hooks/bro-turn-usage.js';
import { ALLOW } from '../hooks/gate.js';

const fsModule = createRequire(import.meta.url)('node:fs') as Record<string, unknown>;

/** Runs <fn> with node:fs's <name> replaced for every ESM importer, the original restored after. */
function withFs<T>(name: 'fstatSync' | 'readSync', replace: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown, fn: () => T): T {
  const original = fsModule[name] as (...args: unknown[]) => unknown;
  fsModule[name] = replace(original);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fsModule[name] = original;
    syncBuiltinESMExports();
  }
}

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(join(SERVER_ROOT, 'src/schema.sql'), 'utf8');
const SESSION = 'sess-incremental';

let sandbox: string;
let seq = 0;

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 10, 0, s)).toISOString();

function assistant(s: number, id: string | null, model: string, usage: unknown, extra: Record<string, unknown> = {}, tools = 0): string {
  const content: unknown[] = [{ type: 'text', text: 'réponse' }];
  for (let i = 0; i < tools; i += 1) content.push({ type: 'tool_use', id: `tu_${s}_${i}`, name: 'Read', input: {} });
  const message: Record<string, unknown> = { model, usage, content };
  if (id !== null) message.id = id;
  return `${JSON.stringify({ type: 'assistant', timestamp: at(s), ...extra, message })}\n`;
}

const user = (s: number, text: string) => `${JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } })}\n`;
const u = (i: number, o: number, cr = 0, cc = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cc });

/** Repeated ids across chunks, uuid and line-<i> fallbacks, a sidechain, three models and tool_use blocks. */
const FIXTURE = [
  user(0, 'go'),
  assistant(1, 'msg_a', 'claude-alpha', 'not-an-object', {}, 1),
  assistant(2, 'msg_a', 'claude-alpha', u(3, 10, 100, 1000), {}, 2),
  assistant(3, null, 'claude-beta', u(4, 20), { uuid: 'uuid-1' }),
  assistant(4, 'msg_side', 'claude-side', u(999, 999), { isSidechain: true }, 3),
  user(5, 'more'),
  assistant(6, null, 'claude-beta', u(5, 30)),
  assistant(7, 'msg_b', 'claude-gamma', u(1, 1), {}, 1),
  assistant(8, null, 'claude-alpha', u(2, 2)),
  assistant(9, 'msg_b', 'claude-gamma', u(7, 70, 7, 7), {}, 1),
  assistant(10, 'msg_a', 'claude-alpha', u(6, 60, 600, 6000), {}, 1),
  assistant(11, null, 'claude-beta', u(1, 1), { uuid: 'uuid-1' }, 1),
  `{"type":"assistant","timestamp":"${at(12)}","message":{"id":{"k":[1,-0,1e400]},"model":"claude-alpha","usage":${JSON.stringify(u(1, 1))},"content":[]}}\n`,
  `{"type":"assistant","timestamp":"${at(13)}","message":{"id":{"k":[1,0,1e401]},"model":"claude-alpha","usage":${JSON.stringify(u(2, 2))},"content":[]}}\n`,
].join('');

function fresh(name: string): { db: string; env: NodeJS.ProcessEnv; transcript: string; cursor: string } {
  seq += 1;
  const db = join(sandbox, `case-${seq}/.claude/tmb/trajectory.db`);
  mkdirSync(dirname(db), { recursive: true });
  const d = new DatabaseSync(db);
  d.exec(SCHEMA);
  d.close();
  const transcript = join(sandbox, `case-${seq}`, `${name}.jsonl`);
  return {
    db,
    env: { PATH: process.env.PATH, HOME: join(sandbox, 'home'), TRAJECTORY_DB_PATH: db },
    transcript,
    cursor: cursorPath(db, SESSION) as string,
  };
}

function stop(env: NodeJS.ProcessEnv, transcript: string, session = SESSION): void {
  assert.deepEqual(broTurnUsage(JSON.stringify({ session_id: session, transcript_path: transcript }), env), { stdout: '', code: 0 });
}

function row(db: string, session = SESSION): Record<string, unknown> | undefined {
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    const r = d
      .prepare(
        "SELECT tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, tool_uses, model, started_at, completed_at FROM agent_runs WHERE agent_type = 'bro' AND session_id = ?",
      )
      .get(session);
    return r === undefined ? undefined : { ...r };
  } finally {
    d.close();
  }
}

function rowOf(t: TurnUsage): Record<string, unknown> {
  return {
    tokens_in: Number(t.tokensIn),
    tokens_out: Number(t.tokensOut),
    cache_read_tokens: Number(t.cacheRead),
    cache_creation_tokens: Number(t.cacheCreation),
    tool_uses: Number(t.toolUses),
    model: t.model,
    started_at: t.first,
    completed_at: t.last,
  };
}

const full = (transcript: string) => turnUsage(readFileSync(transcript, 'utf8'));
const cursorOffset = (cursor: string) => (JSON.parse(readFileSync(cursor, 'utf8')) as { offset: number }).offset;
const upToLastNewline = (bytes: Buffer) => bytes.lastIndexOf(0x0a) + 1;

/** The bytes this call of transcriptUsage reads, and its row. */
function measured(transcript: string, cursor: string | null): { usage: TurnUsage | null; bytes: number } {
  const before = transcriptRead.bytes;
  const usage = transcriptUsage(transcript, cursor);
  return { usage, bytes: transcriptRead.bytes - before };
}

function bigTranscript(lines: number): string {
  const out: string[] = [user(0, 'start')];
  for (let i = 1; i <= lines; i += 1) out.push(assistant(i % 50, `msg_${i}`, i % 3 === 0 ? 'claude-beta' : 'claude-alpha', u(i, 2 * i, 3 * i, 4 * i), {}, i % 2));
  return out.join('');
}

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tmb-btu-incremental-'));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('bro-turn-usage incremental read equals the full read', () => {
  it('a transcript appended in chunks, split mid-line and mid-character, matches turnUsage(full) after every Stop', () => {
    const { transcript, cursor } = fresh('chunks');
    const bytes = Buffer.from(FIXTURE, 'utf8');
    const accent = bytes.indexOf(Buffer.from('é', 'utf8'), bytes.length >> 1) + 1;
    const lineEnd = bytes.indexOf(0x0a, bytes.length >> 2) + 1;
    const cuts = [37, lineEnd, accent, bytes.length - 5, bytes.length];
    assert.ok(cuts.every((c, i) => i === 0 || c > cuts[i - 1]), 'cuts ascend');
    let written = 0;
    let rows = 0;
    for (const cut of cuts) {
      appendFileSync(transcript, bytes.subarray(written, cut));
      written = cut;
      const before = existsSync(cursor) ? cursorOffset(cursor) : 0;
      const run = measured(transcript, cursor);
      assert.deepEqual(run.usage, full(transcript), `cut at ${cut}`);
      assert.equal(run.bytes, cut - before, `cut at ${cut} reads only past offset ${before}`);
      assert.deepEqual(transcriptUsage(transcript, cursor), full(transcript), `a repeated Stop at ${cut}`);
      if (run.usage !== null) rows += 1;
    }
    assert.ok(rows >= 2, 'the line-aligned cuts finish a row');
    assert.equal(cursorOffset(cursor), bytes.length);
    const final = full(transcript);
    assert.ok(final !== null);
    assert.equal(final.tokensOut, String(60 + 1 + 30 + 70 + 2 + 2), 'last usage per group: msg_a, uuid-1, line-5, msg_b, line-7, the jq-equal object ids');
    assert.equal(final.toolUses, String(1 + 2 + 1 + 1 + 1 + 1), 'tool_use blocks summed per group, sidechain left out');
    assert.equal(final.model, 'claude-alpha');
  });

  it('every byte split of the fixture into three Stops matches turnUsage(full)', () => {
    const bytes = Buffer.from(FIXTURE, 'utf8');
    const expected = turnUsage(FIXTURE);
    for (let a = 1; a < bytes.length; a += 97) {
      const b = Math.min(bytes.length - 1, a + 211);
      const { transcript, cursor } = fresh(`split-${a}`);
      writeFileSync(transcript, bytes.subarray(0, a));
      transcriptUsage(transcript, cursor);
      appendFileSync(transcript, bytes.subarray(a, b));
      assert.deepEqual(transcriptUsage(transcript, cursor), full(transcript), `split ${a}/${b}`);
      appendFileSync(transcript, bytes.subarray(b));
      assert.deepEqual(transcriptUsage(transcript, cursor), expected, `split ${a}/${b}/end`);
    }
  });

  it('a BOM is skipped at the start of the file only, as in the full read', () => {
    const { transcript, cursor } = fresh('bom');
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(transcript, bom + FIXTURE);
    assert.ok(full(transcript) !== null);
    assert.deepEqual(transcriptUsage(transcript, cursor), full(transcript));
    appendFileSync(transcript, bom + assistant(20, 'msg_bom', 'claude-alpha', u(1, 1)));
    assert.equal(full(transcript), null);
    assert.equal(transcriptUsage(transcript, cursor), null);
  });

  it('a jq error in an appended line stays an error on later Stops, as in the full read', () => {
    const { transcript, cursor } = fresh('jq-error');
    writeFileSync(transcript, FIXTURE);
    assert.ok(transcriptUsage(transcript, cursor) !== null);
    appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: at(20), message: 'a string message' })}\n`);
    assert.equal(full(transcript), null);
    assert.equal(transcriptUsage(transcript, cursor), null);
    appendFileSync(transcript, assistant(21, 'msg_z', 'claude-alpha', u(1, 1)));
    const run = measured(transcript, cursor);
    assert.equal(run.usage, null);
    assert.equal(run.bytes, Buffer.byteLength(assistant(21, 'msg_z', 'claude-alpha', u(1, 1))), 'still incremental');
  });
});

describe('bro-turn-usage cursor', () => {
  it('a Stop after a small append reads only the new bytes and writes the new sums', () => {
    const { db, env, transcript, cursor } = fresh('large');
    const big = bigTranscript(3000);
    writeFileSync(transcript, big);
    stop(env, transcript);
    assert.ok(existsSync(cursor), 'the first Stop writes the cursor');
    assert.equal(cursorOffset(cursor), upToLastNewline(readFileSync(transcript)));
    assert.deepEqual(row(db), rowOf(full(transcript) as TurnUsage));
    const tail = assistant(55, 'msg_new', 'claude-alpha', u(1000, 2000, 3000, 4000), {}, 2) + assistant(56, 'msg_3000', 'claude-alpha', u(1, 1, 1, 1));
    appendFileSync(transcript, tail);
    const before = transcriptRead.bytes;
    stop(env, transcript);
    assert.equal(transcriptRead.bytes - before, Buffer.byteLength(tail), 'only the appended bytes are read');
    assert.equal(cursorOffset(cursor), Buffer.byteLength(big) + Buffer.byteLength(tail));
    const expected = full(transcript) as TurnUsage;
    assert.deepEqual(row(db), rowOf(expected));
    assert.equal(row(db)?.completed_at, at(56));
  });

  it('a truncated transcript is read in full and its cursor rewritten', () => {
    const { db, env, transcript, cursor } = fresh('truncated');
    writeFileSync(transcript, FIXTURE);
    stop(env, transcript);
    const short = FIXTURE.split('\n').slice(0, 4).join('\n') + '\n';
    writeFileSync(transcript, short);
    const run = measured(transcript, cursor);
    assert.deepEqual(run.usage, turnUsage(short));
    assert.equal(run.bytes, Buffer.byteLength(short), 'full read');
    assert.equal(cursorOffset(cursor), Buffer.byteLength(short), 'cursor moved back to the new end');
    appendFileSync(transcript, assistant(30, 'msg_more', 'claude-alpha', u(1, 500)));
    stop(env, transcript);
    assert.deepEqual(row(db), rowOf(full(transcript) as TurnUsage));
  });

  it('a changed head is read in full', () => {
    const { transcript, cursor } = fresh('head');
    writeFileSync(transcript, FIXTURE);
    transcriptUsage(transcript, cursor);
    const changed = FIXTURE.replace('"input_tokens":3,"output_tokens":10', '"input_tokens":3,"output_tokens":90') + assistant(40, 'msg_c', 'claude-alpha', u(1, 1));
    assert.ok(Buffer.byteLength(changed) > cursorOffset(cursor));
    writeFileSync(transcript, changed);
    const run = measured(transcript, cursor);
    assert.equal(run.bytes, Buffer.byteLength(changed), 'full read');
    assert.deepEqual(run.usage, turnUsage(changed));
  });

  it('a transcript with no newline just before the offset is read in full', () => {
    const { transcript, cursor } = fresh('far');
    const big = bigTranscript(100);
    writeFileSync(transcript, big);
    transcriptUsage(transcript, cursor);
    const shifted = `${big.slice(0, -1)} ` + '\n' + assistant(41, 'msg_d', 'claude-alpha', u(1, 1));
    writeFileSync(transcript, shifted);
    const run = measured(transcript, cursor);
    assert.equal(run.bytes, Buffer.byteLength(shifted), 'full read');
    assert.deepEqual(run.usage, turnUsage(shifted));
  });

  for (const [name, text] of [
    ['corrupt JSON', '{"v":1,"offset":'],
    ['another format version', null],
    ['another transcript', null],
    ['a malformed fold', null],
  ] as const) {
    it(`a cursor with ${name} is read in full and rewritten`, () => {
      const { transcript, cursor } = fresh(`cursor-${name.replaceAll(' ', '-')}`);
      writeFileSync(transcript, FIXTURE);
      transcriptUsage(transcript, cursor);
      const c = JSON.parse(readFileSync(cursor, 'utf8')) as Record<string, unknown>;
      if (name === 'another format version') c.v = 0;
      if (name === 'another transcript') c.transcript = `${transcript}.old`;
      if (name === 'a malformed fold') c.fold = { main: 'x' };
      writeFileSync(cursor, text ?? JSON.stringify(c));
      appendFileSync(transcript, assistant(50, 'msg_e', 'claude-alpha', u(1, 3)));
      const run = measured(transcript, cursor);
      assert.equal(run.bytes, Buffer.byteLength(readFileSync(transcript)), 'full read');
      assert.deepEqual(run.usage, full(transcript));
      assert.equal(cursorOffset(cursor), Buffer.byteLength(readFileSync(transcript)), 'cursor rewritten');
    });
  }

  it('an unsafe session_id is read in full and leaves no cursor', () => {
    const { db, env, transcript } = fresh('unsafe');
    writeFileSync(transcript, FIXTURE);
    for (const session of ['../escape', 'a/b', 'x'.repeat(129), 'sp ace']) {
      assert.equal(cursorPath(db, session), null, session);
      const before = transcriptRead.bytes;
      stop(env, transcript, session);
      assert.equal(transcriptRead.bytes - before, Buffer.byteLength(FIXTURE), `${session}: full read`);
      assert.deepEqual(row(db, session), rowOf(turnUsage(FIXTURE) as TurnUsage));
    }
    assert.equal(existsSync(join(dirname(db), 'bro-turn-usage')), false, 'no cursor dir');
    assert.equal(existsSync(join(sandbox, 'escape.json')), false, 'nothing written outside it');
  });

  it('a partial trailing line writes no row and waits; the completed line is read next', () => {
    const { db, env, transcript, cursor } = fresh('partial');
    writeFileSync(transcript, FIXTURE);
    stop(env, transcript);
    const before = row(db);
    const line = assistant(60, 'msg_f', 'claude-alpha', u(9, 900));
    appendFileSync(transcript, line.slice(0, 40));
    assert.equal(full(transcript), null, 'jq stops on the partial line');
    stop(env, transcript);
    assert.deepEqual(row(db), before, 'no write');
    assert.equal(cursorOffset(cursor), Buffer.byteLength(FIXTURE), 'the offset stays at the last newline');
    appendFileSync(transcript, line.slice(40));
    const read = transcriptRead.bytes;
    stop(env, transcript);
    assert.equal(transcriptRead.bytes - read, Buffer.byteLength(line), 'the partial line is read again, whole');
    assert.deepEqual(row(db), rowOf(full(transcript) as TurnUsage));
  });

  it('an appended line that does not parse falls back to the full read, writes nothing and keeps the offset', () => {
    const { db, env, transcript, cursor } = fresh('garbage');
    writeFileSync(transcript, FIXTURE);
    stop(env, transcript);
    const before = row(db);
    appendFileSync(transcript, `{"type":"assistant", nope\n${assistant(70, 'msg_g', 'claude-alpha', u(1, 1))}`);
    const read = transcriptRead.bytes;
    stop(env, transcript);
    assert.equal(transcriptRead.bytes - read, Buffer.byteLength(readFileSync(transcript)) - Buffer.byteLength(FIXTURE) + Buffer.byteLength(readFileSync(transcript)), 'tail, then the full read');
    assert.deepEqual(row(db), before, 'no write');
    assert.equal(cursorOffset(cursor), Buffer.byteLength(FIXTURE), 'not advanced');
  });

  it('a cursor behind the transcript moves forward atomically', () => {
    const { transcript, cursor } = fresh('overlap');
    const lines = FIXTURE.split(/(?<=\n)/);
    writeFileSync(transcript, lines.slice(0, 5).join(''));
    transcriptUsage(transcript, cursor);
    const older = readFileSync(cursor, 'utf8');
    writeFileSync(transcript, FIXTURE);
    transcriptUsage(transcript, cursor);
    const newer = readFileSync(cursor, 'utf8');
    writeFileSync(cursor, older);
    transcriptUsage(transcript, cursor);
    assert.equal(readFileSync(cursor, 'utf8'), newer, 'an older cursor on disk is moved forward');
    assert.deepEqual(transcriptUsage(transcript, cursor), turnUsage(FIXTURE));
    assert.deepEqual(
      readdirSync(dirname(cursor)).filter((f) => f.endsWith('.tmp')),
      [],
      'no temp file left',
    );
  });

  it('a stale run does not move a newer cursor back (GH 2711)', () => {
    const { transcript, cursor } = fresh('stale');
    const lines = FIXTURE.split(/(?<=\n)/);
    const head = lines.slice(0, 3).join('');
    const stale = lines.slice(0, 7).join('');
    writeFileSync(transcript, head);
    transcriptUsage(transcript, cursor);
    assert.equal(cursorOffset(cursor), Buffer.byteLength(head));
    appendFileSync(transcript, lines.slice(3, 7).join(''));
    let newer = '';
    let armed = true;
    const staleRun = withFs(
      'readSync',
      (original) =>
        (...args: unknown[]) => {
          if (armed && args[4] === Buffer.byteLength(head)) {
            armed = false;
            appendFileSync(transcript, lines.slice(7).join(''));
            assert.deepEqual(transcriptUsage(transcript, cursor), turnUsage(FIXTURE), 'the newer run');
            newer = readFileSync(cursor, 'utf8');
          }
          return original(...args);
        },
      () => transcriptUsage(transcript, cursor),
    );
    assert.equal(armed, false, 'the newer run ran inside the stale one');
    assert.deepEqual(staleRun, turnUsage(stale), 'the stale run finishes its own prefix');
    assert.equal(cursorOffset(cursor), Buffer.byteLength(FIXTURE), 'the newer offset survives');
    assert.equal(readFileSync(cursor, 'utf8'), newer, 'the newer cursor is untouched');
    const next = measured(transcript, cursor);
    assert.deepEqual(next.usage, turnUsage(FIXTURE));
    assert.equal(next.bytes, 0, 'the next run reads from the newer offset');
  });
});

describe('bro-turn-usage transcript read errors', () => {
  for (const name of ['readSync', 'fstatSync'] as const) {
    it(`a ${name} error allows quietly and writes no agent_runs row (GH 2711)`, () => {
      const { db, env, transcript, cursor } = fresh(`read-error-${name}`);
      writeFileSync(transcript, FIXTURE);
      const fail = () => () => {
        throw Object.assign(new Error(`EIO: i/o error, ${name}`), { code: 'EIO' });
      };
      assert.throws(() => withFs(name, fail, () => transcriptUsage(transcript, cursor)), /EIO/, 'transcriptUsage still throws');
      const result = withFs(name, fail, () => broTurnUsage(JSON.stringify({ session_id: SESSION, transcript_path: transcript }), env));
      assert.deepEqual(result, ALLOW);
      const d = new DatabaseSync(db, { readOnly: true });
      try {
        assert.deepEqual({ ...d.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() }, { n: 0 });
      } finally {
        d.close();
      }
      assert.equal(existsSync(cursor), false, 'no cursor written');
    });
  }
});
