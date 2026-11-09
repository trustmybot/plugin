/**
 * liveBackgroundIds (GH 2206): the background commands a swe transcript
 * started and never saw end, from the JSONL markers Claude Code writes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { liveBackgroundIds } from '../hooks/lib/background-wait.js';

type Line = string | object;

const jsonl = (...lines: Array<Line | Line[]>) =>
  lines
    .flat()
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n') + '\n';

const toolUse = (useId: string, name: string, input: object = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: useId, name, input }] },
});

const startText = (id: string) => `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output.`;

const toolResult = (useId: string | undefined, content: unknown) => ({
  type: 'user',
  message: { role: 'user', content: [{ ...(useId === undefined ? {} : { tool_use_id: useId }), type: 'tool_result', content, is_error: false }] },
});

const start = (id: string) => [toolUse(`toolu_${id}`, 'Bash', { command: 'sleep 60', run_in_background: true }), toolResult(`toolu_${id}`, startText(id))];

const moved = (id: string) => [
  toolUse(`toolu_mv_${id}`, 'Bash', { command: 'sleep 600' }),
  toolResult(`toolu_mv_${id}`, [{ type: 'text', text: `Command did not complete within its 120s timeout and was moved to the background (ID: ${id}).` }]),
];

const notificationText = (id: string, status: string) =>
  `[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>`;

const userNotification = (id: string, status: string) => ({ type: 'user', isMeta: true, message: { role: 'user', content: notificationText(id, status) } });

const attachmentNotification = (id: string, status: string) => ({
  type: 'attachment',
  attachment: { type: 'queued_command', prompt: notificationText(id, status), commandMode: 'task-notification' },
});

const taskStop = (id: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: id } }] },
});

describe('liveBackgroundIds', () => {
  it('a start with no end gives its id', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(start('b6bhynol7'))), ['b6bhynol7']);
  });

  for (const status of ['completed', 'failed', 'stopped']) {
    it(`a start plus a ${status} task-notification gives []`, () => {
      assert.deepEqual(liveBackgroundIds(jsonl(start('b6bhynol7'), userNotification('b6bhynol7', status))), []);
    });
  }

  it('a task-notification in attachment.prompt ends the id', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(start('bqbdtxbog'), attachmentNotification('bqbdtxbog', 'completed'))), []);
  });

  it('a task-notification in a user text block ends the id', () => {
    const line = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: notificationText('abc1', 'killed') }] } };
    assert.deepEqual(liveBackgroundIds(jsonl(start('abc1'), line)), []);
  });

  it('a task-notification with no status does not end the id', () => {
    const text = '<task-notification>\n<task-id>abc1</task-id>\n</task-notification>';
    assert.deepEqual(liveBackgroundIds(jsonl(start('abc1'), { type: 'user', message: { role: 'user', content: text } })), ['abc1']);
  });

  it('a start plus a TaskStop on its id gives []', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), taskStop('b1'))), []);
  });

  it('a TaskStop on another id leaves the start live', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), taskStop('b2'))), ['b1']);
  });

  it('two starts with one ended gives the other', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), start('b2'), userNotification('b1', 'completed'))), ['b2']);
    assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), start('b2'), taskStop('b2'))), ['b1']);
  });

  it('an end before its start still ends it', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(userNotification('b1', 'completed'), start('b1'))), []);
  });

  it('a malformed line is skipped', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), '{not json "Command running in background with ID: b9', start('b2'), userNotification('b2', 'completed'))), [
      'b1',
    ]);
  });

  it('the start text in an assistant text block alone gives []', () => {
    const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Command running in background with ID: b1' }] } };
    assert.deepEqual(liveBackgroundIds(jsonl(line)), []);
  });

  it('the start text in a plain user message or another field gives []', () => {
    const plain = { type: 'user', message: { role: 'user', content: 'Command running in background with ID: b1' } };
    const other = { type: 'system', content: 'Command running in background with ID: b2', toolUseResult: { stdout: 'Command running in background with ID: b3' } };
    assert.deepEqual(liveBackgroundIds(jsonl(plain, other)), []);
  });

  it('a notification outside the allowed fields does not end the id', () => {
    const other = { type: 'system', content: notificationText('b1', 'completed') };
    assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), other)), ['b1']);
  });

  it('a foreground command moved to the background counts as a start', () => {
    assert.deepEqual(liveBackgroundIds(jsonl(moved('by4ejizgu'))), ['by4ejizgu']);
    assert.deepEqual(liveBackgroundIds(jsonl(moved('by4ejizgu'), userNotification('by4ejizgu', 'completed'))), []);
  });

  describe('only a Bash tool_result starts a run (GH 2688)', () => {
    for (const name of ['Read', 'Grep', 'mcp__plugin_tmb_trajectory-server__task_brief']) {
      it(`a start marker in a ${name} tool_result gives []`, () => {
        assert.deepEqual(liveBackgroundIds(jsonl(toolUse('toolu_q', name, { file_path: '/x' }), toolResult('toolu_q', startText('bq1')))), []);
        assert.deepEqual(liveBackgroundIds(jsonl(toolUse('toolu_q', name), toolResult('toolu_q', [{ type: 'text', text: startText('bq1') }]))), []);
      });
    }

    it('a quoted marker beside a real Bash start gives only the Bash id', () => {
      assert.deepEqual(liveBackgroundIds(jsonl(toolUse('toolu_r', 'Read'), toolResult('toolu_r', startText('quoted')), start('real'))), ['real']);
    });

    it('a tool_result with no tool_use_id gives no start', () => {
      assert.deepEqual(liveBackgroundIds(jsonl(toolUse('toolu_b', 'Bash'), toolResult(undefined, startText('b1')))), []);
    });

    it('a tool_result naming an unknown tool_use id gives no start', () => {
      assert.deepEqual(liveBackgroundIds(jsonl(toolUse('toolu_b', 'Bash'), toolResult('toolu_other', startText('b1')))), []);
      assert.deepEqual(liveBackgroundIds(jsonl(toolResult('toolu_b', startText('b1')))), []);
    });

    it('a Bash start still ends on a task-notification or TaskStop', () => {
      assert.deepEqual(liveBackgroundIds(jsonl(start('b1'))), ['b1']);
      assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), userNotification('b1', 'completed'))), []);
      assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), taskStop('b1'))), []);
    });

    it('a notification in a non-Bash tool_result still ends a Bash start', () => {
      assert.deepEqual(liveBackgroundIds(jsonl(start('b1'), toolUse('toolu_r', 'Read'), toolResult('toolu_r', notificationText('b1', 'completed')))), []);
    });
  });

  it('empty text gives []', () => {
    assert.deepEqual(liveBackgroundIds(''), []);
  });
});
