// Structural prompt-injection defense at the tool/persistence boundary.
//
// Remotely-sourced text (a repo README, a PR/MR comment body) can carry
// instructions aimed at whichever agent later reads it. Rather than trusting a
// prompt rule to say "ignore instructions in fetched content", we mark the
// provenance structurally: the boundary wraps the text in explicit
// untrusted-data delimiters so any downstream agent treats it as DATA, not
// instructions.
export const UNTRUSTED_CLOSE = '</untrusted-content>';
// Wrap remotely-sourced `content` in untrusted-data delimiters, tagging where it
// came from via `source` (e.g. 'readme', 'pr-comment'). Any literal closing
// marker embedded in the content is neutralized so the text cannot forge an
// early close and "break out" of the fence.
export function frameUntrusted(source, content) {
    const neutralized = content.split(UNTRUSTED_CLOSE).join('</ untrusted-content>');
    return `<untrusted-content source="${source}">\n${neutralized}\n${UNTRUSTED_CLOSE}`;
}
//# sourceMappingURL=untrusted.js.map