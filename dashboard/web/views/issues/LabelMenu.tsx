import { TagIcon } from '@primer/octicons-react';
import { FilterMenu } from './FilterMenu.tsx';

export function LabelMenu({ labels, value }: { labels: Array<{ label: string; count: number }>; value: string | null }) {
  return (
    <FilterMenu
      param="label"
      icon={TagIcon}
      title="Label"
      allLabel="All labels"
      options={labels.map((l) => ({ value: l.label, name: l.label, count: l.count }))}
      value={value}
      valueLabel={value ? `Label: ${value}` : null}
    />
  );
}
