import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anyTermPoolSize, toFtsOrQuery, toFtsOrTerms, toFtsQuery, withFtsGuard } from '../fts-query.js';

describe('toFtsQuery', () => {
  it('quotes each hyphenated token', () => {
    assert.equal(toFtsQuery('dir-level world model'), '"dir-level" "world" "model"');
  });

  it('quotes a dotted token', () => {
    assert.equal(toFtsQuery('AGENTS.md'), '"AGENTS.md"');
  });

  it('keeps a phrase the caller already quoted as one token', () => {
    assert.equal(toFtsQuery('"already quoted" term'), '"already quoted" "term"');
  });

  it('strips a stray unbalanced quote', () => {
    assert.equal(toFtsQuery('"foo bar'), '"foo" "bar"');
  });

  it('escapes an embedded quote', () => {
    assert.equal(toFtsQuery('say"hi'), '"say""hi"');
  });

  it('collapses extra whitespace', () => {
    assert.equal(toFtsQuery('  a   b\t c  '), '"a" "b" "c"');
  });

  it('returns the empty phrase for blank input', () => {
    assert.equal(toFtsQuery(''), '""');
    assert.equal(toFtsQuery('   '), '""');
    assert.equal(toFtsQuery('""'), '""');
  });
});

describe('withFtsGuard', () => {
  it('maps fts5 and column errors to fts_query_invalid', () => {
    assert.throws(
      () => withFtsGuard(() => { throw new Error('fts5: syntax error near "."'); }),
      /^Error: fts_query_invalid: fts5: syntax error/,
    );
    assert.throws(
      () => withFtsGuard(() => { throw new Error('no such column: level'); }),
      /fts_query_invalid: no such column: level/,
    );
  });

  it('passes other errors and results through', () => {
    assert.equal(withFtsGuard(() => 7), 7);
    assert.throws(() => withFtsGuard(() => { throw new Error('disk full'); }), /^Error: disk full$/);
  });
});

describe('toFtsOrTerms', () => {
  it('returns the distinct quoted non-stopword terms toFtsOrQuery ORs', () => {
    assert.deepEqual(toFtsOrTerms('how does the alpha alpha bravo work'), ['"alpha"', '"bravo"', '"work"']);
    assert.equal(toFtsOrQuery('how does the alpha alpha bravo work'), '"alpha" OR "alpha" OR "bravo" OR "work"');
  });

  it('returns no terms for a stopword-only query', () => {
    assert.deepEqual(toFtsOrTerms('how is it'), []);
  });
});

describe('anyTermPoolSize', () => {
  it('fetches 4x k, capped at 200 but never below k', () => {
    assert.equal(anyTermPoolSize(5), 20);
    assert.equal(anyTermPoolSize(100), 200);
    assert.equal(anyTermPoolSize(500), 500);
  });
});
