import { AlertIcon, CheckIcon, SkipIcon, StopIcon, type Icon } from '@primer/octicons-react';
import { useApi, type Health, type HealthContract } from '../../api.ts';
import { Badge } from '../../shared/Badge.tsx';
import { HEALTH_HELP } from '../../shared/help-copy.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Box, BoxRow } from '../../ui/Box.tsx';
import { FreshnessBadge, freshnessState } from '../../ui/FreshnessBadge.tsx';
import { HelpToggletip } from '../../ui/HelpToggletip.tsx';
import { labelClass, LABEL_ICON, type LabelVariant } from '../../ui/Label.tsx';

type Look = { text: string; icon: Icon; variant: LabelVariant };

const PASS: Look = { text: 'Passing', icon: CheckIcon, variant: 'success' };
const CURRENT: Look = { text: 'Current', icon: CheckIcon, variant: 'success' };
const MISMATCH: Look = { text: 'Mismatch', icon: AlertIcon, variant: 'attention' };
const SKIP: Look = { text: 'Skipped', icon: SkipIcon, variant: 'secondary' };
const FAIL: Record<HealthContract['severity'], Look> = {
  error: { text: 'Critical', icon: StopIcon, variant: 'danger' },
  warn: { text: 'Warning', icon: AlertIcon, variant: 'attention' },
};

export const contractLook = (c: HealthContract): Look => (c.ok === false ? FAIL[c.severity] : c.ok === null ? SKIP : PASS);

function StatusLabel({ look, title }: { look: Look; title?: string }) {
  const { text, icon: LookIcon, variant } = look;
  return (
    <span className={labelClass(variant)} title={title}>
      <LookIcon size={LABEL_ICON} aria-hidden="true" />
      {text}
    </span>
  );
}

const failingFirst = (contracts: HealthContract[]) => {
  const rank = (c: HealthContract) => (c.ok === false ? (c.severity === 'error' ? 0 : 1) : c.ok === null ? 2 : 3);
  return [...contracts].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
};

function Contracts({ contracts }: { contracts: HealthContract[] }) {
  const shown = failingFirst(contracts).filter((c) => c.ok !== true);
  const passing = contracts.length - shown.length;
  return (
    <BoxRow className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">Data Contracts</h3>
      <p className="text-xs text-fg-muted">
        {passing} of {contracts.length} passing
      </p>
      {shown.length > 0 && (
        <ul className="space-y-1.5">
          {shown.map((c) => (
            <li key={c.id} data-contract={c.id} className="flex items-start gap-2 text-sm">
              <StatusLabel look={contractLook(c)} title={c.skipped ?? undefined} />
              <span className="min-w-0">
                <code className="break-all font-mono text-xs text-fg">{c.id}</code>
                <span className="block text-xs text-fg-muted">
                  {c.ok === false ? `${c.description} (got ${c.actual ?? 'null'}, expected ${c.expected.op} ${c.expected.value})` : c.skipped}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </BoxRow>
  );
}

function Freshness({ repos }: { repos: Health['freshness'] }) {
  return (
    <BoxRow className="space-y-2">
      <h3 className="text-sm font-semibold text-fg">Project Map Freshness</h3>
      {repos.length === 0 ? (
        <p className="text-xs text-fg-muted">No project map yet; run /scan.</p>
      ) : (
        <ul className="space-y-1.5">
          {repos.map(({ repo, freshness }) => (
            <li key={repo} data-repo={repo} className="flex items-center gap-2 text-sm">
              <span className="font-semibold text-fg">{repo}</span>
              {freshness === null ? (
                <span className="text-xs text-fg-muted">no freshness record</span>
              ) : freshnessState(freshness) === null ? (
                <StatusLabel look={CURRENT} />
              ) : (
                <FreshnessBadge block={freshness} />
              )}
            </li>
          ))}
        </ul>
      )}
    </BoxRow>
  );
}

function Counts({ heading, counts }: { heading: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold text-fg-muted">{heading}</h4>
      {entries.length === 0 ? (
        <p className="text-xs text-fg-muted">None</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {entries.map(([status, n]) => (
            <li key={status} className="flex items-center gap-1 text-sm">
              <Badge value={status} />
              <span className="text-fg">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HealthPanel({ health }: { health: Health }) {
  const { version, target } = health.schema;
  return (
    <Box className="min-w-0">
      <BoxRow className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-fg">Schema</h3>
        <span className="text-sm text-fg">
          v{version ?? '?'} (target v{target})
        </span>
        <StatusLabel look={version === target ? CURRENT : MISMATCH} />
      </BoxRow>
      <Contracts contracts={health.contracts} />
      <Freshness repos={health.freshness} />
      <BoxRow className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">Concept Trust</h3>
        <Counts heading="Concepts" counts={health.concepts.by_status} />
        <Counts heading="Steps" counts={health.concepts.steps_by_trust} />
      </BoxRow>
      <BoxRow className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">Search Vectors</h3>
        <ul className="space-y-1 text-sm">
          {health.embeddings.map((e) => (
            <li key={e.source} data-embeddings={e.source} className="text-fg">
              <code className="font-mono text-xs">{e.source}</code>: {e.embedded} of {e.rows} rows embedded
            </li>
          ))}
        </ul>
      </BoxRow>
    </Box>
  );
}

export function HealthSection() {
  const q = useApi<Health>('health');
  return (
    <section aria-labelledby="health-heading" className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-(--borderColor-muted) pb-2">
        <h2 id="health-heading" className="text-xl font-normal text-fg">
          Health
        </h2>
        <HelpToggletip page="Health" help={HEALTH_HELP} />
      </div>
      <Loading q={q}>{(h) => <HealthPanel health={h} />}</Loading>
    </section>
  );
}
