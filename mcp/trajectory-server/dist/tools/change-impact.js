import { normalizeAgent, requireRoles } from '../middleware/agent-scope.js';
import { CHANGE_SOURCES, computeChangeImpact, METRICS, providerContext, } from '../change-impact/index.js';
const ALLOWED_ROLES = ['bro', 'swe', 'code-reviewer', 'consultant'];
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message) {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function wrapHandler(fn) {
    return async (args) => {
        try {
            return await fn(args);
        }
        catch (e) {
            return err(e.message);
        }
    };
}
function optionalNumber(args, key) {
    const v = args[key];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'number')
        throw new Error(`${key} must be a number`);
    return v;
}
function optionalString(args, key) {
    const v = args[key];
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'string')
        throw new Error(`${key} must be a string`);
    return v;
}
function changeRef(v) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== 'object' || Array.isArray(v))
        throw new Error('change must be an object {source, id}');
    const { source, id, repo } = v;
    if (typeof source !== 'string' || typeof id !== 'string')
        throw new Error('change must be an object {source, id} of strings');
    if (repo === undefined || repo === null)
        return { source: source, id };
    if (typeof repo !== 'string')
        throw new Error('change.repo must be a string');
    return { source: source, id, repo };
}
export function changeImpactTools(db, contextFor = (reader) => providerContext(reader)) {
    const definitions = [
        {
            name: 'change_impact',
            description: 'Before/after agent-metric stats and a verdict per metric for one change or the recent ones.',
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Calling agent identity' },
                    change: {
                        type: 'object',
                        properties: {
                            source: { type: 'string', enum: [...CHANGE_SOURCES] },
                            id: { type: 'string' },
                            repo: { type: 'string', description: 'The repo the change belongs to; required when its id matches changes in more than one repo' },
                        },
                        required: ['source', 'id'],
                        description: 'A change: plugin_version (an installed version; on dev builds a merged change by build), agent_surface (a base-branch commit touching agent files; id is its merge number or 12-char SHA), or tmb_events (a cheatcode install, id cheatcode-<n>, or a cheatcode uninstall or config change, id audit-<n>). Omit for {sources, changes} over the last `limit`. ' +
                            'Per metric: before/after {n, median, mean, estimated_n, unattributed_n}, ratio_of_medians, ratio_ci (seeded 95% bootstrap), p (Mann-Whitney U), p_holm (Holm), verdict (improved, regressed, no_change, not_enough_data under 20 a side). measured_with: changes no sample separates from it. ' +
                            'declared (dev-build plugin_version changes only, absent when none): {metric, direction, outcome} per `Metric: <id> lower|higher` line in the changelog.d/ fragments the PR added; outcome as_declared, wrong_way, not_moved or not_enough_data.',
                    },
                    source: { type: 'string', enum: [...CHANGE_SOURCES], description: 'Without change: list only this source' },
                    metric: { type: 'string', enum: METRICS.map((m) => m.id), description: 'Return only this metric (Holm still spans every metric)' },
                    window_days: { type: 'integer', description: 'Days either side of the change a sample may fall in (default 14)' },
                    max_samples: { type: 'integer', description: 'Samples kept per side, nearest the change first (default 200)' },
                    limit: { type: 'integer', description: 'Without change: how many recent changes (default 20)' },
                },
                required: ['agent'],
            },
        },
    ];
    const handlers = {
        change_impact: requireRoles('change_impact', [...ALLOWED_ROLES], wrapHandler(async (args) => {
            normalizeAgent(args['agent']);
            return ok(computeChangeImpact(db, contextFor(db), {
                change: changeRef(args['change']),
                source: optionalString(args, 'source'),
                metric: optionalString(args, 'metric'),
                window_days: optionalNumber(args, 'window_days'),
                max_samples: optionalNumber(args, 'max_samples'),
                limit: optionalNumber(args, 'limit'),
            }));
        })),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=change-impact.js.map