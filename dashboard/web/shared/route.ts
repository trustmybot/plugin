import { useSyncExternalStore } from 'react';

export const go = (path: string) => {
  window.location.hash = `/${path}`;
};

export const currentHash = () => (typeof window === 'undefined' ? '' : window.location.hash);
export const hashParams = () => new URLSearchParams(currentHash().split('?')[1] ?? '');
export const routeQuery = () => hashParams().get('q') ?? '';
export const hashPath = () => currentHash().replace(/^#\/?/, '').split('?')[0]!;

export type ParamOverrides = Record<string, string | null | undefined>;

export function hrefWith(params: ParamOverrides, path: string = hashPath()): string {
  const next = hashParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return `#/${path}${query ? `?${query}` : ''}`;
}

export const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export function useHashParam(key: string): string | null {
  return useSyncExternalStore(subscribeHash, () => hashParams().get(key), () => null);
}
