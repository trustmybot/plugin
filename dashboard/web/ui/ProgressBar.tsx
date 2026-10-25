// Forked from Primer React ProgressBar (github.com/primer/react, MIT), rebuilt on Primer bgColor tokens without @primer/react.
export function ProgressBar({
  value,
  max,
  label,
  fill = 'bg-(--bgColor-success-emphasis)',
  className,
}: {
  value: number;
  max: number;
  label: string;
  fill?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={`flex h-2 overflow-hidden rounded-md bg-(--bgColor-neutral-muted) ${className ?? ''}`}
    >
      <span className={`h-full ${fill}`} style={{ width: `${pct}%` }} />
    </span>
  );
}
