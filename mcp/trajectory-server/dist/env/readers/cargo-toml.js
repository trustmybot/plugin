// Cargo.toml reader: [dev-dependencies] entries, target-scoped ones included, and [lints.*] / [workspace.lints.*] tables, each with its line.
import { splitLines, tomlHeader, tomlKeyValue } from '../text.js';
const GROUP = 'dev-dependencies';
function isLintsTable(header) {
    return header[0] === 'lints' || (header[0] === 'workspace' && header[1] === 'lints');
}
export function readCargoToml(file, text) {
    const lines = splitLines(text);
    const config_files = [];
    const dev_dependencies = [];
    let inDeps = false;
    for (let i = 0; i < lines.length; i++) {
        const header = tomlHeader(lines[i]);
        if (header) {
            if (isLintsTable(header))
                config_files.push({ file, line: i + 1, section: header.join('.') });
            const at = header.indexOf(GROUP);
            const scoped = at === 0 || (at === 2 && header[0] === 'target');
            inDeps = scoped && at === header.length - 1;
            if (scoped && at === header.length - 2)
                dev_dependencies.push({ file, line: i + 1, name: header[at + 1], group: GROUP });
            continue;
        }
        if (!inDeps)
            continue;
        const kv = tomlKeyValue(lines[i]);
        if (kv)
            dev_dependencies.push({ file, line: i + 1, name: kv.key.split('.')[0], group: GROUP });
    }
    return { config_files, dev_dependencies };
}
//# sourceMappingURL=cargo-toml.js.map