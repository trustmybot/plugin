import { useSyncExternalStore } from 'react';

export const go = (path: string) => {
  window.location.hash = `/${path}`;
};

export const hashParams = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');
export const routeQuery = () => hashParams().get('q') ?? '';
export const hashPath = () => window.location.hash.replace(/^#\/?/, '').split('?')[0]!;

const subscribeHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

export function useHashParam(key: string): string | null {
  return useSyncExternalStore(subscribeHash, () => hashParams().get(key), () => null);
}
