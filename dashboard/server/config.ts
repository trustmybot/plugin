// GET /api/config and POST /api/config/:key: the Human edits the allowlisted non-policy config keys through config_set (GH 1347).
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { TrajectoryDB } from '../../mcp/trajectory-server/src/db.ts';
import { configTools } from '../../mcp/trajectory-server/src/tools/config.ts';
import { PRICE_FIELDS } from './queries.ts';
import {
  GATE_AGENT,
  fail,
  handlerError,
  humanAudit,
  openWriteDb,
  parseHandlerResult,
  schemaMismatch,
  type Body,
  type Handler,
  type WriteResult,
} from './writes.ts';

export const EDITABLE_CONFIG_KEYS = [
  'model_prices',
  'issue_area_labels',
  'issue_classification_labels',
  'issue_priority_labels',
] as const;
export type EditableConfigKey = (typeof EDITABLE_CONFIG_KEYS)[number];

export function isEditableConfigKey(key: string): key is EditableConfigKey {
  return (EDITABLE_CONFIG_KEYS as readonly string[]).includes(key);
}

const BODY_KEYS = ['value', 'expected'];

// A missing row and a value_json that does not parse both read as null, so the
// value GET shows is the value the stale check compares against.
function storedValue(valueJson: string | undefined): unknown {
  if (valueJson === undefined) return null;
  try {
    return JSON.parse(valueJson) as unknown;
  } catch {
    return null;
  }
}

export function editableConfig(db: DatabaseSync): { keys: Array<{ key: EditableConfigKey; value: unknown }> } {
  const rows = db
    .prepare('SELECT key, value_json FROM plugin_config WHERE key IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(EDITABLE_CONFIG_KEYS)) as Array<{ key: string; value_json: string }>;
  const stored = new Map(rows.map((r) => [r.key, r.value_json]));
  return { keys: EDITABLE_CONFIG_KEYS.map((key) => ({ key, value: storedValue(stored.get(key)) })) };
}

const invalid = (field: string, message: string): WriteResult => fail(422, 'invalid_value', message, { field });

function checkLabels(value: unknown): WriteResult | null {
  if (!Array.isArray(value) || value.length === 0) return invalid('value', 'labels must be a non-empty array of strings');
  const seen = new Set<string>();
  for (const [i, label] of value.entries()) {
    const field = `value[${i}]`;
    if (typeof label !== 'string' || label.trim() === '') return invalid(field, `label ${i + 1} must be a non-empty string`);
    if (label !== label.trim()) return invalid(field, `label ${JSON.stringify(label)} has leading or trailing spaces`);
    if (seen.has(label)) return invalid(field, `label ${JSON.stringify(label)} is listed twice`);
    seen.add(label);
  }
  return null;
}

function checkPrices(value: unknown): WriteResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('value', 'model_prices must be an object keyed by model name');
  }
  for (const [model, entry] of Object.entries(value)) {
    const at = `value[${JSON.stringify(model)}]`;
    if (model.trim() === '') return invalid(at, 'a model name must be non-empty');
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return invalid(at, `${model} must be an object with ${PRICE_FIELDS.join(', ')}`);
    }
    const unknown = Object.keys(entry).filter((k) => !(PRICE_FIELDS as readonly string[]).includes(k));
    if (unknown.length > 0) return invalid(`${at}.${unknown[0]}`, `${model} has an unknown field: ${unknown.join(', ')}`);
    for (const f of PRICE_FIELDS) {
      const n = (entry as Body)[f];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        return invalid(`${at}.${f}`, `${model} ${f} must be a number ≥ 0 (USD per 1M tokens)`);
      }
    }
  }
  return null;
}

export function checkConfigValue(key: EditableConfigKey, value: unknown): WriteResult | null {
  return key === 'model_prices' ? checkPrices(value) : checkLabels(value);
}

type Step = { stale: true; current: unknown } | { stale: false; pending: ReturnType<Handler>; changed: boolean; after: unknown };

export class ConfigWriter {
  private writable: { db: TrajectoryDB; set: Handler } | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly readDb: DatabaseSync,
  ) {}

  private open(): { db: TrajectoryDB; set: Handler } {
    if (this.writable) return this.writable;
    const db = openWriteDb(this.dbPath);
    const set = configTools(db).handlers['config_set'];
    if (!set) throw new Error('trajectory-server handler config_set missing');
    this.writable = { db, set };
    return this.writable;
  }

  close(): void {
    this.writable?.db.close();
    this.writable = null;
  }

  async perform(key: EditableConfigKey, body: Body): Promise<WriteResult> {
    const unknown = Object.keys(body).filter((k) => !BODY_KEYS.includes(k));
    if (unknown.length > 0) return fail(400, 'unknown_fields', `config writes do not take: ${unknown.join(', ')}`);
    if (!Object.hasOwn(body, 'expected')) {
      return fail(400, 'expected_required', 'send the value you loaded as expected (null when the key was unset)');
    }
    const mismatch = schemaMismatch(this.readDb);
    if (mismatch) return mismatch;
    const value = body['value'];
    const bad = checkConfigValue(key, value);
    if (bad) return bad;

    const step = this.writeIfCurrent(key, value, body['expected']);
    if (step.stale) {
      return fail(409, 'stale', `${key} changed since you loaded it. Reload to see the latest, then retry.`, { current: step.current });
    }
    const res = parseHandlerResult(await step.pending);
    if (!res.ok) return handlerError('config_set', res.data);
    return { status: 200, body: { ok: true, key, value: step.after, changed: step.changed } };
  }

  // The expected-value check, config_set's write and the Human audit row share
  // one BEGIN IMMEDIATE. config_set writes before its first await, so its write
  // lands inside it; an identical value writes nothing and leaves no audit row.
  private writeIfCurrent(key: EditableConfigKey, value: unknown, expected: unknown): Step {
    const { db, set } = this.open();
    const read = () => db.get<{ value_json: string }>('SELECT value_json FROM plugin_config WHERE key = ?', [key])?.value_json;
    return db.transaction((): Step => {
      const before = read();
      const current = storedValue(before);
      if (!isDeepStrictEqual(current, expected)) return { stale: true, current };
      const pending = set({ agent: GATE_AGENT, key, value });
      const afterJson = read();
      const changed = afterJson !== before;
      if (changed) {
        humanAudit(db, {
          issue_id: -1,
          event_type: 'config_changed',
          summary: `the Human ran config_set on ${key} from the dashboard`,
          content: { tool: 'config_set', fields: [key] },
        });
      }
      return { stale: false, pending, changed, after: storedValue(afterJson) };
    });
  }
}
