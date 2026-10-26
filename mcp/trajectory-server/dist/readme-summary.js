// README text for a world-model summary (GH 1834): HTML tags and comments
// stripped to their inner text, images and badge rows dropped, and the
// blocks before the first prose paragraph that carry no prose (only tags,
// images or links) removed, so the summary clip spends its bytes on prose.
const LINKED_IMAGE = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
function untilStable(s, step) {
    let prev;
    let out = s;
    do {
        prev = out;
        out = step(out);
    } while (out !== prev);
    return out;
}
function stripMarkup(s) {
    const noComments = untilStable(s, (t) => t.replace(/<!--[\s\S]*?-->/g, ''));
    const noImages = untilStable(noComments, (t) => t.replace(LINKED_IMAGE, '').replace(IMAGE, ''));
    return untilStable(noImages, (t) => t.replace(/<[^>]*>/g, '')).replace(/<(?=[A-Za-z/!?])/g, '');
}
function hasProse(block) {
    return block.some((l) => /\p{L}/u.test(l.replace(LINK, '')));
}
function isHeading(block) {
    return block.length === 1 && /^\s*#{1,6}\s/.test(block[0]);
}
export function cleanReadme(text) {
    const lines = text.split('\n');
    const stripped = lines.map(stripMarkup);
    let changed = stripped.some((l, i) => l !== lines[i]);
    const kept = [];
    let block = [];
    let proseSeen = false;
    const flush = () => {
        if (block.length === 0)
            return;
        if (proseSeen || hasProse(block)) {
            if (kept.length > 0)
                kept.push('');
            kept.push(...block);
            if (!isHeading(block))
                proseSeen = true;
        }
        else {
            changed = true;
        }
        block = [];
    };
    stripped.forEach((line, i) => {
        if (line.trim() !== '')
            block.push(line);
        else if (lines[i].trim() === '')
            flush();
    });
    flush();
    return changed ? `${kept.join('\n')}\n` : text;
}
//# sourceMappingURL=readme-summary.js.map