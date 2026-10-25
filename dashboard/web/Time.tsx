import { RelativeTime } from './ui/RelativeTime.tsx';

export function Time({ value }: { value: unknown }) {
  return <RelativeTime value={value} />;
}
