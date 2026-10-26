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

export type MapScope = 'files' | 'concepts';

export interface MapQuery {
  scope: MapScope;
  q: string;
  concept?: string;
}

export function mapHash({ scope = 'files', q = '', concept }: Partial<MapQuery>): string {
  const params = new URLSearchParams();
  if (scope === 'concepts') params.set('scope', 'concepts');
  if (q) params.set('q', q);
  if (scope === 'concepts' && concept) params.set('concept', concept);
  const search = params.toString();
  return `#/map${search ? `?${search}` : ''}`;
}

export function parseMapQuery(search: string): MapQuery {
  const params = new URLSearchParams(search);
  const scope: MapScope = params.get('scope') === 'concepts' ? 'concepts' : 'files';
  const concept = scope === 'concepts' ? params.get('concept') : null;
  return { scope, q: params.get('q') ?? '', ...(concept ? { concept } : {}) };
}

export function legacyConceptsHash(hash: string): string | null {
  const match = new RegExp('^#/concepts(?:/([^?]*))?(?:\\?(.*))?$').exec(hash);
  if (!match) return null;
  const [, id, search = ''] = match;
  return mapHash({ scope: 'concepts', q: new URLSearchParams(search).get('q') ?? '', ...(id ? { concept: id } : {}) });
}

export const mapSearch = () => currentHash().split('?')[1] ?? '';
