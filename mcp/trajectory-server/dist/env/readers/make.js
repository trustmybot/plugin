// Task-runner reader: Makefile, justfile and Taskfile targets with their recipe text and line; recipes are read, never run.
import { indentOf, splitLines } from '../text.js';
import { isBlankYaml, plainScalar, scalarAt, sequenceAt } from '../yaml.js';
export function readMakefile(file, text) {
    const lines = splitLines(text);
    const runner_targets = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^([^\s:#=.$%][^:#=]*?)\s*::?(?![:=])([^;]*)(;(.*))?$/);
        if (!m)
            continue;
        const recipe = m[4] !== undefined && m[4].trim() !== '' ? [m[4].trim()] : [];
        let j = i + 1;
        for (; j < lines.length && lines[j].startsWith('\t'); j++)
            recipe.push(lines[j].slice(1).trimEnd());
        const command = recipe.join('\n');
        for (const name of m[1].trim().split(/\s+/)) {
            if (!/[$%]/.test(name))
                runner_targets.push({ file, line: i + 1, name, command });
        }
        i = j - 1;
    }
    return { runner_targets };
}
const JUST_STATEMENT = /^(set|alias|export|import|mod)\s/;
export function readJustfile(file, text) {
    const lines = splitLines(text);
    const runner_targets = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (JUST_STATEMENT.test(line))
            continue;
        const m = line.match(/^@?([A-Za-z_][A-Za-z0-9_-]*)(\s[^:]*)?:(?!=)(.*)$/);
        if (!m)
            continue;
        const body = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            const next = lines[j];
            if (next.trim() === '') {
                if (j + 1 < lines.length && indentOf(lines[j + 1]) > 0 && lines[j + 1].trim() !== '')
                    continue;
                break;
            }
            if (indentOf(next) === 0)
                break;
            body.push(next);
        }
        const cut = body.length > 0 ? Math.min(...body.filter((l) => l.trim() !== '').map(indentOf)) : 0;
        const command = body.filter((l) => l.trim() !== '').map((l) => l.slice(cut).trimEnd()).join('\n');
        runner_targets.push({ file, line: i + 1, name: m[1], command });
        i = j - 1;
    }
    return { runner_targets };
}
// One task's commands: its `cmds:` items (a `cmd:` item by its value) or a lone `cmd:`.
function taskCommands(lines, from, to) {
    for (let k = from; k < to; k++) {
        const m = lines[k].match(/^(\s*)(cmds|cmd):(\s.*|)$/);
        if (!m)
            continue;
        const column = m[1].length;
        const value = m[3].trim();
        if (m[2] === 'cmd')
            return scalarAt(lines, k, column, value).text;
        if (value.startsWith('['))
            return value;
        return sequenceAt(lines, k, column)
            .items.map((item) => {
            const cmd = item.text.match(/^cmd:\s*(.*)$/s);
            return cmd ? plainScalar(cmd[1]) : item.text;
        })
            .join('\n');
    }
    return '';
}
export function readTaskfile(file, text) {
    const lines = splitLines(text);
    const runner_targets = [];
    const top = lines.findIndex((l) => /^tasks:\s*(#.*)?$/.test(l));
    if (top < 0)
        return { runner_targets };
    let end = lines.length;
    for (let j = top + 1; j < lines.length; j++) {
        if (!isBlankYaml(lines[j]) && indentOf(lines[j]) === 0) {
            end = j;
            break;
        }
    }
    const first = lines.slice(top + 1, end).find((l) => !isBlankYaml(l));
    if (!first)
        return { runner_targets };
    const taskIndent = indentOf(first);
    const starts = [];
    for (let j = top + 1; j < end; j++) {
        const line = lines[j];
        if (isBlankYaml(line) || indentOf(line) !== taskIndent)
            continue;
        const m = line.trimStart().match(/^("[^"]*"|'[^']*'|[^\s:][^:]*?):(\s.*|)$/);
        if (m)
            starts.push({ at: j, name: plainScalar(m[1]), value: m[2].trim() });
    }
    starts.forEach((s, n) => {
        const next = n + 1 < starts.length ? starts[n + 1].at : end;
        const command = s.value && !s.value.startsWith('#') ? plainScalar(s.value) : taskCommands(lines, s.at + 1, next);
        runner_targets.push({ file, line: s.at + 1, name: s.name, command });
    });
    return { runner_targets };
}
//# sourceMappingURL=make.js.map