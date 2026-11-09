import { useEffect, useRef } from 'react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';

export type Row = Record<string, unknown>;

export interface Summary {
  issues: { open: number | null; closed: number | null };
  tasks_by_status: Array<{ status: string; count: number }>;
  open_runs: number;
  recent_runs: Row[];
}

export interface LabelTaxonomy {
  classification: string[];
  priority: string[];
  area: string[];
}

export interface IssueListing {
  issues: Row[];
  label_taxonomy: LabelTaxonomy;
}

export interface IssueDetail {
  issue: Row;
  discussions: Row[];
  tasks: Row[];
  label_taxonomy: LabelTaxonomy;
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

export interface GateTask {
  id: number;
  title: string;
  status: string;
  commit_sha: string | null;
  verification: { id: number; exit_code: number | null; timed_out: boolean; commit_sha: string | null; matches_commit: boolean } | null;
  verdict: { id: number; verdict: string; attempt_n: number } | null;
  open_findings: number;
}

export interface GateBranch {
  branch_id: string;
  state: 'ready' | 'blocked' | 'pending';
  updated_at: string;
  tasks: GateTask[];
}

export interface WmNode {
  repo: string;
  path: string;
  parent_path: string | null;
  summary: string | null;
  file_count: number;
  commits_behind?: number | null;
  dead_refs?: string[] | null;
}

export interface Freshness {
  indexed_commit: string | null;
  target_ref: string | null;
  target_commit: string | null;
  stale: boolean;
  reindex: {
    state: string;
    mode: string | null;
    trigger: string | null;
    started_at: string | null;
    finished_at: string | null;
    elapsed_ms: number | null;
    outcome: string | null;
  };
  needs_review_count: number;
}

export interface WmStatus {
  repos: Array<{ repo: string; freshness: Freshness | null }>;
  history: Row[];
}

export interface HealthContract {
  id: string;
  severity: 'error' | 'warn';
  description: string;
  ok: boolean | null;
  skipped: string | null;
  actual: number | null;
  expected: { op: string; value: number };
}

export interface Health {
  checked_at: string;
  healthy: boolean;
  schema: { version: number | null; target: number };
  contracts: HealthContract[];
  freshness: Array<{ repo: string; freshness: Freshness | null }>;
  concepts: { by_status: Record<string, number>; steps_by_trust: Record<string, number> };
  embeddings: Array<{ source: string; rows: number; embedded: number }>;
}

export interface WorldModel {
  available: boolean;
  repos: string[];
  nodes: WmNode[];
  freshness?: Freshness | null;
}

export type FileEdgeKind = 'calls' | 'imports' | 'runs' | 'sources' | 'instantiates';

export interface FileGraph {
  available: boolean;
  repo: string | null;
  repos: string[];
  files: Array<{ path: string; purpose: string }>;
  edges: Array<{ src: number; dst: number; kind: FileEdgeKind; weight: number }>;
  freshness?: Freshness | null;
}

export interface WorldModelSearch {
  available: boolean;
  hits: Row[];
  freshness?: Freshness | null;
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

const WM_STATUS = 'world-model/status';
const WM_STATUS_POLL_MS = 5000;

const isWorldModelKey = (key: readonly unknown[]) => typeof key[0] === 'string' && key[0].startsWith('world-model');

const reindexed = (key: readonly unknown[]) => isWorldModelKey(key) && key[0] !== WM_STATUS;

// The queries a data_version change refetches: everything but the two polls.
// While some repo reports freshness, world-model queries refetch only when an
// index lands; with no freshness anywhere they follow data_version.
export const liveRefreshes = (key: readonly unknown[], wmTracked: boolean) =>
  key[0] !== '__version' && key[0] !== WM_STATUS && !(wmTracked && reindexed(key));

export const tracksFreshness = (status: WmStatus | undefined) => status?.repos.some((r) => r.freshness !== null) ?? false;

export function useWmStatus() {
  return useQuery({
    queryKey: [WM_STATUS],
    queryFn: () => getJson<WmStatus>(WM_STATUS),
    refetchInterval: WM_STATUS_POLL_MS,
  });
}

export function useLiveRefresh(): void {
  const client = useQueryClient();
  const seen = useRef<number | null>(null);
  const indexed = useRef<Map<string, string | null> | null>(null);
  const { data } = useQuery({
    queryKey: ['__version'],
    queryFn: () => getJson<{ data_version: number }>('version'),
    refetchInterval: POLL_MS,
  });
  const status = useWmStatus().data;
  const wmTracked = useRef(false);
  wmTracked.current = tracksFreshness(status);
  useEffect(() => {
    if (!data) return;
    if (seen.current !== null && seen.current !== data.data_version) {
      void client.invalidateQueries({ predicate: (q) => liveRefreshes(q.queryKey, wmTracked.current) });
    }
    seen.current = data.data_version;
  }, [data, client]);
  useEffect(() => {
    if (!status) return;
    const next = new Map(status.repos.map((r) => [r.repo, r.freshness?.indexed_commit ?? null]));
    const prev = indexed.current;
    if (prev !== null && [...next].some(([repo, sha]) => prev.get(repo) !== sha)) {
      void client.invalidateQueries({ predicate: (q) => reindexed(q.queryKey) });
    }
    indexed.current = next;
  }, [status, client]);
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

export type EditableConfigKey = 'model_prices' | 'issue_area_labels' | 'issue_classification_labels' | 'issue_priority_labels';

export interface ConfigEntry {
  key: EditableConfigKey;
  value: unknown;
}

export interface EditableConfig {
  keys: ConfigEntry[];
}

export function useConfigWrite(key: EditableConfigKey) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { value: unknown; expected: unknown }) => postJson(`config/${key}`, body),
    onSettled: () => client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== '__version' }),
  });
}
