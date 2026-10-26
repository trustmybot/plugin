import type { ReactNode } from 'react';
import type { CompletionReport, Row, TaskDetail } from '../../api.ts';
import { DataTable, type Column } from '../../DataTable.tsx';
import { Markdown } from '../../Markdown.tsx';
import { Badge } from '../../shared/Badge.tsx';
import { exitBadge, time } from '../../shared/columns.tsx';
import { criterionVariant, findingVariant, statusText, verdictVariant } from '../../shared/verdict.ts';
import { Box, BoxRow } from '../../ui/Box.tsx';
import { CodeBlock } from '../../ui/CodeBlock.tsx';
import { Disclosure } from '../../ui/Disclosure.tsx';
import { Label } from '../../ui/Label.tsx';
import { RelativeTime } from '../../ui/RelativeTime.tsx';
import { Muted, Section } from './Section.tsx';

const OUTPUT_LINES = 20;
const SHA_LENGTH = 7;
const NUMBER = new Intl.NumberFormat();

const InlineCode = ({ children }: { children: ReactNode }) => (
  <code className="rounded-md bg-(--bgColor-muted) px-[.4em] py-[.2em] font-mono text-xs break-all">{children}</code>
);

const Meta = ({ children }: { children: ReactNode }) => <span className="text-xs text-fg-muted">{children}</span>;

export function SpecSection({ body }: { body: unknown }) {
  const text = typeof body === 'string' ? body.trim() : '';
  return <Section title="Spec">{text ? <Markdown>{text}</Markdown> : <Muted>No spec written.</Muted>}</Section>;
}

