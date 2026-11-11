/**
 * A code-reviewer verdict's probes[] (GH 2866): each check the reviewer ran in
 * the reviewed checkout, {target, probe_cmd, observed}. validation_record and
 * the honor-system validation-record-fallback CLI share this rule: a pass
 * needs a non-empty, well-formed list; fail and escalate may carry one.
 */

export interface ReviewProbe {
  target: string;
  probe_cmd: string;
  observed: string;
}

const PROBE_FIELDS = ['target', 'probe_cmd', 'observed'] as const;
const PROBE_KEYS: ReadonlySet<string> = new Set(PROBE_FIELDS);
export const PROBE_SHAPE = '{target, probe_cmd, observed}';

export class ProbesError extends Error {
  constructor(
    readonly code: 'probes_required' | 'probes_invalid',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/**
 * The probes[] of a verdict, each field trimmed. Throws ProbesError:
 * probes_required for a pass without a non-empty list, probes_invalid for a
 * list that is not an array, an entry that is not an object, a field that is
 * missing or blank, or an unknown key.
 */
export function parseProbes(verdict: string, raw: unknown): ReviewProbe[] {
  const absent = raw === undefined || raw === null;
  if (!absent && !Array.isArray(raw)) {
    throw new ProbesError('probes_invalid', `probes must be an array of ${PROBE_SHAPE}; got ${typeof raw}`);
  }
  const list = absent ? [] : (raw as unknown[]);
  if (verdict === 'pass' && list.length === 0) {
    throw new ProbesError(
      'probes_required',
      `a pass verdict needs a non-empty probes[], one ${PROBE_SHAPE} per check run in the reviewed checkout: the dependent or behavior it checks, the command, and what it showed.`,
    );
  }
  return list.map((item, i) => parseProbe(item, i));
}

function parseProbe(item: unknown, i: number): ReviewProbe {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new ProbesError('probes_invalid', `probes[${i}] must be an object ${PROBE_SHAPE}`);
  }
  const entry = item as Record<string, unknown>;
  const unknown = Object.keys(entry).filter((k) => !PROBE_KEYS.has(k));
  if (unknown.length > 0) {
    throw new ProbesError('probes_invalid', `probes[${i}] has unknown field(s) ${unknown.join(', ')}. Allowed: ${PROBE_FIELDS.join(', ')}`);
  }
  const text = (field: (typeof PROBE_FIELDS)[number]): string => {
    const v = entry[field];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ProbesError('probes_invalid', `probes[${i}].${field} must be a non-empty string`);
    }
    return v.trim();
  };
  return { target: text('target'), probe_cmd: text('probe_cmd'), observed: text('observed') };
}

/** probes_json's stored form: the list as JSON, or null when it is empty. */
export function probesJson(probes: readonly ReviewProbe[]): string | null {
  return probes.length > 0 ? JSON.stringify(probes) : null;
}
