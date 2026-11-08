import type { Row } from '../../api.ts';
import type { FilterOption } from './FilterMenu.tsx';

export const NO_MILESTONE = 'none';

const milestoneOf = (issue: Row) => String(issue['milestone'] ?? '');

export const hasMilestone = (issue: Row, milestone: string) => milestoneOf(issue) === (milestone === NO_MILESTONE ? '' : milestone);

export const milestoneLabel = (milestone: string) => (milestone === NO_MILESTONE ? 'No milestone' : `Milestone: ${milestone}`);

export function milestoneOptions(rows: Row[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(milestoneOf(r), (counts.get(milestoneOf(r)) ?? 0) + 1);
  const none = counts.get('');
  counts.delete('');
  const named = [...counts].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).map(([value, count]) => ({ value, name: value, count }));
  return none ? [...named, { value: NO_MILESTONE, name: 'No milestone', count: none }] : named;
}
