import { MilestoneIcon } from '@primer/octicons-react';
import type { Row } from '../../api.ts';
import { FilterMenu } from './FilterMenu.tsx';
import { milestoneLabel, milestoneOptions } from './milestones.ts';

export function MilestoneMenu({ rows, value }: { rows: Row[]; value: string | null }) {
  return (
    <FilterMenu
      param="milestone"
      icon={MilestoneIcon}
      title="Milestone"
      allLabel="All milestones"
      options={milestoneOptions(rows)}
      value={value}
      valueLabel={value ? milestoneLabel(value) : null}
    />
  );
}
