// Forked from GitHub relative-time-element (github.com/github/relative-time-element, MIT), rebuilt as a React component.
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const THIS_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const OTHER_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RELATIVE_LIMIT = 30 * DAY;

export function relativeText(date: Date, now: Date): string {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs >= RELATIVE_LIMIT) {
    const format = date.getFullYear() === now.getFullYear() ? THIS_YEAR : OTHER_YEAR;
    return `on ${format.format(date)}`;
  }
  if (abs < MINUTE) return RELATIVE.format(Math.trunc(diff / SECOND), 'second');
  if (abs < HOUR) return RELATIVE.format(Math.trunc(diff / MINUTE), 'minute');
  if (abs < DAY) return RELATIVE.format(Math.trunc(diff / HOUR), 'hour');
  return RELATIVE.format(Math.trunc(diff / DAY), 'day');
}

export function RelativeTime({ value, now }: { value: unknown; now?: Date }) {
  if (value === null || value === undefined || value === '') return <span className="text-fg-muted">—</span>;
  const iso = String(value);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return <>{iso}</>;
  return (
    <time dateTime={iso} title={FULL.format(date)} className="whitespace-nowrap">
      {relativeText(date, now ?? new Date())}
    </time>
  );
}
