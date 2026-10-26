// README text for a world-model summary (GH 1834): HTML tags and comments
// stripped to their inner text, images and badge rows dropped, and the
// blocks before the first prose paragraph that carry no prose (only tags,
// images or links) removed, so the summary clip spends its bytes on prose.
// Per CommonMark 0.31.2 (§4.6, §6.6) no tag spans a blank line; only HTML
// comments may, so they are stripped over the whole text and tags per block.
// Line endings are normalized to \n first (CommonMark §2.1: LF, CR or CRLF);
// untouched input comes back as given, changed output uses \n throughout.

export const README_CLEAN_MAX_CHARS = 16 * 1024;

const LINKED_IMAGE = /\[!\[[^[\]]*\]\([^()]*\)\]\([^()]*\)/g;
const IMAGE = /!\[[^[\]]*\]\([^()]*\)/g;
const LINK = /\[([^[\]]*)\]\([^()]*\)/g;

function untilStable(s: string, step: (s: string) => string): string {
  let prev: string;
  let out = s;
  do {
    prev = out;
    out = step(out);
  } while (out !== prev);
  return out;
}

const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<[A-Za-z/!?](?:[^<>\n]|\n(?![ \t]*\n))*>/g;
const STRAY_TAG_OPEN = /<(?=[A-Za-z/!?])/g;

const newlinesOf = (m: string): string => m.replace(/[^\n]/g, '');

function stripMarkup(s: string): string {
  const noComments = untilStable(s, (t) => t.replace(COMMENT, newlinesOf));
  const noImages = untilStable(noComments, (t) => t.replace(LINKED_IMAGE, newlinesOf).replace(IMAGE, newlinesOf));
  const noTags = untilStable(noImages, (t) => t.replace(TAG, newlinesOf));
  return untilStable(noTags, (t) => t.replace(STRAY_TAG_OPEN, ''));
}

function hasProse(block: string[]): boolean {
  return block.some((l) => /\p{L}/u.test(l.replace(LINK, '')));
}

function isHeading(block: string[]): boolean {
  return block.length === 1 && /^\s*#{1,6}\s/.test(block[0]!);
}

export function cleanReadme(raw: string): string {
  const text = raw.length > README_CLEAN_MAX_CHARS ? raw.slice(0, README_CLEAN_MAX_CHARS) : raw;
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const stripped = stripMarkup(normalized).split('\n');
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
