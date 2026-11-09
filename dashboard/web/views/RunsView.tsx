import type { ReactNode } from 'react';
import { useApi, type GateBranch, type GateTask, type Gates, type Row } from '../api.ts';
import { DataTable, type Column } from '../DataTable.tsx';
import { Badge } from '../shared/Badge.tsx';
import {
  agentCell,
  badge,
  ENTITY_LINK,
  entityLink,
  exitBadge,
  hrefFor,
  RUN_COLUMNS,
  TASK_ID_COLUMN,
  TASK_TITLE_COLUMN,
  time,
} from '../shared/columns.tsx';
import { GATE_BOARD_HELP } from '../shared/help-copy.ts';
import { Loading } from '../shared/Loading.tsx';
import { HelpToggletip } from '../ui/HelpToggletip.tsx';

const mono = (key: string, length?: number) => (r: Row) => <span className="font-mono text-xs">{String(r[key] ?? '').slice(0, length)}</span>;

export const AGENT_RUN_COLUMNS: Column[] = [
  ...RUN_COLUMNS,
  { key: 'issue_id', header: 'Issue', cell: entityLink('issue', 'issue_id'), hideBelow: 'md' },
  { key: 'model', header: 'Model', hideBelow: 'md' },
  { key: 'tokens_out', header: 'Tokens Out', hideBelow: 'md' },
  { key: 'duration_ms', header: 'Duration', cell: (r) => `${Math.round(Number(r['duration_ms'] ?? 0) / 1000)}s`, hideBelow: 'sm' },
];

const VALIDATION_COLUMNS: Column[] = [
  { key: 'id', header: 'ID', cell: mono('id') },
  { ...TASK_ID_COLUMN, hideBelow: 'sm' },
  TASK_TITLE_COLUMN,
  { key: 'attempt_n', header: 'Attempt', hideBelow: 'sm' },
  { key: 'agent', header: 'Agent', cell: agentCell('agent'), hideBelow: 'md' },
  { key: 'verdict', header: 'Verdict', cell: badge('verdict') },
  { key: 'created_at', header: 'At', cell: time('created_at') },
];

const VERIFICATION_COLUMNS: Column[] = [
  { key: 'id', header: 'Run', hideBelow: 'sm' },
  TASK_ID_COLUMN,
  TASK_TITLE_COLUMN,
  { key: 'commit_sha', header: 'Commit', cell: mono('commit_sha', 8), hideBelow: 'sm' },
  { key: 'source', header: 'Source', hideBelow: 'md' },
  { key: 'exit_code', header: 'Result', cell: exitBadge },
  { key: 'failed_commands', header: 'Failed', cell: (r) => `${r['failed_commands']}/${r['commands']}`, hideBelow: 'sm' },
  { key: 'started_at', header: 'Started', cell: time('started_at') },
];

export function Subhead({ children }: { children: ReactNode }) {
  return <h2 className="mb-4 border-b border-(--borderColor-muted) pb-2 text-base font-semibold text-fg">{children}</h2>;
}

function verificationBadge(t: GateTask) {
  const v = t.verification;
  if (!v) return <Badge value="—" />;
  if (v.timed_out) return <Badge value="timed out" />;
  if (v.exit_code === null) return <Badge value="running" />;
  if (v.exit_code !== 0) return <Badge value="fail" />;
  return <Badge value={v.matches_commit ? 'pass' : 'stale'} />;
}

function GateTaskLine({ t }: { t: GateTask }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <a href={hrefFor('task', t.id)} className={ENTITY_LINK}>
        #{t.id} {t.title}
      </a>
      <Badge value={t.status} />
      <span className="text-fg-muted text-xs">verify</span>
      {verificationBadge(t)}
      <span className="text-fg-muted text-xs">review</span>
      <Badge value={t.verdict?.verdict ?? '—'} />
      {t.open_findings > 0 && <Badge value={`${t.open_findings} open finding${t.open_findings === 1 ? '' : 's'}`} />}
    </li>
  );
}

const GATE_BOARD_COLUMNS: Column[] = [
  { key: 'branch_id', header: 'Branch', cell: entityLink('branch', 'branch_id') },
  { key: 'state', header: 'State', cell: badge('state') },
  {
    key: 'task_text',
    header: 'Tasks',
    cell: (r) => (
      <ul className="space-y-1">
        {(r['tasks'] as GateTask[]).map((t) => (
          <GateTaskLine key={t.id} t={t} />
        ))}
      </ul>
    ),
  },
  { key: 'updated_at', header: 'Updated', cell: time('updated_at'), hideBelow: 'md' },
];

export const gateBoardRows = (board: GateBranch[]): Row[] =>
  board.map((b) => ({ ...b, task_text: b.tasks.map((t) => `#${t.id} ${t.title} ${t.status}`).join(' ') }));

export function GateBoard({ board }: { board: GateBranch[] }) {
  return <DataTable rows={gateBoardRows(board)} columns={GATE_BOARD_COLUMNS} />;
}

export function RunsView() {
  const runs = useApi<Row[]>('agent-runs');
  const gates = useApi<Gates>('gates');
  const board = useApi<GateBranch[]>('gate-board');
  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-start gap-2 [&>h2]:flex-1">
          <Subhead>Push Gate</Subhead>
          <HelpToggletip page="Push Gate" help={GATE_BOARD_HELP} />
        </div>
        <Loading q={board}>{(b) => <GateBoard board={b} />}</Loading>
      </section>
      <section>
        <Subhead>Agent Runs</Subhead>
        <Loading q={runs}>{(rows) => <DataTable rows={rows} columns={AGENT_RUN_COLUMNS} />}</Loading>
      </section>
      <Loading q={gates}>
        {(g) => (
          <>
            <section>
              <Subhead>Review Verdicts</Subhead>
              <DataTable rows={g.validations} columns={VALIDATION_COLUMNS} />
            </section>
            <section>
              <Subhead>Verification Runs</Subhead>
              <DataTable rows={g.verifications} columns={VERIFICATION_COLUMNS} />
            </section>
          </>
        )}
      </Loading>
    </div>
  );
}
