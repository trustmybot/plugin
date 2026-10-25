import { useMemo, useState, type ReactNode } from 'react';
import { useApi, useApis, type ConceptDetail, type ConceptGraph, type ConceptStep, type GraphNode, type NodeId, type Trust } from '../../api.ts';
import { Markdown } from '../../Markdown.tsx';
import { Badge } from '../../shared/Badge.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { CopyButton } from '../../ui/CopyButton.tsx';
import { Flash } from '../../ui/Flash.tsx';
import { DerivedBadge, TrustBadge } from './badges.tsx';
import { CONCEPT_COPY, MUTED, TARGET, TRUST_LABEL } from './copy.ts';
import { GraphPanel } from './GraphPanel.tsx';
import { derivedGraph, headerTrust, isFileAnchor, mergeGraphs, stepLocation, stepNodeId } from './layout.ts';

export function SavedPanel({ id }: { id: string }) {
  const detail = useApi<ConceptDetail>(`concepts/${id}`);
  const graph = useApi<ConceptGraph>(`concepts/${id}/graph`);
  if (detail.error) return <Flash variant="danger">{detail.error.message}</Flash>;
  if (!detail.data) return <p role="status" className={MUTED}>Loading…</p>;
  const d = detail.data;
  return (
    <StepsAndGraph
      key={id}
      title={d.name}
      subtitle={d.body}
      badge={d.status in TRUST_LABEL ? <TrustBadge trust={headerTrust(d.status as Trust, d.steps)} /> : <Badge value={d.status} />}
      note={d.status_reason}
      steps={d.steps}
      graph={graph.data}
      graphError={graph.error}
    />
  );
}

export function DerivedPanel({ steps }: { steps: ConceptStep[] }) {
  const graph = useMemo(() => derivedGraph(steps), [steps]);
  return (
    <StepsAndGraph
      key={steps.map((s) => s.symbol?.id).join(',')}
      title={steps[0]?.symbol?.qualified_name ?? 'Call chain'}
      subtitle=""
      badge={<DerivedBadge />}
      note={null}
      steps={steps}
      graph={graph}
      graphError={null}
    />
  );
}

function StepsAndGraph({
  title,
  subtitle,
  badge,
  note,
  steps,
  graph,
  graphError,
}: {
  title: string;
  subtitle: string;
  badge: ReactNode;
  note: string | null;
  steps: ConceptStep[];
  graph: ConceptGraph | undefined;
  graphError: Error | null;
}) {
  const [step, setStep] = useState<number | null>(null);
  const [picked, setPicked] = useState<NodeId | null>(null);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [showGraph, setShowGraph] = useState(false);
  const extra = useApis<ConceptGraph>(expanded.map((sid) => `symbols/${sid}/neighbourhood`));
  const extraKey = extra.map((r) => r.dataUpdatedAt).join(',');
  const merged = useMemo(() => (graph ? mergeGraphs(graph, extra.map((r) => r.data)) : undefined), [graph, extraKey]);
  const stepNode = (ordinal: number | null): NodeId | null => {
    const s = steps.find((x) => x.ordinal === ordinal);
    return s?.symbol ? stepNodeId(s.symbol) : null;
  };
  const selected = picked ?? stepNode(step);
  const selectStep = (ordinal: number) => {
    setStep(ordinal);
    setPicked(null);
  };
  const onNode = (n: GraphNode) => {
    if (n.step_ordinal !== null) selectStep(n.step_ordinal);
    else {
      setStep(null);
      setPicked(n.id);
    }
  };
  const pickedNode = picked === null ? null : merged?.nodes.find((n) => n.id === picked) ?? null;

  return (
    <>
      <Box aria-label="Steps" role="region" className="min-w-0 self-start">
        <BoxHeader className="space-y-1">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold break-all text-fg">{title} {badge}</h2>
          {subtitle ? <Markdown className={`text-sm ${MUTED}`}>{subtitle}</Markdown> : null}
          {note ? <p className={`text-xs ${MUTED}`}>{note}</p> : null}
        </BoxHeader>
        <ol>
          {steps.map((s, i) => {
            const location = stepLocation(s);
            const name = s.symbol ? (isFileAnchor(s.symbol) ? s.symbol.path : s.symbol.qualified_name) : 'Anchor gone';
            const active = step === s.ordinal;
            return (
              <li key={s.ordinal}>
                <BoxRow
                  className={`border-l-2 px-0 py-0 ${active ? 'border-l-(--borderColor-accent-emphasis) bg-(--bgColor-accent-muted)' : 'border-l-transparent hover:bg-canvas-muted'}`}
                >
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => selectStep(s.ordinal)}
                    className="block w-full cursor-pointer px-3 pt-2 pb-1 text-left text-sm focus-visible:outline-(length:--focus-outline-width) focus-visible:-outline-offset-2 focus-visible:outline-(--focus-outline-color)"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={`font-mono text-xs ${MUTED}`}>{s.ordinal}</span>
                      <span className="font-mono font-semibold break-all text-fg">{name}</span>
                      {s.trust && <TrustBadge trust={s.trust} />}
                    </span>
                    <Markdown inline className="block">{s.description}</Markdown>
                    {s.trust_reason && <span className={`block text-xs ${MUTED}`}>{s.trust_reason}</span>}
                  </button>
                  {location && (
                    <div className="flex items-center gap-1 px-3 pb-2">
                      <span className={`min-w-0 font-mono text-xs break-all ${MUTED}`}>{location}</span>
                      <CopyButton value={location} label={`Copy ${location}`} />
                    </div>
                  )}
                </BoxRow>
                {i < steps.length - 1 && (
                  <span className={`block border-t border-(--borderColor-muted) bg-canvas-muted px-3 py-0.5 text-xs ${MUTED}`}>
                    <span aria-hidden="true">↓ </span>
                    {s.handoff ?? 'then'}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </Box>
      <section aria-label="Graph" className="min-w-0 space-y-2">
        <button type="button" className={`${TARGET} lg:hidden`} aria-expanded={showGraph} onClick={() => setShowGraph(!showGraph)}>
          {CONCEPT_COPY.showGraph}
        </button>
        <div className={`${showGraph ? 'block' : 'hidden'} lg:block`}>
          {graphError ? (
            <Flash variant="danger">{graphError.message}</Flash>
          ) : !merged ? (
            <p role="status" className={MUTED}>Loading…</p>
          ) : (
            <GraphPanel
              graph={merged}
              selected={selected}
              picked={pickedNode}
              canExpand={pickedNode !== null && typeof pickedNode.id === 'number' && !expanded.includes(pickedNode.id)}
              onExpand={() => typeof picked === 'number' && setExpanded([...expanded, picked])}
              onNode={onNode}
            />
          )}
        </div>
      </section>
    </>
  );
}
