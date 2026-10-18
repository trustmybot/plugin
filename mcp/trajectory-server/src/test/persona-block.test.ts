import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PersonaBlockError,
  applyPersonaBlock,
  personaBlockVersion,
  removePersonaBlock,
  renderPersonaBlock,
} from '../persona-block.js';

const BODY = '# You are bro\n\nOrchestrate.\n';
const V1 = renderPersonaBlock(BODY, '1.0.2');
const V2 = renderPersonaBlock(BODY, '1.0.3');

describe('renderPersonaBlock', () => {
  it('wraps the body in versioned markers with no trailing blank lines', () => {
    assert.equal(V1, '<!-- tmb:persona start v1.0.2 -->\n# You are bro\n\nOrchestrate.\n<!-- tmb:persona end -->');
  });

  it('normalises a CRLF body', () => {
    assert.equal(renderPersonaBlock(BODY.replace(/\n/g, '\r\n'), '1.0.2'), V1);
  });

  it('rejects a version that would break the marker', () => {
    assert.throws(() => renderPersonaBlock(BODY, '1 0'), PersonaBlockError);
    assert.throws(() => renderPersonaBlock(BODY, ''), PersonaBlockError);
  });
});

describe('applyPersonaBlock', () => {
  it('no file: the block alone', () => {
    assert.deepEqual(applyPersonaBlock(null, V1), { text: `${V1}\n`, action: 'appended' });
  });

  it('empty file: the block alone', () => {
    assert.deepEqual(applyPersonaBlock('', V1), { text: `${V1}\n`, action: 'appended' });
  });

  it('file without markers: appended after one blank line, Human text untouched', () => {
    const human = '# My project\n\nRules.\n';
    const r = applyPersonaBlock(human, V1);
    assert.equal(r.action, 'appended');
    assert.equal(r.text, `${human}\n${V1}\n`);
    assert.ok(r.text.startsWith(human));
  });

  it('file without a trailing newline gains exactly one blank line and ends without a newline', () => {
    assert.equal(applyPersonaBlock('# Mine', V1).text, `# Mine\n\n${V1}`);
  });

  it('file already ending in a blank line gets no extra one', () => {
    assert.equal(applyPersonaBlock('# Mine\n\n', V1).text, `# Mine\n\n${V1}\n`);
  });

  it('same version and body: unchanged, same text', () => {
    const text = applyPersonaBlock('# Mine\n', V1).text;
    assert.deepEqual(applyPersonaBlock(text, V1), { text, action: 'unchanged' });
  });

  it('older version: replaces only the marked region', () => {
    const before = '# Top\n\n';
    const after = '\n\n## Bottom\nHuman notes\n';
    const r = applyPersonaBlock(`${before}${V1}${after}`, V2);
    assert.equal(r.action, 'replaced');
    assert.equal(r.text, `${before}${V2}${after}`);
  });

  it('same version, different body: replaced', () => {
    const edited = renderPersonaBlock('# You are bro\n\nOrchestrate harder.\n', '1.0.2');
    const r = applyPersonaBlock(`# Top\n\n${V1}\n`, edited);
    assert.equal(r.action, 'replaced');
    assert.equal(r.text, `# Top\n\n${edited}\n`);
  });

  it('CRLF file: block written with CRLF, Human CRLF text untouched, idempotent', () => {
    const human = '# Mine\r\nLine two\r\n';
    const r = applyPersonaBlock(human, V1);
    assert.equal(r.action, 'appended');
    assert.equal(r.text, `${human}\r\n${V1.replace(/\n/g, '\r\n')}\r\n`);
    assert.ok(!/[^\r]\n/.test(r.text), 'no bare LF');
    assert.equal(applyPersonaBlock(r.text, V1).action, 'unchanged');
    const up = applyPersonaBlock(r.text, V2);
    assert.equal(up.action, 'replaced');
    assert.equal(up.text, `${human}\r\n${V2.replace(/\n/g, '\r\n')}\r\n`);
  });

  it('missing end marker: an error, never a rewrite', () => {
    const broken = '# Mine\n<!-- tmb:persona start v1.0.2 -->\nhalf a block\n';
    assert.throws(() => applyPersonaBlock(broken, V2), PersonaBlockError);
  });

  it('end marker with no start marker: an error', () => {
    assert.throws(() => applyPersonaBlock('# Mine\n<!-- tmb:persona end -->\n', V2), PersonaBlockError);
  });

  it('two blocks: an error', () => {
    assert.throws(() => applyPersonaBlock(`${V1}\n${V1}\n`, V2), PersonaBlockError);
  });
});

describe('removePersonaBlock', () => {
  it('removes an appended block, restoring the Human text byte for byte', () => {
    const human = '# My project\n\nRules.\n';
    const withBlock = applyPersonaBlock(human, V1).text;
    assert.deepEqual(removePersonaBlock(withBlock), { text: human, action: 'removed' });
  });

  it('removes a block-only file to empty', () => {
    assert.deepEqual(removePersonaBlock(`${V1}\n`), { text: '', action: 'removed' });
  });

  it('keeps Human text before and after a block in the middle', () => {
    assert.equal(removePersonaBlock(`# Top\n\n${V1}\n## Bottom\n`).text, '# Top\n\n## Bottom\n');
  });

  it('CRLF round trip', () => {
    const human = '# Mine\r\nLine two\r\n';
    assert.equal(removePersonaBlock(applyPersonaBlock(human, V1).text).text, human);
  });

  for (const [name, human] of [
    ['ending in a newline', '# Mine\n\nRules.\n'],
    ['ending without a newline', '# Mine\n\nRules.'],
    ['empty', ''],
    ['CRLF', '# Mine\r\nLine two\r\n'],
    ['CRLF without a trailing newline', '# Mine\r\nLine two'],
  ] as const) {
    it(`round trip restores human text ${name}`, () => {
      assert.equal(removePersonaBlock(applyPersonaBlock(human, V1).text).text, human);
    });
  }

  it('no block: unchanged', () => {
    assert.deepEqual(removePersonaBlock('# Mine\n'), { text: '# Mine\n', action: 'unchanged' });
  });

  it('missing end marker: an error', () => {
    assert.throws(() => removePersonaBlock('<!-- tmb:persona start v1 -->\nx\n'), PersonaBlockError);
  });
});

describe('personaBlockVersion', () => {
  it('reads the start marker version', () => {
    assert.equal(personaBlockVersion(`# x\n\n${V2}\n`), '1.0.3');
    assert.equal(personaBlockVersion('# x\n'), null);
    assert.equal(personaBlockVersion(null), null);
  });
});
