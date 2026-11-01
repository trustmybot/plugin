/**
 * The matcher column of dist/hooks-router.txt. Its columns are space-separated,
 * so an empty matcher prints as this sentinel: `-` is no tool name and, read by
 * an older router as a matcher regex, fits nothing.
 */
export const EMPTY_MATCHER_COLUMN = '-';

export function matcherColumn(matcher: string): string {
  return matcher === '' ? EMPTY_MATCHER_COLUMN : matcher;
}

export function matcherOfColumn(column: string): string {
  return column === EMPTY_MATCHER_COLUMN ? '' : column;
}
