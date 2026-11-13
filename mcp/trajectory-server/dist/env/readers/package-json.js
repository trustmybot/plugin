// package.json reader: `scripts` as runner targets and `devDependencies` as dev dependencies, each with its line.
import { splitLines } from '../text.js';
function stringMap(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return [];
    return Object.entries(value).filter((e) => typeof e[1] === 'string');
}
function keyLine(lines, key, from) {
    const needle = JSON.stringify(key);
    for (let i = from; i < lines.length; i++) {
        const at = lines[i].indexOf(needle);
        if (at >= 0 && /^\s*:/.test(lines[i].slice(at + needle.length)))
            return i;
    }
    return -1;
}
// Each entry of the top-level object `section`, with the 1-based line of its key.
function sectionEntries(lines, parsed, section) {
    const entries = stringMap(parsed[section]);
    if (entries.length === 0)
        return [];
    const start = keyLine(lines, section, 0);
    let cursor = start < 0 ? 0 : start + 1;
    return entries.map(([key, value]) => {
        const at = keyLine(lines, key, cursor);
        if (at >= 0)
            cursor = at + 1;
        return { key, value, line: at >= 0 ? at + 1 : start + 1 };
    });
}
export function readPackageJson(file, text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return {};
    const lines = splitLines(text);
    const obj = parsed;
    const runner_targets = sectionEntries(lines, obj, 'scripts').map((e) => ({
        file,
        line: e.line,
        name: e.key,
        command: e.value,
    }));
    const dev_dependencies = sectionEntries(lines, obj, 'devDependencies').map((e) => ({
        file,
        line: e.line,
        name: e.key,
        group: 'devDependencies',
    }));
    return { runner_targets, dev_dependencies };
}
//# sourceMappingURL=package-json.js.map