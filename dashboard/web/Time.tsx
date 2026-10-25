const THIS_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const OLDER = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

export function Time({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-zinc-400">—</span>;
  const iso = String(value);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>{iso}</>;
  const short = date.getFullYear() === new Date().getFullYear() ? THIS_YEAR : OLDER;
  return (
    <time dateTime={iso} title={FULL.format(date)} className="whitespace-nowrap">
      {short.format(date)}
    </time>
  );
}
