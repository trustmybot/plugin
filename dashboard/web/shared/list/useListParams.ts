import { useMemo, useSyncExternalStore } from 'react';
import { currentHash, subscribeHash } from '../route.ts';

export function useListParams(): URLSearchParams {
  const hash = useSyncExternalStore(subscribeHash, currentHash, currentHash);
  return useMemo(() => new URLSearchParams(hash.split('?')[1] ?? ''), [hash]);
}
