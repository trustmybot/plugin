/**
 * liveBackgroundIds (GH 2206): the background commands a swe transcript
 * started and never saw end, from the JSONL markers Claude Code writes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { liveBackgroundIds } from '../hooks/lib/background-wait.js';

const jsonl = (...lines: Array<string | object>) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

const start = (id: string) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { tool_use_id: `toolu_${id}`, type: 'tool_result', content: `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.output.`, is_error: false },
    ],
  },
});

const moved = (id: string) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: [{ type: 'text', text: `Command did not complete within its 120s timeout and was moved to the background (ID: ${id}).` }] }],
  },
});

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

  it('empty text gives []', () => {
    assert.deepEqual(liveBackgroundIds(''), []);
  });
});