export function CriteriaSection({ report, raw }: { report: CompletionReport | null; raw?: string }) {
  const criteria = report?.criteria ?? [];
  const extras = report?.extras ?? [];
  const fixed = report?.findings_fixed ?? [];
  let body: ReactNode;
  if (raw !== undefined) body = <CodeBlock text={raw} label="Completion report (unparsed)" maxLines={OUTPUT_LINES} />;
  else if (!report) body = <Muted>No completion report yet.</Muted>;
  else
    body = (
      <>
        {criteria.length ? (
          <Box>
            {criteria.map((c, i) => (
              <BoxRow key={`${c.id}-${i}`} className="flex flex-wrap items-start gap-2 text-sm">
                <span className="font-mono font-semibold text-fg">{c.id}</span>
                <Label variant={criterionVariant(c.status)}>{statusText(c.status)}</Label>
                <span className="min-w-0 flex-1 break-words text-fg">
                  {c.note && <span className="block">{c.note}</span>}
                  {c.evidence_cmd && <InlineCode>{c.evidence_cmd}</InlineCode>}
                </span>
              </BoxRow>
            ))}
          </Box>
        ) : (
          <Muted>The report lists no criteria.</Muted>
        )}
        {extras.length > 0 && (
          <div className="space-y-1 text-sm">
            <h4 className="font-semibold text-fg">Extras</h4>
            <ul className="space-y-1">
              {extras.map((e, i) => (
                <li key={i} className="break-words">
                  <InlineCode>{e.path}</InlineCode> <span className="text-fg-muted">{e.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {fixed.length > 0 && (
          <p className="text-sm">
            <span className="font-semibold text-fg">Findings fixed:</span>{' '}
            {fixed.map((f, i) => (
              <span key={f}>
                {i > 0 && ', '}
                <InlineCode>{f}</InlineCode>
              </span>
            ))}
          </p>
        )}
      </>
    );
  return <Section title="Success criteria">{body}</Section>;
}

function Finding({ f }: { f: Row }) {
  const id = String(f['id']);
  return (
    <BoxRow className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold text-fg">{id}</span>
        {f['criterion_id'] ? <Meta>criterion {String(f['criterion_id'])}</Meta> : null}
        <Label variant={findingVariant(f['status'])}>{statusText(f['status'])}</Label>
        <Meta>
          attempt {String(f['attempt_n'])} · <RelativeTime value={f['created_at']} />
        </Meta>
      </div>
      <div className="grid gap-2">
        <Meta>Probe</Meta>
        <CodeBlock text={String(f['probe_cmd'] ?? '')} label={`${id} probe`} maxLines={8} />
        <Meta>Expected</Meta>
        <CodeBlock text={String(f['expected'] ?? '')} label={`${id} expected`} maxLines={8} />
        <Meta>Observed</Meta>
        <CodeBlock text={String(f['observed'] ?? '')} label={`${id} observed`} maxLines={8} />
      </div>
    </BoxRow>
  );
}

export function ReviewsSection({ validations, findings }: { validations: Row[]; findings: Row[] }) {
  return (
    <Section title="Reviews">
      {validations.length ? (
        <Box>
          {validations.map((v) => (
            <BoxRow key={String(v['id'])} className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-fg">Attempt {String(v['attempt_n'])}</span>
                <Label variant={verdictVariant(v['verdict'])}>{statusText(v['verdict'])}</Label>
                <Meta>
                  {v['agent'] ? `${String(v['agent'])} · ` : ''}
                  <RelativeTime value={v['created_at']} />
                </Meta>
              </div>
              {String(v['feedback'] ?? '').trim() ? <Markdown>{String(v['feedback'])}</Markdown> : <Muted>No feedback.</Muted>}
            </BoxRow>
          ))}
        </Box>
      ) : (
        <Muted>No review verdicts yet.</Muted>
      )}
      <h4 className="text-sm font-semibold text-fg">Findings</h4>
      {findings.length ? (
        <Box>
          {findings.map((f) => (
            <Finding key={String(f['id'])} f={f} />
          ))}
        </Box>
      ) : (
        <Muted>No review findings.</Muted>
      )}
    </Section>
  );
}

const exitText = (code: unknown) => (code === null || code === undefined ? 'running' : `exit ${String(code)}`);

export function VerificationSection({ runs }: { runs: TaskDetail['verifications'] }) {
  return (
    <Section title="Verification runs">
      {runs.length ? (
        <div className="space-y-2">
          {runs.map((r, i) => (
            <Disclosure
              key={String(r['id'])}
              defaultOpen={i === 0}
              summary={
                <>
                  {exitBadge(r)}
                  <span className="font-mono text-xs text-fg">{exitText(r['exit_code'])}</span>
                  {r['timed_out'] ? <Label variant="severe">timed out</Label> : null}
                  <InlineCode>{String(r['commit_sha'] ?? '').slice(0, SHA_LENGTH)}</InlineCode>
                  <Meta>{String(r['source'] ?? '')}</Meta>
                  <Meta>
                    <RelativeTime value={r['started_at']} />
                  </Meta>
                </>
              }
            >
              {r.commands.length ? (
                <ol className="space-y-3">
                  {r.commands.map((c) => (
                    <li key={c.ordinal} className="space-y-1.5 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-fg-muted">{c.ordinal}.</span>
                        <InlineCode>{c.command}</InlineCode>
                        <Label variant={c.exit_code === null ? 'attention' : c.exit_code === 0 ? 'success' : 'danger'}>{exitText(c.exit_code)}</Label>
                        {c.elapsed_s !== null && <Meta>{c.elapsed_s.toFixed(1)}s</Meta>}
                      </div>
                      {c.output_tail ? (
                        <CodeBlock text={c.output_tail} label={`Output of command ${c.ordinal}`} maxLines={OUTPUT_LINES} />
                      ) : (
                        <Muted>No output captured.</Muted>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <Muted>No commands recorded for this run.</Muted>
              )}
            </Disclosure>
          ))}
        </div>
      ) : (
        <Muted>No verification runs yet.</Muted>
      )}
    </Section>
  );
}

const count = (key: string) => (r: Row) => (r[key] === null || r[key] === undefined ? <span className="text-fg-muted">—</span> : NUMBER.format(Number(r[key])));

const AGENT_RUN_COLUMNS: Column[] = [
  { key: 'id', header: 'Run', hideBelow: 'sm' },
  { key: 'agent_type', header: 'Agent' },
  { key: 'model', header: 'Model', hideBelow: 'md' },
  { key: 'effort', header: 'Effort', hideBelow: 'md' },
  { key: 'tokens_in', header: 'Tokens in', cell: count('tokens_in') },
  { key: 'tokens_out', header: 'Tokens out', cell: count('tokens_out') },
  { key: 'cache_read_tokens', header: 'Cache read', cell: count('cache_read_tokens'), hideBelow: 'sm' },
  { key: 'cache_creation_tokens', header: 'Cache write', cell: count('cache_creation_tokens'), hideBelow: 'sm' },
  { key: 'duration_ms', header: 'Duration', cell: (r) => `${Math.round(Number(r['duration_ms'] ?? 0) / 1000)}s`, hideBelow: 'sm' },
  { key: 'started_at', header: 'Started', cell: time('started_at'), hideBelow: 'md' },
  { key: 'exit_reason', header: 'Exit', cell: (r) => <Badge value={r['completed_at'] ? r['exit_reason'] ?? 'completed' : 'running'} /> },
];

export function AgentRunsSection({ runs }: { runs: Row[] }) {
  return (
    <Section title="Agent runs">
      {runs.length ? <DataTable rows={runs} columns={AGENT_RUN_COLUMNS} filter={false} /> : <Muted>No agent runs recorded.</Muted>}
    </Section>
  );
}
