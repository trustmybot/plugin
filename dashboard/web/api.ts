import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type Row = Record<string, unknown>;

export interface Summary {
  issues: { open: number | null; closed: number | null };
  tasks_by_status: Array<{ status: string; count: number }>;
  open_runs: number;
  recent_runs: Row[];
}

export interface IssueDetail {
  issue: Row;
  discussions: Row[];
  tasks: Row[];
}

export interface Gates {
  validations: Row[];
  verifications: Row[];
}

const POLL_MS = 2000;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function useApi<T>(path: string) {
  return useQuery({ queryKey: [path], queryFn: () => getJson<T>(path) });
}

export function useLiveRefresh(): void {
  const client = useQueryClient();
  const seen = useRef<number | null>(null);
  const { data } = useQuery({
    queryKey: ['__version'],
    queryFn: () => getJson<{ data_version: number }>('version'),
    refetchInterval: POLL_MS,
  });
  useEffect(() => {
    if (!data) return;
    if (seen.current !== null && seen.current !== data.data_version) {
      void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== '__version' });
    }
    seen.current = data.data_version;
  }, [data, client]);
}
