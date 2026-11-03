// Forked from Primer React StateLabel (github.com/primer/react, MIT), rebuilt on Primer bgColor-*-emphasis tokens without @primer/react.
import { IssueClosedIcon, IssueDraftIcon, IssueOpenedIcon, SkipIcon, type Icon } from '@primer/octicons-react';
import type { ReactNode } from 'react';

export type StateLabelStatus = 'open' | 'closed' | 'notPlanned' | 'draft';

const STATE: Record<StateLabelStatus, { icon: Icon; text: string; bg: string }> = {
  open: { icon: IssueOpenedIcon, text: 'Open', bg: 'bg-(--bgColor-open-emphasis)' },
  closed: { icon: IssueClosedIcon, text: 'Closed', bg: 'bg-(--bgColor-done-emphasis)' },
  notPlanned: { icon: SkipIcon, text: 'Not Planned', bg: 'bg-(--bgColor-neutral-emphasis)' },
  draft: { icon: IssueDraftIcon, text: 'Draft', bg: 'bg-(--bgColor-neutral-emphasis)' },
};

const SIZE = { small: 'h-6 gap-1 px-2 text-xs', medium: 'h-8 gap-1 px-3 text-sm' } as const;

export function StateLabel({ status, size = 'medium', children }: { status: StateLabelStatus; size?: keyof typeof SIZE; children?: ReactNode }) {
  const { icon: StateIcon, text, bg } = STATE[status];
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full font-medium text-(--fgColor-onEmphasis) ${SIZE[size]} ${bg}`}>
      <StateIcon size={16} aria-hidden="true" />
      {children ?? text}
    </span>
  );
}
