/**
 * PreToolUse gate (#96), the port of scripts/hooks/askuserquestion-length-lint.sh:
 * warns through additionalContext when an AskUserQuestion option's label,
 * description or preview exceeds its brevity target. Never blocks.
 *
 * Fields are read the way the .sh reads them with `jq -r '.<field> // ""'`
 * into a shell variable, words are counted like `wc -w` and preview lines
 * like `grep -c '^'`, so both give the same output for the same payload.
 */
import { ALLOW } from './gate.js';
import { ctypeUtf8 } from './lib/project-env.js';
const LABEL_MAX_WORDS = 5;
const DESC_MAX_WORDS = 15;
const PREVIEW_MAX_LINES = 4;
class JqError extends Error {
}
function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function jqField(v, key) {
    if (v === null)
        return null;
    if (!isObject(v))
        throw new JqError(`cannot index ${typeof v} with "${key}"`);
    return Object.hasOwn(v, key) ? v[key] : null;
}
function jqAlt(v, fallback) {
    return v === null || v === false ? fallback : v;
}
function jqEach(v) {
    if (Array.isArray(v))
        return v;
    if (isObject(v))
        return Object.values(v);
    throw new JqError(`cannot iterate over ${typeof v}`);
}
function jqItems(get) {
    try {
        return jqEach(get());
    }
    catch (err) {
        if (err instanceof JqError)
            return [];
        throw err;
    }
}
function jqRaw(v) {
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
function shellCapture(text) {
    return text.replace(/\0/g, '').replace(/\n+$/, '');
}
function fieldText(option, key) {
    try {
        return shellCapture(jqRaw(jqAlt(jqField(option, key), '')));
    }
    catch (err) {
        if (err instanceof JqError)
            return '';
        throw err;
    }
}
// macOS wc -w also splits on U+00A0 (and only that beyond ASCII) under an
// installed UTF-8 locale.
function wordCount(text, nbsp) {
    const separators = nbsp ? /[ \t\n\v\f\r ]+/ : /[ \t\n\v\f\r]+/;
    return text.split(separators).filter((word) => word !== '').length;
}
function lineCount(text) {
    return text === '' ? 0 : text.split('\n').length;
}
function toolName(payload) {
    try {
        return shellCapture(jqRaw(jqAlt(jqField(payload, 'tool_name'), '')));
    }
    catch (err) {
        if (err instanceof JqError)
            return '';
        throw err;
    }
}
function parsePayload(payload) {
    try {
        return JSON.parse(payload);
    }
    catch {
        return undefined;
    }
}
export const askuserquestionLengthLint = (payload, env) => {
    const input = parsePayload(payload);
    if (input === undefined || toolName(input) !== 'AskUserQuestion')
        return ALLOW;
    const nbsp = ctypeUtf8(env);
    const warnings = [];
    const questions = jqItems(() => jqAlt(jqField(jqField(input, 'tool_input'), 'questions'), []));
    questions.forEach((question, q) => {
        const options = jqItems(() => jqAlt(jqField(question, 'options'), []));
        options.forEach((option, o) => {
            const labelWords = wordCount(fieldText(option, 'label'), nbsp);
            const descWords = wordCount(fieldText(option, 'description'), nbsp);
            const previewLines = lineCount(fieldText(option, 'preview'));
            if (labelWords > LABEL_MAX_WORDS) {
                warnings.push(`q${q}.opt${o} label is ${labelWords} words (target ≤${LABEL_MAX_WORDS})`);
            }
            if (descWords > DESC_MAX_WORDS) {
                warnings.push(`q${q}.opt${o} description is ${descWords} words (target ≤${DESC_MAX_WORDS})`);
            }
            if (previewLines > PREVIEW_MAX_LINES) {
                warnings.push(`q${q}.opt${o} preview is ${previewLines} lines (target ≤${PREVIEW_MAX_LINES})`);
            }
        });
    });
    if (warnings.length === 0)
        return ALLOW;
    const message = [
        'AskUserQuestion brevity violations (per feedback_ask_user_question.md):',
        ...warnings.map((w) => `  - ${w}`),
    ].join('\n')
        + '\n\nTargets: label <=5 words, description <=15 words, preview <=4 lines. See #96.';
    const output = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message } };
    return { stdout: `${JSON.stringify(output)}\n`, code: 0 };
};
//# sourceMappingURL=askuserquestion-length-lint.js.map