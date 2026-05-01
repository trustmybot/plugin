import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isBot, buildBotPatterns, DEFAULT_BOT_PATTERNS } from '../sync/bot_patterns.js';

describe('isBot — default patterns', () => {
  it('matches [bot] suffix', () => {
    assert.equal(isBot('dependabot[bot]'), true);
  });

  it('matches -bot suffix', () => {
    assert.equal(isBot('my-custom-bot'), true);
  });

  it('matches dependabot prefix', () => {
    assert.equal(isBot('dependabot'), true);
  });

  it('matches coderabbitai prefix', () => {
    assert.equal(isBot('coderabbitai'), true);
  });

  it('matches github-actions prefix', () => {
    assert.equal(isBot('github-actions'), true);
  });

  it('matches codecov prefix', () => {
    assert.equal(isBot('codecov'), true);
  });

  it('matches renovate prefix', () => {
    assert.equal(isBot('renovate'), true);
  });

  it('returns false for a regular human author', () => {
    assert.equal(isBot('alice'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isBot(''), false);
  });

  it('is case-insensitive for [BOT] suffix', () => {
    assert.equal(isBot('SomeBot[BOT]'), true);
  });

  it('is case-insensitive for Dependabot prefix', () => {
    assert.equal(isBot('Dependabot'), true);
  });
});

describe('isBot — config override patterns', () => {
  it('matches custom pattern passed as extra', () => {
    const extras = [/^my-ci$/i];
    assert.equal(isBot('my-ci', extras), true);
  });

  it('extra patterns do not interfere with humans not matching them', () => {
    const extras = [/^my-ci$/i];
    assert.equal(isBot('bob', extras), false);
  });

  it('defaults still apply when extra patterns are given', () => {
    const extras = [/^my-ci$/i];
    assert.equal(isBot('renovate', extras), true);
  });
});

describe('buildBotPatterns', () => {
  it('returns DEFAULT_BOT_PATTERNS when no override given', () => {
    const patterns = buildBotPatterns();
    assert.equal(patterns.length, DEFAULT_BOT_PATTERNS.length);
  });

  it('returns DEFAULT_BOT_PATTERNS when override is empty string', () => {
    const patterns = buildBotPatterns('');
    assert.equal(patterns.length, DEFAULT_BOT_PATTERNS.length);
  });

  it('appends comma-separated patterns from config', () => {
    const patterns = buildBotPatterns('my-ci,internal-bot');
    assert.equal(patterns.length, DEFAULT_BOT_PATTERNS.length + 2);
    assert.ok(patterns.some((p) => p.test('my-ci')));
    assert.ok(patterns.some((p) => p.test('internal-bot')));
  });

  it('ignores empty segments from extra commas', () => {
    const patterns = buildBotPatterns('my-ci,,  ');
    assert.equal(patterns.length, DEFAULT_BOT_PATTERNS.length + 1);
  });
});
