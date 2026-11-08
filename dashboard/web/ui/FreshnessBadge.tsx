import { AlertIcon, ClockIcon, SyncIcon, type Icon } from '@primer/octicons-react';
import { useWmStatus, type Freshness } from '../api.ts';
import { labelClass, LABEL_ICON, type LabelVariant } from './Label.tsx';

export type FreshnessState = 'reindexing' | 'failed' | 'stale';

const LOOK: Record<FreshnessState, { text: string; icon: Icon; variant: LabelVariant }> = {
  reindexing: { text: 'Reindexing', icon: SyncIcon, variant: 'accent' },
  failed: { text: 'Reindex failed', icon: AlertIcon, variant: 'danger' },
  stale: { text: 'Stale', icon: ClockIcon, variant: 'attention' },
};

export function freshnessState(block: Freshness | null | undefined): FreshnessState | null {
  if (!block) return null;
  if (block.reindex.state === 'running') return 'reindexing';
  if (block.reindex.state === 'failed') return 'failed';
  return block.stale ? 'stale' : null;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : 'none');

export function FreshnessBadge({ block }: { block: Freshness | null | undefined }) {
  const state = freshnessState(block);
  if (state === null || !block) return null;
  const { text, icon: StateIcon, variant } = LOOK[state];
  return (
    <span className={labelClass(variant)} title={`Indexed ${short(block.indexed_commit)}, target ${short(block.target_commit)}`}>
      <StateIcon size={LABEL_ICON} aria-hidden="true" />
      {text}
    </span>
  );
}

export function RepoFreshness({ repo }: { repo: string | null }) {
  const status = useWmStatus().data;
  return <FreshnessBadge block={status?.repos.find((r) => r.repo === repo)?.freshness} />;
}
