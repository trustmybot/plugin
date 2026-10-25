import { RepoIcon, TriangleDownIcon } from '@primer/octicons-react';

const SELECT =
  'min-h-(--control-medium-size) max-w-[60vw] cursor-pointer appearance-none truncate rounded-md border border-(--control-borderColor-rest) bg-(--control-bgColor-rest) pr-8 pl-8 text-sm font-medium text-(--control-fgColor-rest) hover:bg-(--control-bgColor-hover) active:bg-(--control-bgColor-active) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2';

export function RepoPicker({ repos, value, onChange }: { repos: string[]; value: string; onChange: (repo: string) => void }) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="font-semibold text-fg">Repository</span>
      <span className="relative inline-flex min-w-0 items-center">
        <RepoIcon size={16} className="pointer-events-none absolute left-2.5 text-(--control-iconColor-rest)" aria-hidden="true" />
        <select className={SELECT} value={value} onChange={(e) => onChange(e.target.value)}>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <TriangleDownIcon size={16} className="pointer-events-none absolute right-2 text-(--control-iconColor-rest)" aria-hidden="true" />
      </span>
    </label>
  );
}
