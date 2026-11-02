/** What counts as a prose file for the no-prose-in-scratch gate and the scratch_no_prose contract (GH 2089). */
const PROSE_SUFFIX = /\.(md|markdown|txt|rst)$/i;

export function isProseFile(path: string): boolean {
  return PROSE_SUFFIX.test(path);
}
