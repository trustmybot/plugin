/**
 * GH 2965: tmb_planning sends bro to the world model first for relationship
 * questions and spec scoping, names the grep fallback, records misses, and
 * makes no speed or accuracy claim while world-model use is under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PLANNING = readFileSync(join(PLUGIN_ROOT, 'skills/tmb_planning/SKILL.md'), 'utf8');

function section(heading: RegExp): string {
  const start = PLANNING.search(heading);
  assert.ok(start >= 0, `tmb_planning has a section matching ${heading}`);
  const rest = PLANNING.slice(start + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('GH 2965: tmb_planning puts the world model first for bro', () => {
  const verify = section(/^## 1\. /m);
  const author = section(/^## 4\. /m);

  it('GH 2965: §1 directs world_model_symbol with impact: 2 first for callers, importers, table readers and tests', () => {
    assert.match(verify, /callers, importers, table readers and tests of a symbol, call `world_model_symbol\(agent='bro'[^)]*impact: 2\)` first/);
  });

  it('GH 2965: §1 names the Bash, Grep and git grep fallback cases', () => {
    assert.match(verify, /Bash, Grep or `git grep` only for what the world model cannot answer/);
    assert.match(verify, /new on an unmerged branch/);
    assert.match(verify, /non-code files/);
    assert.match(verify, /world-model miss/);
  });

  it('GH 2965: §1 records misses as a discussion_append note with a wm_feedback: prefix, under test', () => {
    assert.match(verify, /discussion_append\([^)]*kind='note'[^)]*body='wm_feedback: /);
    assert.match(verify, /under test/);
  });

  it('GH 2965: §4 runs scope_suggest or world_model_symbol before building files[], and describes the provision hook as a deny without a recent read covering files[]', () => {
    assert.match(author, /Before building `files\[\]`, call `scope_suggest\(agent='bro', objective, anchors\)` \(or `world_model_symbol` on each anchor symbol\)/);
    assert.match(author, /`task_provision` hook denies the call unless this session recently read the world model on code that covers one of the task's `files\[\]`/);
    assert.match(author, /the path itself, or a directory above or below it/);
    assert.doesNotMatch(author, /adds a nudge/);
  });

  it('GH 2965: tmb_planning makes no comparative claim and cites no issue in parentheses', () => {
    assert.ok(PLANNING.includes('world_model_symbol('));
    assert.ok(PLANNING.includes('scope_suggest('));
    assert.ok(PLANNING.includes('wm_feedback:'));
    assert.doesNotMatch(PLANNING, /(faster|better|cheaper) than/i);
    assert.doesNotMatch(PLANNING, /\(GH \d+\)/);
  });
});
