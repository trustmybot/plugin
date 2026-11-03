import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityOnAgent, hasNonSpace, hasWord, headlessMatch, pendingList, proximityMatch, readPipeFields, splitClauses, stripBashSpans, stripFencedBlocks, stripInjectedBlocks, stripQuotedSpans, } from '../hooks/prompt-intent-hints.js';
const C = { LC_ALL: 'C' };
const GH1751 = 'What is the L0 success criteria? I thought it should be claude -p "@bro health check" and everything is green?';
describe('prompt-intent-hints: headless phrase (GH 1751)', () => {
    it('a question naming claude -p is not headless intent', () => {
        assert.equal(headlessMatch(GH1751, C), '');
        assert.equal(headlessMatch('should I use claude --print here?', C), '');
    });
    it('claude -p only inside backticks, quotes or a fence is not headless intent', () => {
        assert.equal(headlessMatch('I ran `claude -p` yesterday.', C), '');
        assert.equal(headlessMatch('the docs say "claude -p works" today', C), '');
        assert.equal(headlessMatch('log:\n```\nclaude --print ok\n```\ndone', C), '');
    });
    it('a stated claude -p or headless ask still matches', () => {
        assert.equal(headlessMatch('set up claude -p for CI', C), 'claude -p');
        assert.equal(headlessMatch('make the gates work headless', C), 'headless');
        assert.equal(headlessMatch('Is it fine? Wire claude --print into the nightly job.', C), 'claude --print');
    });
    it('other phrases still match inside a question, outside quoted spans', () => {
        assert.equal(headlessMatch('how do I run this under `claude -p` in CI?', C), 'in ci');
        assert.equal(headlessMatch('does this work in `ci run` mode?', C), '');
    });
    it('phrases match as whole words', () => {
        assert.equal(headlessMatch('the main circuit board', C), '');
    });
});
describe('prompt-intent-hints: text passes', () => {
    it('splitClauses splits each line after . ; ? ! and flags questions', () => {
        assert.deepEqual(splitClauses('a? b. c\nd!'), [
            { text: 'a', question: true },
            { text: ' b', question: false },
            { text: ' c', question: false },
            { text: 'd', question: false },
        ]);
    });
    it('stripQuotedSpans blanks backticked and quoted spans but not apostrophes', () => {
        assert.equal(stripQuotedSpans('run `x y` now'), 'run   now');
        assert.equal(stripQuotedSpans('say "skip it" then'), 'say   then');
        assert.equal(stripQuotedSpans("don't stop, it's fine"), "don't stop, it's fine");
    });
    it('stripFencedBlocks blanks closed fences and keeps an unclosed one', () => {
        assert.equal(stripFencedBlocks('a ```x``` b'), 'a   b');
        assert.equal(stripFencedBlocks('a ```x'), 'a ```x');
    });
    it('stripInjectedBlocks drops closed injected blocks and keeps an unclosed one', () => {
        assert.equal(stripInjectedBlocks('<system-reminder>\npush it\n</system-reminder>\n1806 merged'), ' \n1806 merged');
        assert.equal(stripInjectedBlocks('<agent-message from="x">a</agent-message>b'), ' b');
        assert.equal(stripInjectedBlocks('<pasted_content>open'), '<pasted_content>open');
        assert.equal(stripInjectedBlocks('<system-reminders>x</system-reminders>'), '<system-reminders>x</system-reminders>');
    });
    it('stripBashSpans drops shell-turn spans', () => {
        assert.equal(stripBashSpans('<bash-input>git push</bash-input>ok<bash-stdout>x</bash-stdout>'), 'ok');
    });
    it('hasNonSpace follows the locale [:space:] class', () => {
        assert.equal(hasNonSpace(' \t\n', false), false);
        assert.equal(hasNonSpace(' ', false), true);
        assert.equal(hasNonSpace(' 　', true), false);
        assert.equal(hasNonSpace(' x ', true), true);
    });
});
describe('prompt-intent-hints: matchers', () => {
    it('hasWord needs no [a-z] letter on either side', () => {
        assert.equal(hasWord('check', 'please check it', false), true);
        assert.equal(hasWord('check', 'checklist', false), false);
        assert.equal(hasWord('audit', 'audit-log', false), true);
        assert.equal(hasWord('audit', 'éaudit', false), true);
        assert.equal(hasWord('audit', 'éaudit', true), false);
    });
    it('capabilityOnAgent names the agent after install/add in the same clause', () => {
        assert.equal(capabilityOnAgent('add the playwright skill to swe', ['swe', 'bro']), 'swe');
        assert.equal(capabilityOnAgent('add it. then talk to swe', ['swe']), '');
        assert.equal(capabilityOnAgent('install it for swe-team', ['swe']), '');
        assert.equal(capabilityOnAgent('re-add x to bro', ['bro']), 'bro');
    });
    it('proximityMatch takes port … to and rewrite … in within six words', () => {
        assert.equal(proximityMatch('port the parser to rust'), 'port ... to');
        assert.equal(proximityMatch('rewrite the scanner core in go'), 'rewrite ... in');
        assert.equal(proximityMatch('report back to me'), '');
        assert.equal(proximityMatch('port a b c d e f to x'), '');
    });
    it('readPipeFields gives the last field the rest, minus one trailing |', () => {
        assert.deepEqual(readPipeFields('1|2|b|t|auth | work', 5), ['1', '2', 'b', 't', 'auth | work']);
        assert.deepEqual(readPipeFields('x|y|z|', 3), ['x', 'y', 'z']);
        assert.deepEqual(readPipeFields('x|y|z|w|', 3), ['x', 'y', 'z|w|']);
        assert.deepEqual(readPipeFields('x', 3), ['x', '', '']);
    });
    it('pendingList renders one task line per row', () => {
        assert.equal(pendingList('1|feat/a|t\n2|feat/b|'), '  - task_id=1  branch=feat/a  (t)\n  - task_id=2  branch=feat/b  ()');
    });
});
//# sourceMappingURL=hooks-prompt-intent-hints.test.js.map