// README text for a world-model summary (GH 1834): HTML tags and comments
// stripped to their inner text, images and badge rows dropped, and the
// blocks before the first prose paragraph that carry no prose (only tags,
// images or links) removed, so the summary clip spends its bytes on prose.

const LINKED_IMAGE = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;

function untilStable(s: string, step: (s: string) => string): string {
  let prev: string;
  let out = s;
  do {
    prev = out;
    out = step(out);
  } while (out !== prev);
  return out;
}

function stripMarkup(s: string): string {
  const noComments = untilStable(s, (t) => t.replace(/<!--[\s\S]*?-->/g, ''));
  const noImages = untilStable(noComments, (t) => t.replace(LINKED_IMAGE, '').replace(IMAGE, ''));
  return untilStable(noImages, (t) => t.replace(/<[^>]*>/g, '')).replace(/<(?=[A-Za-z/!?])/g, '');
}

function hasProse(block: string[]): boolean {
  return block.some((l) => /\p{L}/u.test(l.replace(LINK, '')));
}

function isHeading(block: string[]): boolean {
  return block.length === 1 && /^\s*#{1,6}\s/.test(block[0]!);
}

export function cleanReadme(text: string): string {
  const lines = text.split('\n');
  const stripped = lines.map(stripMarkup);
  let changed = stripped.some((l, i) => l !== lines[i]);
  const kept: string[] = [];
  let block: string[] = [];
  let proseSeen = false;
  const flush = (): void => {
    if (block.length === 0) return;
    if (proseSeen || hasProse(block)) {
      if (kept.length > 0) kept.push('');
      kept.push(...block);
      if (!isHeading(block)) proseSeen = true;
    } else {
      changed = true;
    }
    block = [];
  };
  stripped.forEach((line, i) => {
    if (line.trim() !== '') block.push(line);
    else if (lines[i]!.trim() === '') flush();
  });
  flush();
  return changed ? `${kept.join('\n')}\n` : text;
}
