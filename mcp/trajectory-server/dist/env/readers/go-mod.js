// go.mod reader: `tool` directives, single-line and block form, as dev dependencies with their lines.
import { splitLines } from '../text.js';
const GROUP = 'tool';
function stripComment(line) {
    const at = line.indexOf('//');
    return (at >= 0 ? line.slice(0, at) : line).trim();
}
export function readGoMod(file, text) {
    const lines = splitLines(text);
    const dev_dependencies = [];
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
        const line = stripComment(lines[i]);
        if (inBlock) {
            if (line === ')')
                inBlock = false;
            else if (line)
                dev_dependencies.push({ file, line: i + 1, name: line.split(/\s+/)[0], group: GROUP });
            continue;
        }
        if (/^tool\s*\($/.test(line)) {
            inBlock = true;
            continue;
        }
        const m = line.match(/^tool\s+(\S+)/);
        if (m)
            dev_dependencies.push({ file, line: i + 1, name: m[1], group: GROUP });
    }
    return { dev_dependencies };
}
//# sourceMappingURL=go-mod.js.map