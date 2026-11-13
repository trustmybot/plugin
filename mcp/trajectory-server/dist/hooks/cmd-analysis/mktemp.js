/**
 * GH 1912: the mktemp calls whose printed path the write-path analyzer
 * resolves. Flags only from -d, -q and `-t <prefix>`, at most one template
 * operand after them, never both -t and an operand. encode.ts frames such a
 * substitution's body after MKTEMP_MARK so write-paths.ts can tell it from a
 * `$(` that quoting made literal.
 */
export const MKTEMP_MARK = '\x18';
const PREFIX = /^[A-Za-z0-9._-]+$/;
/** The prefix and template of `mktemp <words>`, or null for any other shape. */
export function mktempCall(words) {
    if (words[0] !== 'mktemp')
        return null;
    let prefix = null;
    let template = null;
    for (let i = 1; i < words.length; i++) {
        const w = words[i];
        if (template !== null)
            return null;
        if (w === '-d' || w === '-q')
            continue;
        if (w === '-t') {
            const p = words[++i];
            if (prefix !== null || p === undefined || !PREFIX.test(p))
                return null;
            prefix = p;
        }
        else if (w.startsWith('-'))
            return null;
        else
            template = w;
    }
    return prefix !== null && template !== null ? null : { prefix, template };
}
//# sourceMappingURL=mktemp.js.map