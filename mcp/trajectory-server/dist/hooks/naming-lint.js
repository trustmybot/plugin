/**
 * PreToolUse lint (GH 1692), the port of scripts/hooks/naming-lint.sh: when
 * Edit / Write / MultiEdit / NotebookEdit creates a file, warns through
 * additionalContext when its basename breaks the language's convention
 * (snake_case .py / .sql, kebab-case .sh / .ts / .js, kebab-case or
 * PascalCase .tsx / .jsx). Bypass: TMB_SKIP_NAMING_LINT=1.
 *
 * Messages and decisions are the .sh's; the lint also runs with no jq on PATH.
 */
import { existsSync } from 'node:fs';
import { ALLOW } from './gate.js';
import { anyLine, jqPath, jqRawOr, preToolContext, shellCapture } from './lib/lint-shell.js';
import { posixBasename } from './lib/project-env.js';
export const GATE_NAME = 'naming-lint';
const TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FIXED_NAMES = new Set([
    '__init__.py', '__main__.py', 'conftest.py', 'setup.py',
    'index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs',
]);
const FIXED_PREFIXES = ['CHANGELOG', 'LICENSE', 'README', 'TODO', 'NOTICE', 'AUTHORS', '.'];
const SKIPPED_DIRS = [
    '/node_modules/', '/dist/', '/build/', '/.next/', '/__pycache__/', '/target/',
    '/fixtures/', '/snapshots/', '/__snapshots__/', '/migrations/',
];
const SNAKE = /^[a-z][a-z0-9_]*$/;
const KEBAB = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
/** `$(basename "$p")` on macOS: an argument it reads as an option fails, leaving "". */
function basename(path) {
    if (path.length > 1 && path.startsWith('-'))
        return '';
    return shellCapture(posixBasename(path));
}
function violationFor(ext, name) {
    switch (ext) {
        case 'py':
        case 'sql':
            return anyLine(name, SNAKE) ? '' : `${ext} files use snake_case (got '${name}')`;
        case 'sh':
        case 'bash':
            return anyLine(name, KEBAB) ? '' : `shell scripts use kebab-case (got '${name}')`;
        case 'ts':
        case 'js':
        case 'mjs':
        case 'cjs':
            return anyLine(name, KEBAB) ? '' : `${ext} modules use kebab-case (got '${name}')`;
        case 'tsx':
        case 'jsx':
            return anyLine(name, KEBAB) || anyLine(name, PASCAL)
                ? ''
                : `${ext} files use kebab-case (route/hook) or PascalCase (component); got '${name}'`;
        default:
            return '';
    }
}
export const namingLint = (payload, env) => {
    if ((env.TMB_SKIP_NAMING_LINT ?? '0') === '1')
        return ALLOW;
    if (!TOOLS.has(jqRawOr(payload, [jqPath('tool_name')])))
        return ALLOW;
    const target = jqRawOr(payload, [jqPath('tool_input', 'file_path'), jqPath('tool_input', 'notebook_path')]);
    if (target === '' || existsSync(target))
        return ALLOW;
    const base = basename(target);
    const dot = base.lastIndexOf('.');
    const name = dot < 0 ? base : base.slice(0, dot);
    const ext = dot < 0 ? base : base.slice(dot + 1);
    if (FIXED_NAMES.has(base) || FIXED_PREFIXES.some((p) => base.startsWith(p)))
        return ALLOW;
    if (SKIPPED_DIRS.some((d) => target.includes(d)))
        return ALLOW;
    const violation = violationFor(ext, name);
    if (violation === '')
        return ALLOW;
    const ctx = `naming-lint: ${target} — ${violation}. Set TMB_SKIP_NAMING_LINT=1 to bypass when the project's local convention differs.`;
    return { stdout: preToolContext(ctx), code: 0 };
};
//# sourceMappingURL=naming-lint.js.map