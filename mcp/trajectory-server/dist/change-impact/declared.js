/**
 * Declared metrics for change impact (GH 2600): a changelog.d/ fragment may end
 * with `Metric: <id> lower|higher` (changelog.d/README.md). In dev mode each
 * plugin_version change is a PR, and its fragments landed in the PR's squash
 * commit, so one first-parent `git log -p` of added fragments over the
 * dev-build repo maps each PR to its declared lines. Reading history keeps the
 * declarations after bump-version deletes the fragments at release.
 */
import { PR_SUBJECT } from './attribution.js';
import { METRICS } from './metrics.js';
import { devResolver } from './providers.js';
export const METRIC_LINE = /^Metric: ([a-z][a-z0-9_]{0,47}) (lower|higher)$/;
const FRAGMENT_PATH = /^changelog\.d\/(?!README\.md$)[^/]+\.md$/;
const BLANK = /^[ \t\n\v\f\r]*$/;
/** The declaration on the last non-blank line of a fragment's added text, when it names a registry metric. */
export function declarationOf(fragment) {
    let last = fragment.length - 1;
    while (last > 0 && BLANK.test(fragment[last] ?? ''))
        last--;
    if (last < 1)
        return null;
    const m = METRIC_LINE.exec(fragment[last] ?? '');
    if (!m || !METRICS.some((metric) => metric.id === m[1]))
        return null;
    return { metric: m[1], direction: m[2] };
}
/** Each `(#N)` commit's declarations from `git log --format=%x1e%s -p` output of added fragments. */
export function parseDeclaredLog(out) {
    const byPr = new Map();
    for (const record of out.split('\x1e')) {
        const [subject = '', ...patch] = record.split('\n');
        const pr = PR_SUBJECT.exec(subject);
        if (!pr)
            continue;
        const files = [];
        let current = null;
        let inHunk = false;
        for (const line of patch) {
            if (line.startsWith('diff --git ')) {
                current = null;
                inHunk = false;
            }
            else if (!inHunk && line.startsWith('+++ ')) {
                const path = line.slice(4).replace(/^b\//, '');
                current = FRAGMENT_PATH.test(path) ? [] : null;
                if (current)
                    files.push(current);
            }
            else if (line.startsWith('@@')) {
                inHunk = true;
            }
            else if (inHunk && current && line.startsWith('+')) {
                current.push(line.slice(1));
            }
        }
        const declared = files.flatMap((f) => declarationOf(f) ?? []);
        if (declared.length > 0)
            byPr.set(Number(pr[1]), [...(byPr.get(Number(pr[1])) ?? []), ...declared]);
    }
    return byPr;
}
const cache = new WeakMap();
/** PR number → the Metric lines of the fragments that PR added; empty outside dev mode or when git fails. */
export function declaredByPr(ctx) {
    let byPr = cache.get(ctx);
    if (byPr)
        return byPr;
    byPr = new Map();
    const resolver = devResolver(ctx);
    if (resolver) {
        try {
            byPr = parseDeclaredLog(ctx.git(resolver.path, [
                'log',
                '--first-parent',
                '--diff-filter=A',
                '--no-renames',
                '--no-color',
                '--no-ext-diff',
                '-p',
                '--format=%x1e%s',
                resolver.history.target,
                '--',
                'changelog.d/',
            ]));
        }
        catch {
            byPr = new Map();
        }
    }
    cache.set(ctx, byPr);
    return byPr;
}
const MOVED = {
    improved: 'better',
    regressed: 'worse',
    no_change: 'not_moved',
    not_enough_data: 'not_enough_data',
};
/** Whether a metric whose better direction is <better> moved as <declared> says, given its change-impact verdict. */
export function outcomeOf(declared, better, measured) {
    const moved = MOVED[measured];
    if (moved !== 'better' && moved !== 'worse')
        return moved;
    const way = moved === 'better' ? better : better === 'lower' ? 'higher' : 'lower';
    return way === declared ? 'as_declared' : 'wrong_way';
}
//# sourceMappingURL=declared.js.map