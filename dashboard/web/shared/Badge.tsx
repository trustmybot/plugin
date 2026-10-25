export const STATUS_COLORS: Record<string, string> = {
  open: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  running: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  needs_validation: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  closed: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  pass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  fail: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  escalated: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  escalate: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300',
  verified: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  suspect: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  broken: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
};

export function Badge({ value }: { value: unknown }) {
  const s = String(value ?? '—');
  return <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_COLORS[s] ?? 'bg-zinc-100 dark:bg-zinc-800'}`}>{s}</span>;
}
