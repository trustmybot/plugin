// The checkouts nested inside a repo that the repo's world model does not
// index (GH 3031): task worktrees under .claude/worktrees/, and any directory
// below the repo root with its own .git (a nested repo or linked worktree).
// The scan walk and the built-bundle listing share these, so a path the walk
// leaves out never gets symbols either.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const WORKTREES_DIR = /(^|\/)\.claude\/worktrees(\/|$)/;
export function inWorktreesDir(relPath) {
    return WORKTREES_DIR.test(relPath);
}
// A predicate over repo-relative paths: true when the path lies in a worktrees
// dir or below a directory (not the root) holding a .git entry. Each directory
// is probed once per predicate.
export function nestedCheckoutFilter(repoPath) {
    const hasGit = new Map();
    const isCheckout = (dir) => {
        let found = hasGit.get(dir);
        if (found === undefined) {
            found = existsSync(join(repoPath, dir, '.git'));
            hasGit.set(dir, found);
        }
        return found;
    };
    return (relPath) => {
        if (inWorktreesDir(relPath))
            return true;
        const segments = relPath.split('/').slice(0, -1);
        for (let i = 1; i <= segments.length; i++) {
            if (isCheckout(segments.slice(0, i).join('/')))
                return true;
        }
        return false;
    };
}
//# sourceMappingURL=nested-checkouts.js.map