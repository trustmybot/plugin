// README drift of a world-model directory (commits behind, dead refs) and its text markers.
import type { WmNode } from '../../api.ts';
import { Label } from '../../ui/Label.tsx';

export interface Drift {
  behind: number;
  deadRefs: string[];
}

export function driftOf(node: WmNode): Drift | null {
  const behind = node.commits_behind ?? 0;
  const deadRefs = node.dead_refs ?? [];
  return behind > 0 || deadRefs.length > 0 ? { behind, deadRefs } : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const behindText = (n: number) => `${plural(n, 'commit', 'commits')} behind`;
export const deadRefsText = (n: number) => `${plural(n, 'dead ref', 'dead refs')}`;

export function driftLines(drift: Drift): string[] {
  return [
    ...(drift.behind > 0 ? [behindText(drift.behind)] : []),
    ...(drift.deadRefs.length > 0 ? [`${deadRefsText(drift.deadRefs.length)}: ${drift.deadRefs.join(', ')}`] : []),
  ];
}

export function DriftMarkers({ node }: { node: WmNode }) {
  const drift = driftOf(node);
  if (!drift) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {drift.behind > 0 && <Label variant="attention">{behindText(drift.behind)}</Label>}
      {drift.deadRefs.length > 0 && (
        <span title={drift.deadRefs.join('\n')}>
          <Label variant="attention">{deadRefsText(drift.deadRefs.length)}</Label>
        </span>
      )}
    </span>
  );
}
