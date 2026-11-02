/**
 * The matcher and part columns of dist/hooks-router.txt. Its columns are
 * space-separated, so an empty matcher prints as this sentinel: `-` is no tool
 * name and, read by an older router as a matcher regex, fits nothing. A part is
 * the seventh column, and a default group's row stops at six, so a row of a table
 * that predates parts reads as a default group's.
 */
export const EMPTY_MATCHER_COLUMN = '-';

/**
 * A tsOnly gate's kind column. dispatch.sh fails closed on `enforcement` and,
 * under TMB_HOOKS_IMPL=bash, has no script to run for this gate, so that word
 * would deny every call reaching it through the headless shim. The router reads
 * the gate's real kind from ROUTER_GROUPS.
 */
export function kindColumn(gate: { readonly kind: string; readonly tsOnly?: boolean }): string {
  return gate.tsOnly ? 'ts-only' : gate.kind;
}

export function matcherColumn(matcher: string): string {
  return matcher === '' ? EMPTY_MATCHER_COLUMN : matcher;
}

export function matcherOfColumn(column: string): string {
  return column === EMPTY_MATCHER_COLUMN ? '' : column;
}

export function partColumn(part: string | undefined): string {
  return part === undefined ? '' : ` ${part}`;
}

/** Whether a row, split on spaces, belongs to <part>; undefined is the default group. */
export function rowHoldsPart(fields: readonly string[], part: string | undefined): boolean {
  return fields[6] === part;
}
