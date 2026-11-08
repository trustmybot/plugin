import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { computeChangeImpact, defaultGitSource, METRICS, type GitSource } from '../change-impact/index.js';
import type { StatsReader } from './stats.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const ALLOWED_ROLES = ['bro', 'swe', 'code-reviewer', 'consultant'] as const;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function wrapHandler(fn: (args: Record<string, unknown>) => Promise<CallToolResult>): Fn {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') throw new Error(`${key} must be a number`);
  return v;
}

export function changeImpactTools(
  db: StatsReader | TrajectoryDB,
  gitSource: (reader: StatsReader) => GitSource = (reader) => defaultGitSource(reader),
): { definitions: Tool[]; handlers: Record<string, Fn> } {
  const definitions: Tool[] = [
    {
      name: 'change_impact',
      description: 'Before/after agent-metric stats and a verdict per metric for a merged PR (GH 2600).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Calling agent identity' },
          change: {
            type: 'integer',
            description:
              'PR number of a merged change on the plugin target; omit for {changes} over the last `limit` merged PRs. A sample is after the change when its build includes it (dev build gh<PR>, release tag merge-base, or a NULL version by time, counted in estimated_n). ' +
              'Per metric: before/after {n, median, mean, estimated_n, unattributed_n}, ratio_of_medians, ratio_ci (seeded 95% bootstrap), p (Mann-Whitney U), p_holm (Holm across the metrics), verdict (improved, regressed, no_change, not_enough_data under 20 a side). measured_with: PRs no run separates from the change.',
          },
          metric: { type: 'string', enum: METRICS.map((m) => m.id), description: 'Return only this metric (Holm still spans every metric)' },
          window_days: { type: 'integer', description: 'Days either side of the merge a sample may fall in (default 14)' },
          max_samples: { type: 'integer', description: 'Samples kept per side, nearest the merge first (default 200)' },
          limit: { type: 'integer', description: 'Without change: how many recent merged PRs (default 20)' },
        },
        required: ['agent'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    change_impact: requireRoles(
      'change_impact',
      [...ALLOWED_ROLES],
      wrapHandler(async (args) => {
        normalizeAgent(args['agent'] as string | undefined);
        const metric = args['metric'];
        if (metric !== undefined && metric !== null && typeof metric !== 'string') throw new Error('metric must be a string');
        return ok(
          computeChangeImpact(db, gitSource(db), {
            change: optionalNumber(args, 'change'),
            metric: (metric as string | null | undefined) ?? undefined,
            window_days: optionalNumber(args, 'window_days'),
            max_samples: optionalNumber(args, 'max_samples'),
            limit: optionalNumber(args, 'limit'),
          }),
        );
      }),
    ),
  };

  return { definitions, handlers };
}
