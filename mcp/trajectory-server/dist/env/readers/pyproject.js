// pyproject.toml reader: [tool.*] headers, [tool.*.scripts|tasks] entries and the dev dependency groups, each with its line.
import { quotedStrings, requirementName, splitLines, stripHashComment, tomlHeader, tomlKeyValue, unquote } from '../text.js';
const RUNNER_TABLES = new Set(['scripts', 'tasks']);
// The dependency group a table's `key = [..]` arrays (list, every key or only `key`) or `name = ..` keys (table) belong to.
function depsMode(section) {
    const s = section.join('.');
    if (s === 'dependency-groups' || s === 'project.optional-dependencies')
        return { mode: 'list' };
    if (s === 'tool.uv')
        return { mode: 'list', key: 'dev-dependencies' };
    if (s === 'tool.poetry.dev-dependencies')
        return { mode: 'table', group: 'dev' };
    if (section.length === 5 && section[0] === 'tool' && section[1] === 'poetry' && section[2] === 'group' && section[4] === 'dependencies') {
        return { mode: 'table', group: section[3] };
    }
    return null;
}
function bracketDelta(line) {
    const bare = line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '');
    return (bare.match(/\[/g)?.length ?? 0) - (bare.match(/\]/g)?.length ?? 0);
}
function listItems(line) {
    return quotedStrings(stripHashComment(line).replace(/\{[^}]*\}/g, ''));
}
export function readPyproject(file, text) {
    const lines = splitLines(text);
    const config_files = [];
    const runner_targets = [];
    const dev_dependencies = [];
    let section = [];
    for (let i = 0; i < lines.length; i++) {
        const header = tomlHeader(lines[i]);
        if (header) {
            section = header;
            if (header[0] === 'tool' && header.length > 1)
                config_files.push({ file, line: i + 1, section: header.join('.') });
            continue;
        }
        const kv = tomlKeyValue(lines[i]);
        if (!kv)
            continue;
        if (section[0] === 'tool' && section.length > 1 && RUNNER_TABLES.has(section[section.length - 1])) {
            const command = kv.value.startsWith('"') || kv.value.startsWith("'") ? unquote(kv.value) : kv.value;
            runner_targets.push({ file, line: i + 1, name: kv.key, command });
            continue;
        }
        const deps = depsMode(section);
        if (!deps)
            continue;
        if (deps.mode === 'table') {
            dev_dependencies.push({ file, line: i + 1, name: kv.key, group: deps.group });
            continue;
        }
        if (!kv.value.startsWith('[') || (deps.key !== undefined && kv.key !== deps.key))
            continue;
        let depth = 0;
        let j = i;
        for (; j < lines.length; j++) {
            const body = j === i ? kv.value : lines[j];
            for (const item of listItems(body)) {
                const name = requirementName(item);
                if (name)
                    dev_dependencies.push({ file, line: j + 1, name, group: kv.key });
            }
            depth += bracketDelta(stripHashComment(body));
            if (depth <= 0)
                break;
        }
        i = j;
    }
    return { config_files, runner_targets, dev_dependencies };
}
//# sourceMappingURL=pyproject.js.map