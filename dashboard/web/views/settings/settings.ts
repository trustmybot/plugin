// Settings tab helpers: drafts for the editable config keys, the values they send and how a failed save reads.
import { ApiError, type EditableConfigKey } from '../../api.ts';

export const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_creation'] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];

export const PRICE_LABEL: Record<PriceField, string> = {
  input: 'Input',
  output: 'Output',
  cache_read: 'Cache Read',
  cache_creation: 'Cache Write',
};

export const CONFIG_COPY: Record<EditableConfigKey, { title: string; description: string }> = {
  model_prices: {
    title: 'Model Prices',
    description: 'USD per 1M tokens for each model id, used for the cost figures on Insights. A model without a row is unpriced.',
  },
  issue_classification_labels: {
    title: 'Classification Labels',
    description: 'The labels that say what kind of work an issue is. Every issue carries exactly one.',
  },
  issue_priority_labels: {
    title: 'Priority Labels',
    description: 'The priority labels, most urgent first. Every issue carries exactly one.',
  },
  issue_area_labels: {
    title: 'Area Labels',
    description: 'The labels that say which part of the project an issue touches.',
  },
};

export type PriceRow = { model: string } & Record<PriceField, string>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function priceRows(value: unknown): PriceRow[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([model, entry]) => {
    const e = isRecord(entry) ? entry : {};
    const cell = (f: PriceField) => (typeof e[f] === 'number' ? String(e[f]) : '');
    return { model, input: cell('input'), output: cell('output'), cache_read: cell('cache_read'), cache_creation: cell('cache_creation') };
  });
}

export const emptyPriceRow = (): PriceRow => ({ model: '', input: '', output: '', cache_read: '', cache_creation: '' });

// A blank cell is sent as null so the server names it in its 422.
const priceNumber = (cell: string): number | null => (cell.trim() === '' ? null : Number(cell));

export function pricesValue(rows: PriceRow[]): { value: Record<string, Record<PriceField, number | null>> } | { error: string } {
  const value: Record<string, Record<PriceField, number | null>> = {};
  for (const [i, row] of rows.entries()) {
    const model = row.model.trim();
    if (model === '') return { error: `Row ${i + 1} needs a model id.` };
    if (Object.hasOwn(value, model)) return { error: `${model} is listed twice.` };
    value[model] = {
      input: priceNumber(row.input),
      output: priceNumber(row.output),
      cache_read: priceNumber(row.cache_read),
      cache_creation: priceNumber(row.cache_creation),
    };
  }
  return { value };
}

export const labelRows = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export const labelsValue = (rows: string[]): string[] => rows.map((l) => l.trim()).filter((l) => l !== '');

export type SaveProblem =
  | { kind: 'stale'; current: unknown }
  | { kind: 'invalid'; message: string; field: string | null }
  | { kind: 'error'; message: string };

export function saveProblem(error: Error | null): SaveProblem | null {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 409 && error.body['error'] === 'stale') {
    return { kind: 'stale', current: error.body['current'] ?? null };
  }
  if (error instanceof ApiError && error.status === 422) {
    const field = error.body['field'];
    return { kind: 'invalid', message: error.message, field: typeof field === 'string' ? field : null };
  }
  return { kind: 'error', message: error.message };
}
