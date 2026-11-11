// Rules and scope of the no-hardcoded-plugin-name L1 lint, shared by its whole-tree test and file-lint.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HARDCODED = /(\.claude\/tmb\/|tmb-active-workspace|trustmybot-rc|=["']tmb["'])/;
const EXCLUDED_FILES = ['scripts/publish-rc-channel.ts'];
const EXCLUDED_LINE_PATTERNS = [`jq -r '.name // "tmb"'`, 'jq -r .name', 'PLUGIN_NAME="tmb"', "PLUGIN_NAME='tmb'"];
const DIRS = ['scripts', 'mcp/trajectory-server/src'];
const SOURCE = /\.(ts|js)$/;

function sources(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) sources(child, out);
    else if (entry.isFile() && SOURCE.test(entry.name)) out.push(child);
  }
}

export function hardcodedLines(file, rel) {
  return hardcodedInText(readFileSync(file, 'utf8'), rel);
}

export function hardcodedInText(text, rel) {
  return text.split('\n').flatMap((line, i) =>
    HARDCODED.test(line) && !EXCLUDED_LINE_PATTERNS.some((p) => line.includes(p)) ? [`${rel}:${i + 1}: hardcoded plugin name`] : [],
  );
}

export function scope() {
  return (rel) => DIRS.some((d) => rel.startsWith(`${d}/`)) && SOURCE.test(rel) && !EXCLUDED_FILES.includes(rel) && !rel.includes('test');
}

export function files(root) {
  const all = [];
  for (const dir of DIRS) {
    if (existsSync(join(root, dir))) sources(join(root, dir), all);
  }
  const inScope = scope();
  return all
    .map((f) => f.slice(root.length + 1))
    .filter(inScope)
    .sort();
}
