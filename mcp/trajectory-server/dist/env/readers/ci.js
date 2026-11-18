// CI reader: GitHub Actions `run:` steps and GitLab `script:` entries, block scalars reported once, each with its line.
import { splitLines } from '../text.js';
import { flowItems, scalarAt, sequenceAt } from '../yaml.js';
function keyMatches(lines, key) {
    const re = new RegExp(`^(\\s*)(-\\s+)?${key}:(\\s.*|)$`);
    const out = [];
    lines.forEach((line, at) => {
        const m = line.match(re);
        if (m)
            out.push({ at, column: m[1].length + (m[2]?.length ?? 0), value: m[3].trim() });
    });
    return out;
}
const MAPPING_KEY = /^\s*[^\s#-][^:]*:(\s|$)/;
// `run:` with no value and a nested mapping under it is `defaults.run`, not a step.
function opensMapping(lines, at, value) {
    if (value !== '' && !value.startsWith('#'))
        return false;
    const next = lines.slice(at + 1).find((l) => l.trim() !== '' && !l.trim().startsWith('#'));
    return next !== undefined && MAPPING_KEY.test(next);
}
export function readActionsWorkflow(file, text) {
    const lines = splitLines(text);
    const ci_steps = [];
    let consumed = -1;
    for (const { at, column, value } of keyMatches(lines, 'run')) {
        if (at <= consumed || opensMapping(lines, at, value))
            continue;
        const { text: run, end } = scalarAt(lines, at, column, value);
        if (run)
            ci_steps.push({ file, line: at + 1, run });
        consumed = end;
    }
    return { ci_steps };
}
export function readGitlabCi(file, text) {
    const lines = splitLines(text);
    const ci_steps = [];
    let consumed = -1;
    for (const { at, column, value } of keyMatches(lines, 'script')) {
        if (at <= consumed)
            continue;
        if (value === '' || value.startsWith('#')) {
            const { items, end } = sequenceAt(lines, at, column);
            if (items.length > 0) {
                for (const item of items)
                    ci_steps.push({ file, line: item.line, run: item.text });
                consumed = end;
                continue;
            }
        }
        if (value.startsWith('[')) {
            for (const run of flowItems(value))
                ci_steps.push({ file, line: at + 1, run });
            continue;
        }
        const { text: run, end } = scalarAt(lines, at, column, value);
        if (run)
            ci_steps.push({ file, line: at + 1, run });
        consumed = end;
    }
    return { ci_steps };
}
//# sourceMappingURL=ci.js.map