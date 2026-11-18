/**
 * The mode a task closed under, as tasks.workflow_mode stores it (GH 3281):
 * agile, exempt, or truest/NULL. A NULL is a task closed before v66 or outside
 * any mode and reads as truest. Each predicate comes as SQL text over a
 * column reference and as a TS check on a read value, so the server, the hooks
 * and the CLI read a stored mode one way. No imports: the hook bundle loads it.
 */

/** The column a predicate reads: `<alias>.workflow_mode`, or the bare column for an empty alias. */
function modeColumn(alias: string): string {
  return alias === '' ? 'workflow_mode' : `${alias}.workflow_mode`;
}

// IS, not =, so a NULL mode reads false rather than NULL and NOT of a
// predicate still holds for it.

/** Closed under agile: its review is the grouped one. */
export const storedAgileSql = (alias: string): string => `${modeColumn(alias)} IS 'agile'`;

/** Closed under exempt: no review is owed. */
export const storedExemptSql = (alias: string): string => `${modeColumn(alias)} IS 'exempt'`;

/** Owes its own per-task review: neither agile nor exempt (NULL reads as truest). */
export const storedReviewOwedSql = (alias: string): string =>
  `COALESCE(${modeColumn(alias)}, 'truest') NOT IN ('agile', 'exempt')`;

export function isStoredAgile(mode: string | null | undefined): boolean {
  return mode === 'agile';
}

export function isStoredExempt(mode: string | null | undefined): boolean {
  return mode === 'exempt';
}

export function storedReviewOwed(mode: string | null | undefined): boolean {
  return !isStoredAgile(mode) && !isStoredExempt(mode);
}
