import { useEffect, useRef } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

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
  label_taxonomy: { classification: string[] | null; priority: string[] | null };
  milestones: string[];
}

export interface CompletionCriterion {
  id: string;
  status: string;
  evidence_cmd?: string;
  note?: string;
}

export interface CompletionReport {
  criteria?: CompletionCriterion[];
  extras?: Array<{ path: string; reason: string }>;
  findings_fixed?: string[];
}

export interface VerificationCommand {
  ordinal: number;
  command: string;
  exit_code: number | null;
  elapsed_s: number | null;
  output_tail: string | null;
}

export interface TaskDetail {
  task: Row & {
    files: unknown;
    verification: unknown;
    completion_report: CompletionReport | null;
    files_raw?: string;
    verification_raw?: string;
    completion_report_raw?: string;
  };
  issue: { id: number; objective: string } | null;
  validations: Row[];
  findings: Row[];
  verifications: Array<Row & { commands: VerificationCommand[] }>;
  agent_runs: Row[];
}

export interface Gates {
  validations: Row[];
  verifications: Row[];
}

export interface WmNode {
  repo: string;
  path: string;
  parent_path: string | null;
  summary: string | null;
  file_count: number;
}

export interface WorldModel {
  available: boolean;
  repos: string[];
  nodes: WmNode[];
}

export type FileEdgeKind = 'calls' | 'imports' | 'runs' | 'sources' | 'instantiates';

export interface FileGraph {
  available: boolean;
  repo: string | null;
  repos: string[];
  files: Array<{ path: string; purpose: string }>;
  edges: Array<{ src: number; dst: number; kind: FileEdgeKind; weight: number }>;
}

export interface WorldModelSearch {
  available: boolean;
  hits: Row[];
}

export type Trust = 'verified' | 'suspect' | 'broken';

export interface ConceptHit {
  id: number;
  name: string;
  body: string;
  step_count: number;
  trust: Record<Trust, number>;
}

export interface StepSymbol {
  id: number | null;
  repo: string;
  path: string;
  kind: string;
  qualified_name: string;
  line_start: number | null;
}

export interface ConceptStep {
  ordinal: number;
  description: string;
  trust: Trust | null;
  trust_reason: string | null;
  handoff: string | null;
  symbol: StepSymbol | null;
}

export interface ConceptSearch {
  available: boolean;
  repos: string[];
  concepts: ConceptHit[];
  derived: { label: string; steps: ConceptStep[] } | null;
}

export interface ConceptDetail {
  available?: boolean;
  id: number;
  name: string;
  body: string;
  status: string;
  status_reason: string | null;
  steps: ConceptStep[];
  steps_truncated?: boolean;
}

export type NodeId = number | string;

export interface GraphNode {
  id: NodeId;
  label: string;
  repo: string;
  path: string;
  dir: string;
  kind: string;
  line_start: number | null;
  step_ordinal: number | null;
}

export interface GraphEdge {
  src: NodeId;
  dst: NodeId;
  kind: string;
}

export interface ConceptGraph {
  available?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

const POLL_MS = 2000;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function useApi<T>(path: string, opts: { keepPrevious?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [path],
    queryFn: () => getJson<T>(path),
    enabled: opts.enabled ?? true,
    ...(opts.keepPrevious ? { placeholderData: keepPreviousData } : {}),
  });
}

export function useApis<T>(paths: string[]) {
  return useQueries({ queries: paths.map((path) => ({ queryKey: [path], queryFn: () => getJson<T>(path) })) });
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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Row,
  ) {
    super(typeof body['message'] === 'string' ? body['message'] : String(body['error'] ?? `HTTP ${status}`));
  }
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="tmb-token"]')?.content ?? '';

async function postJson(path: string, body: Row): Promise<Row> {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tmb-token': token() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Row;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export type IssueAction = 'edit' | 'comment' | 'close';

export function useIssueWrite(id: string, action: IssueAction) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Row) => postJson(`issues/${id}/${action}`, body),
    onSettled: () => client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== '__version' }),
  });
}
