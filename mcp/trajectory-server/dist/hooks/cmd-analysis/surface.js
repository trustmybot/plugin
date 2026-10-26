/**
 * The prompt-surface predicate and the write-shape list of
 * scripts/hooks/lib/cmd-analysis.sh (GH 1692): tmb_is_prompt_surface_path
 * with _tmb_surface_root, and tmb_cmd_write_shapes.
 */
import { stripTrailingNewlines } from '../lib/db.js';
import { isDir } from '../lib/git.js';
import { repoGitRoot } from '../lib/repo.js';
import { worktreeRootForTarget } from '../lib/target-task.js';
import { pathCanonical } from './path.js';
export const WRITE_SHAPES = [
    '>', '>>', '>|', '&>', 'exec N>', 'heredoc into a redirect', 'tee', 'tee -a',
    'sed -i', 'perl -i', 'dd of=', 'truncate', 'cp', 'mv', 'install', 'rsync', 'git mv',
    'ln', 'mkdir', 'rm', 'touch', 'tar -C / make -C / env -C / npm --prefix',
    'git commit / reset / checkout / stash / clean / bisect / submodule update / … in its -C dir or own dir',
    'git init <dir> / format-patch -o / archive -o / checkout-index --prefix',
    'python -c / node -e / perl -e / ruby -e with a write mode',
    'a program fed to python / node / perl / ruby / sh through a heredoc',
    'find -exec / -execdir / -ok / -delete / -fprint', 'fd -x / -X', 'xargs fed by find or fd',
];
const PROMPT_FILES = new Set(['CLAUDE.md', 'CODEX.md', 'CURSOR.md', 'GEMINI.md']);
/** tmb_cmd_write_shapes: the write shapes the Bash rules judge, comma-joined. */
export function writeShapes() {
    return WRITE_SHAPES.join(', ');
}
/** _tmb_surface_root <abs>: the enclosing .claude/worktrees/<name>, else the main git root of the nearest existing ancestor. */
export function surfaceRoot(abs, env = process.env) {
    if (abs.includes('/.claude/worktrees/'))
        return worktreeRootForTarget(abs);
    const parent = (path) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
    let dir = parent(abs);
    while (dir !== '' && !isDir(dir))
        dir = parent(dir);
    if (dir === '')
        dir = '/';
    return stripTrailingNewlines(repoGitRoot(dir, env));
}
/**
 * tmb_is_prompt_surface_path <path> [<root>]: a CLAUDE/CODEX/CURSOR/GEMINI.md
 * anywhere, or a .md under agents/, skills/, commands/, templates/ or rules/
 * (or .claude/agents|skills|commands|rules/) of <root>, the path's own repo
 * root when none is given.
 */
export function isPromptSurfacePath(p, root = '', env = process.env) {
    if (PROMPT_FILES.has(p.slice(p.lastIndexOf('/') + 1)))
        return true;
    let rel = '';
    if (p.startsWith('/')) {
        const abs = stripTrailingNewlines(pathCanonical(p));
        let r = root === '' ? surfaceRoot(abs, env) : root;
        if (r !== '') {
            r = stripTrailingNewlines(pathCanonical(r));
            const prefix = `${r.endsWith('/') ? r.slice(0, -1) : r}/`;
            if (abs.startsWith(prefix))
                rel = abs.slice(prefix.length);
        }
    }
    else
        rel = p.startsWith('./') ? p.slice(2) : p;
    if (rel === '') {
        if (!p.endsWith('.md'))
            return false;
        return /\/(agents|skills|commands|templates|rules)\//.test(`/${p.startsWith('/') ? p.slice(1) : p}`);
    }
    return /^(agents|skills|commands|templates|rules)\/[^]*\.md$/.test(rel) || /^\.claude\/(agents|skills|commands|rules)\/[^]*\.md$/.test(rel);
}
//# sourceMappingURL=surface.js.map