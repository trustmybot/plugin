/**
 * `cli.js prompt-author-lint` (GH 1692): the pre-write lint for agent and skill files.
 *
 *   node --experimental-sqlite "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/cli.js" prompt-author-lint <path-to-md-file>
 *
 * Scans the body after the frontmatter (the lines after the second `---` line;
 * a file with no such pair has no body) for bare negations (a prohibition with
 * no alternative and no hard-limit mark) and noise citations. Prints one `[<class>] <n>:<line>` finding per line on stdout, n
 * counting body lines, class by class. Advisory: exit 0 always, usage included.
 */
import { readFileSync } from 'node:fs';
import { isFile } from './fallback-db.js';
const USAGE = 'usage: cli.js prompt-author-lint <path-to-md-file>\n';
const COMMENT_LINE = /^[ \t\n\v\f\r]*(#|\/\/|--)/;
const PAIRED_ALTERNATIVE = /\b(instead|rather than|unless|only when|only if|except)\b| — |;|, but\b/i;
const HARD_LIMIT = /\bNEVER\b|\bMUST NOT\b|LOAD-BEARING-SAFETY/;
const CHECKS = [
    {
        name: 'bare-negation',
        match: /^(Don't|Never|Do not) |\bdo not\b|\bdon't\b|\bnever\b/,
        skip: (text) => COMMENT_LINE.test(text) || PAIRED_ALTERNATIVE.test(text) || HARD_LIMIT.test(text),
    },
    { name: 'issue-number', match: /#[0-9]{1,5}\b|\(#[A-Z]+[0-9]+\)|\[bro #[0-9]+\]/ },
    { name: 'memory-path', match: /feedback_[a-z_-]+\.md|~\/\.claude\/projects\// },
    { name: 'origin-attribution', match: /caught in|prior incident|regression during|2× during|2x during/i },
    { name: 'date', match: /\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b/ },
    { name: 'pr-url', match: /![0-9]+|gitlab\.com\/[^ \t\n\v\f\r]*\/merge_requests\// },
];
function body(text) {
    const lines = text.split('\n');
    const open = lines.indexOf('---');
    if (open === -1)
        return [];
    const close = lines.indexOf('---', open + 1);
    return close === -1 ? [] : lines.slice(close + 1);
}
export function promptAuthorLint(argv, _env, io) {
    const file = argv[0] ?? '';
    if (!isFile(file)) {
        io.err(USAGE);
        return 0;
    }
    const lines = body(readFileSync(file, 'utf8'));
    let out = '';
    for (const { name, match, skip } of CHECKS) {
        lines.forEach((text, i) => {
            if (match.test(text) && !skip?.(text))
                out += `[${name}] ${i + 1}:${text}\n`;
        });
    }
    io.out(out);
    return 0;
}
//# sourceMappingURL=prompt-author-lint.js.map