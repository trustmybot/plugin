// Settings tab: edit model prices and the three issue label taxonomies; policy keys stay with /onboard.
import { PlusIcon, TrashIcon } from '@primer/octicons-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useApi, useConfigWrite, type ConfigEntry, type EditableConfig } from '../../api.ts';
import { FIELD } from '../../shared/classes.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { Button } from '../../ui/Button.tsx';
import { Flash } from '../../ui/Flash.tsx';
import {
  CONFIG_COPY,
  PRICE_FIELDS,
  PRICE_LABEL,
  emptyPriceRow,
  labelRows,
  labelsValue,
  priceRows,
  pricesValue,
  saveProblem,
  type PriceRow,
} from './settings.ts';

export function SettingsView() {
  const config = useApi<EditableConfig>('config');
  return (
    <div className="min-w-0 space-y-6">
      <p className="text-sm text-fg-muted">
        These settings are stored in this project&apos;s TMB database. Policy settings, such as the branching model or sandboxing, change only
        through <code className="font-mono">/onboard</code>.
      </p>
      <Loading q={config}>{(c) => c.keys.map((entry) => <ConfigSection key={entry.key} entry={entry} />)}</Loading>
    </div>
  );
}

type Save = (value: unknown) => void;

export function ConfigSection({ entry }: { entry: ConfigEntry }) {
  const [base, setBase] = useState<unknown>(() => entry.value);
  const [generation, setGeneration] = useState(0);
  const write = useConfigWrite(entry.key);
  const { title, description } = CONFIG_COPY[entry.key];
  const reload = (current: unknown) => {
    setBase(current);
    setGeneration((g) => g + 1);
    write.reset();
  };
  const save: Save = (value) => write.mutate({ value, expected: base }, { onSuccess: (res) => setBase(res['value'] ?? value) });
  const status = <SaveStatus error={write.error} saved={write.isSuccess} onReload={reload} />;
  return (
    <Box data-config-key={entry.key}>
      <BoxHeader>
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <p className="text-xs text-fg-muted">
          {description} <code className="font-mono">{entry.key}</code>
          {entry.value === null && ' is not set.'}
        </p>
      </BoxHeader>
      <BoxRow>
        {entry.key === 'model_prices' ? (
          <PricesEditor key={generation} initial={base} pending={write.isPending} onSave={save} status={status} />
        ) : (
          <LabelsEditor key={generation} label={title} initial={base} pending={write.isPending} onSave={save} status={status} />
        )}
      </BoxRow>
    </Box>
  );
}

export function SaveStatus({ error, saved, onReload }: { error: Error | null; saved: boolean; onReload: (current: unknown) => void }) {
  const problem = saveProblem(error);
  if (problem?.kind === 'stale') {
    return (
      <div role="status">
        <Flash variant="warning">
          <div className="flex flex-wrap items-center gap-2">
            <span>This setting changed since you loaded it, so your edit was not saved. Reload to see the latest value, then edit again.</span>
            <Button size="small" onClick={() => onReload(problem.current)}>Reload</Button>
          </div>
        </Flash>
      </div>
    );
  }
  if (problem?.kind === 'invalid') {
    return (
      <Flash variant="danger">
        {problem.message}
        {problem.field && <span className="text-fg-muted"> (field <code className="font-mono">{problem.field}</code>)</span>}
      </Flash>
    );
  }
  if (problem?.kind === 'error') return <Flash variant="danger">{problem.message}</Flash>;
  if (saved) return <div role="status"><Flash variant="success">Saved.</Flash></div>;
  return null;
}

interface EditorProps {
  initial: unknown;
  pending: boolean;
  onSave: Save;
  status: ReactNode;
}

const submit = (fn: () => void) => (e: FormEvent) => {
  e.preventDefault();
  fn();
};

function PricesEditor({ initial, pending, onSave, status }: EditorProps) {
  const [rows, setRows] = useState<PriceRow[]>(() => priceRows(initial));
  const [draftError, setDraftError] = useState<string | null>(null);
  const update = (i: number, patch: Partial<PriceRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = () => {
    const next = pricesValue(rows);
    setDraftError('error' in next ? next.error : null);
    if ('value' in next) onSave(next.value);
  };
  return (
    <form className="space-y-3" onSubmit={submit(save)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-fg-muted">
            <tr>
              <th className="py-1 pr-2 font-semibold">Model</th>
              {PRICE_FIELDS.map((f) => <th key={f} className="py-1 pr-2 font-semibold">{PRICE_LABEL[f]}</th>)}
              <th><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} data-price-row={i}>
                <td className="py-1 pr-2">
                  <input className={`${FIELD} min-w-48 font-mono`} aria-label={`Model id, row ${i + 1}`} value={row.model} onChange={(e) => update(i, { model: e.target.value })} />
                </td>
                {PRICE_FIELDS.map((f) => (
                  <td key={f} className="py-1 pr-2">
                    <input
                      className={`${FIELD} min-w-24`}
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      aria-label={`${PRICE_LABEL[f]} price, row ${i + 1}`}
                      value={row[f]}
                      onChange={(e) => update(i, { [f]: e.target.value })}
                    />
                  </td>
                ))}
                <td className="py-1">
                  <Button size="small" variant="invisible" aria-label={`Remove row ${i + 1}`} leadingVisual={TrashIcon} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-2 text-sm text-fg-muted">No model has a price yet.</p>}
      </div>
      {draftError && <Flash variant="danger">{draftError}</Flash>}
      {status}
      <div className="flex gap-2">
        <Button size="small" leadingVisual={PlusIcon} onClick={() => setRows((rs) => [...rs, emptyPriceRow()])}>Add Model</Button>
        <Button type="submit" variant="primary" size="small" disabled={pending}>Save</Button>
      </div>
    </form>
  );
}

function LabelsEditor({ label, initial, pending, onSave, status }: EditorProps & { label: string }) {
  const [rows, setRows] = useState<string[]>(() => labelRows(initial));
  const update = (i: number, text: string) => setRows((rs) => rs.map((r, j) => (j === i ? text : r)));
  return (
    <form className="space-y-3" onSubmit={submit(() => onSave(labelsValue(rows)))}>
      <ol className="space-y-1">
        {rows.map((row, i) => (
          <li key={i} data-label-row={i} className="flex items-center gap-2">
            <input className={`${FIELD} max-w-md`} aria-label={`${label}, item ${i + 1}`} value={row} onChange={(e) => update(i, e.target.value)} />
            <Button size="small" variant="invisible" aria-label={`Remove item ${i + 1}`} leadingVisual={TrashIcon} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
          </li>
        ))}
      </ol>
      {rows.length === 0 && <p className="text-sm text-fg-muted">No labels yet.</p>}
      {status}
      <div className="flex gap-2">
        <Button size="small" leadingVisual={PlusIcon} onClick={() => setRows((rs) => [...rs, ''])}>Add Label</Button>
        <Button type="submit" variant="primary" size="small" disabled={pending}>Save</Button>
      </div>
    </form>
  );
}
