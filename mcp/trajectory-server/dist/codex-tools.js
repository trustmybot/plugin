import { CodexAgentMaterializationError, CodexAgentMaterializer, } from './codex-agent-materializer.js';
import { CodexRuntimeError, } from './codex-runtime.js';
import { discussionTools } from './tools/discussions.js';
import { getConfigValues, setConfigValues, storedConfigParseErrorPrefix, } from './tools/config.js';
import { issueTools } from './tools/issues.js';
import { scanTools } from './tools/scan.js';
import { worldModelTools } from './tools/world_model.js';
const FIXED_AGENT = 'bro';
const DEFAULT_CLASSIFICATION_LABELS = Object.freeze([
    'Bug',
    'Feature',
    'Improvement',
    'Docs',
    'Test',
    'Chore',
]);
const DEFAULT_PRIORITY_LABELS = Object.freeze([
    'Priority: Urgent',
    'Priority: High',
    'Priority: Medium',
    'Priority: Low',
]);
const CLASSIFICATION_TAXONOMY_KEY = 'issue_classification_labels';
const PRIORITY_TAXONOMY_KEY = 'issue_priority_labels';
const IDENTITY_KEYS = new Set([
    'agent',
    'author',
    'provenance',
    'role',
    'verified_human',
]);
const OUT_OF_SCOPE_TOOL = /^(?:agent|branch|cheatcode|config|discussion|issue|milestone|onboard|pr_monitor|report|repos|roundtable|scan|skill|stats|task|validation|worktree)(?:_|$)/;
export const CODEX_SCOPE_3_TOOL_NAMES = Object.freeze([
    'runtime_initialize',
    'project_inventory',
    'project_scan',
    'world_model_get',
    'world_model_search',
    'planning_label_taxonomy_get',
    'planning_label_taxonomy_set',
    'planning_issue_create',
    'planning_issue_get',
    'planning_issue_list',
    'planning_issue_resume',
    'planning_discussion_append',
    'planning_discussion_list',
]);
export const CODEX_SCOPE_4_TOOL_NAMES = Object.freeze([
    ...CODEX_SCOPE_3_TOOL_NAMES,
    'agent_materialization_get',
    'agent_materialization_set',
]);
export function createCodexToolRegistry(manager) {
    const materializer = new CodexAgentMaterializer();
    const definitions = deepFreeze([
        tool('runtime_initialize', 'Initialize or reuse project-local TMB state for one explicit Git worktree root.', {}, [], { idempotent: true }),
        tool('project_inventory', 'List repositories recorded by the latest project-local scan.', {}, [], { readOnly: true }),
        tool('project_scan', 'Scan the selected project root into its project-local repository inventory and world model.', {}, [], { idempotent: true }),
        tool('world_model_get', 'Read an annotated directory subtree from the selected project world model.', {
            repo: { type: 'string', description: 'Repository name when the project contains more than one repository.' },
            path: { type: 'string', description: 'Repository-relative directory path. Defaults to the repository root.' },
            depth: { type: ['integer', 'null'], description: 'Subtree depth. Defaults to 2; null requests the complete subtree.' },
        }, [], { readOnly: true }),
        tool('world_model_search', 'Search project-local world-model paths and summaries.', {
            query: { type: 'string', description: 'Natural-language or keyword search query.' },
            mode: { type: 'string', enum: ['keyword', 'semantic', 'hybrid'], description: 'Search mode. Defaults to hybrid.' },
            repo: { type: 'string', description: 'Optional repository-name restriction.' },
            k: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum result count. Defaults to 5.' },
        }, ['query'], { readOnly: true }),
        tool('planning_label_taxonomy_get', 'Read the exact classification and priority labels accepted by the selected project.', {}, [], { readOnly: true }),
        tool('planning_label_taxonomy_set', 'Configure the exact project-local classification and priority labels accepted by Codex planning.', {
            classification_labels: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1, pattern: '\\S' },
                description: 'Complete non-empty classification-label taxonomy for this Codex project state.',
            },
            priority_labels: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1, pattern: '\\S' },
                description: 'Complete non-empty priority-label taxonomy for this Codex project state.',
            },
        }, ['classification_labels', 'priority_labels'], { destructive: true, idempotent: true }),
        tool('planning_issue_create', 'Create a local-only TMB planning issue. Remote issue synchronization is forced off.', {
            objective: { type: 'string', description: 'Concise planning objective.' },
            description: { type: 'string', description: 'Markdown context, requirements, and acceptance criteria.' },
            classification: {
                type: 'string',
                enum: ['Bug', 'Feature', 'Improvement', 'Docs', 'Test', 'Chore'],
                description: 'Local classification. Defaults to Feature.',
            },
            priority: {
                type: 'string',
                enum: ['Urgent', 'High', 'Medium', 'Low'],
                description: 'Local priority. Defaults to Medium.',
            },
            labels: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1, pattern: '\\S' },
                description: 'Labels passed verbatim to shared issue validation. Must include at least one classification and one priority from the project taxonomy; additional explicit labels are allowed. Cannot be combined with classification or priority.',
            },
            repo: { type: 'string', description: 'Optional repository name from project_inventory.' },
            allow_duplicate: { type: 'boolean', description: 'Allow an objective similar to an existing open local issue.' },
        }, ['objective'], {}, {
            allOf: [
                { not: { required: ['labels', 'classification'] } },
                { not: { required: ['labels', 'priority'] } },
            ],
        }),
        tool('planning_issue_get', 'Read one project-local planning issue, including its description.', {
            issue_id: { type: 'string', description: 'Local TMB issue identifier.' },
        }, ['issue_id'], { readOnly: true }),
        tool('planning_issue_list', 'List project-local planning issues.', {
            status: { type: 'string', enum: ['open', 'closed'], description: 'Optional local status filter.' },
            limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows. Defaults to 50.' },
            offset: { type: 'integer', minimum: 0, description: 'Row offset. Defaults to 0.' },
        }, [], { readOnly: true }),
        tool('planning_issue_resume', 'Read one project-local planning issue with its recent discussion record; no task execution state is exposed.', {
            issue_id: { type: 'string', description: 'Local TMB issue identifier.' },
            discussion_limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum discussion rows. Defaults to 50.' },
        }, ['issue_id'], { readOnly: true }),
        tool('planning_discussion_append', 'Append a Bro-authored decision, question, or note to a local planning issue.', {
            issue_id: { type: 'string', description: 'Local TMB issue identifier.' },
            kind: { type: 'string', enum: ['decision', 'question', 'note'], description: 'Planning record kind. Defaults to note.' },
            body: { type: 'string', description: 'Markdown discussion body.' },
        }, ['issue_id', 'body']),
        tool('planning_discussion_list', 'List project-local discussion records for a planning issue.', {
            issue_id: { type: 'string', description: 'Local TMB issue identifier.' },
            limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows. Defaults to 50.' },
            cursor: { type: 'string', description: 'Opaque cursor from a prior response.' },
        }, ['issue_id'], { readOnly: true }),
        tool('agent_materialization_get', 'Inspect the two fixed project-level TMB Codex Agent files without creating project state or host configuration.', {}, [], { readOnly: true, idempotent: true }),
        tool('agent_materialization_set', 'Create or remove the two fixed project-level TMB Codex Agent files after explicit confirmation.', {
            desired_state: {
                type: 'string',
                enum: ['present', 'absent'],
                description: 'Whether both fixed TMB Codex Agent files must be present or absent.',
            },
        }, ['desired_state'], { destructive: true, idempotent: true }),
    ]);
    const handlers = deepFreeze({
        runtime_initialize: async (args) => runAdapter(args, ['project_root'], async (input) => ({
            runtime: await manager.initialize(input['project_root']),
        })),
        project_inventory: async (args) => runWithRuntime(manager, args, ['project_root'], async (runtime) => {
            const shared = scanTools(runtime.db, runtime.graph, runtime.context.paths.trajectoryDb);
            return callShared(shared.handlers['repos_list'], { agent: FIXED_AGENT });
        }),
        project_scan: async (args) => runWithRuntime(manager, args, ['project_root'], async (runtime) => {
            const shared = scanTools(runtime.db, runtime.graph, runtime.context.paths.trajectoryDb);
            return callShared(shared.handlers['scan_run'], {
                agent: FIXED_AGENT,
                session_dir: runtime.context.projectRoot,
                source: 'bro_auto_initial',
            });
        }),
        world_model_get: async (args) => runWithRuntime(manager, args, ['project_root', 'repo', 'path', 'depth'], async (runtime, input) => {
            optionalString(input, 'repo');
            optionalString(input, 'path');
            if (input['depth'] !== null)
                optionalInteger(input, 'depth', 0);
            const shared = worldModelTools(runtime.db, runtime.graph);
            return callShared(shared.handlers['world_model_get'], compact({
                agent: FIXED_AGENT,
                repo: input['repo'],
                path: input['path'],
                depth: input['depth'],
            }));
        }),
        world_model_search: async (args) => runWithRuntime(manager, args, ['project_root', 'query', 'mode', 'repo', 'k'], async (runtime, input) => {
            requireString(input, 'query');
            optionalEnum(input, 'mode', ['keyword', 'semantic', 'hybrid']);
            optionalString(input, 'repo');
            optionalInteger(input, 'k', 1, 20);
            const shared = worldModelTools(runtime.db, runtime.graph);
            return callShared(shared.handlers['world_model_search'], compact({
                agent: FIXED_AGENT,
                query: input['query'],
                mode: input['mode'],
                repo: input['repo'],
                k: input['k'],
            }));
        }),
        planning_label_taxonomy_get: async (args) => runWithRuntime(manager, args, ['project_root'], async (runtime) => resolvePlanningLabelTaxonomy(runtime)),
        planning_label_taxonomy_set: async (args) => runWithRuntime(manager, args, ['project_root', 'classification_labels', 'priority_labels'], async (runtime, input) => {
            const classificationLabels = requireTaxonomyArray(input, 'classification_labels', CLASSIFICATION_TAXONOMY_KEY);
            const priorityLabels = requireTaxonomyArray(input, 'priority_labels', PRIORITY_TAXONOMY_KEY);
            setConfigValues(runtime.db, [
                {
                    key: CLASSIFICATION_TAXONOMY_KEY,
                    value: classificationLabels,
                },
                {
                    key: PRIORITY_TAXONOMY_KEY,
                    value: priorityLabels,
                },
            ]);
            return resolvePlanningLabelTaxonomy(runtime);
        }),
        planning_issue_create: async (args) => runWithRuntime(manager, args, [
            'project_root',
            'objective',
            'description',
            'classification',
            'priority',
            'labels',
            'repo',
            'allow_duplicate',
        ], async (runtime, input) => {
            requireString(input, 'objective');
            optionalString(input, 'description');
            const hasExactLabels = input['labels'] !== undefined;
            if (hasExactLabels &&
                (input['classification'] !== undefined || input['priority'] !== undefined)) {
                throw new CodexAdapterError('invalid_arguments', 'labels cannot be combined with classification or priority.');
            }
            optionalEnum(input, 'classification', [
                'Bug',
                'Feature',
                'Improvement',
                'Docs',
                'Test',
                'Chore',
            ]);
            optionalEnum(input, 'priority', [
                'Urgent',
                'High',
                'Medium',
                'Low',
            ]);
            optionalStringArray(input, 'labels');
            optionalString(input, 'repo');
            optionalBoolean(input, 'allow_duplicate');
            const taxonomy = await resolvePlanningLabelTaxonomy(runtime);
            forceLocalIssueSync(runtime);
            const shared = issueTools(runtime.db, runtime.context.paths.trajectoryDb, {
                labelTaxonomy: {
                    classification: taxonomy.classification_labels,
                    priorityLabels: taxonomy.priority_labels,
                },
            });
            return callShared(shared.handlers['issue_create'], compact({
                agent: FIXED_AGENT,
                objective: input['objective'],
                description: input['description'],
                labels: hasExactLabels
                    ? input['labels']
                    : [
                        input['classification'] ?? 'Feature',
                        `Priority: ${String(input['priority'] ?? 'Medium')}`,
                    ],
                repo: input['repo'],
                allow_duplicate: input['allow_duplicate'],
            }));
        }),
        planning_issue_get: async (args) => runWithRuntime(manager, args, ['project_root', 'issue_id'], async (runtime, input) => {
            requireString(input, 'issue_id');
            const shared = issueTools(runtime.db, runtime.context.paths.trajectoryDb);
            return callShared(shared.handlers['issue_get'], {
                agent: FIXED_AGENT,
                issue_id: input['issue_id'],
                include_description: true,
            });
        }),
        planning_issue_list: async (args) => runWithRuntime(manager, args, ['project_root', 'status', 'limit', 'offset'], async (runtime, input) => {
            optionalEnum(input, 'status', ['open', 'closed']);
            optionalInteger(input, 'limit', 1, 200);
            optionalInteger(input, 'offset', 0);
            const shared = issueTools(runtime.db, runtime.context.paths.trajectoryDb);
            return callShared(shared.handlers['issue_list'], compact({
                agent: FIXED_AGENT,
                status: input['status'],
                limit: input['limit'],
                offset: input['offset'],
            }));
        }),
        planning_issue_resume: async (args) => runWithRuntime(manager, args, ['project_root', 'issue_id', 'discussion_limit'], async (runtime, input) => {
            requireString(input, 'issue_id');
            optionalInteger(input, 'discussion_limit', 1, 200);
            const issues = issueTools(runtime.db, runtime.context.paths.trajectoryDb);
            const discussions = discussionTools(runtime.db);
            const issue = await callShared(issues.handlers['issue_get'], {
                agent: FIXED_AGENT,
                issue_id: input['issue_id'],
                include_description: true,
            });
            const records = await callShared(discussions.handlers['discussion_list'], {
                agent: FIXED_AGENT,
                issue_id: input['issue_id'],
                limit: input['discussion_limit'] ?? 50,
            });
            return { issue, discussions: records };
        }),
        planning_discussion_append: async (args) => runWithRuntime(manager, args, ['project_root', 'issue_id', 'kind', 'body'], async (runtime, input) => {
            requireString(input, 'issue_id');
            requireString(input, 'body');
            optionalEnum(input, 'kind', ['decision', 'question', 'note']);
            const shared = discussionTools(runtime.db);
            return callShared(shared.handlers['discussion_append'], {
                agent: FIXED_AGENT,
                author: FIXED_AGENT,
                issue_id: input['issue_id'],
                kind: input['kind'] ?? 'note',
                body: input['body'],
            });
        }),
        planning_discussion_list: async (args) => runWithRuntime(manager, args, ['project_root', 'issue_id', 'limit', 'cursor'], async (runtime, input) => {
            requireString(input, 'issue_id');
            optionalInteger(input, 'limit', 1, 200);
            optionalString(input, 'cursor');
            const shared = discussionTools(runtime.db);
            return callShared(shared.handlers['discussion_list'], compact({
                agent: FIXED_AGENT,
                issue_id: input['issue_id'],
                limit: input['limit'] ?? 50,
                cursor: input['cursor'],
            }));
        }),
        agent_materialization_get: async (args) => runAdapter(args, ['project_root'], async (input) => {
            requireProjectRoot(input);
            return materializer.get(input['project_root']);
        }),
        agent_materialization_set: async (args) => runAdapter(args, ['project_root', 'desired_state'], async (input) => {
            requireProjectRoot(input);
            const desiredState = requireEnum(input, 'desired_state', ['present', 'absent']);
            return materializer.set(input['project_root'], desiredState);
        }),
    });
    const call = async (name, args) => {
        const handler = handlers[name];
        if (!handler) {
            const code = OUT_OF_SCOPE_TOOL.test(name)
                ? 'out_of_scope_operation'
                : 'unknown_tool';
            return errorResult(code, `Codex Scope 4 does not expose tool: ${name}`);
        }
        return handler(args);
    };
    return deepFreeze({ definitions, handlers, call });
}
function tool(name, description, properties, required, annotations = {}, schemaConstraints = {}) {
    return {
        name,
        description,
        inputSchema: {
            type: 'object',
            properties: {
                project_root: {
                    type: 'string',
                    description: 'Absolute path to the selected Git worktree root.',
                },
                ...properties,
            },
            required: ['project_root', ...required],
            additionalProperties: false,
            ...schemaConstraints,
        },
        annotations: {
            readOnlyHint: annotations.readOnly ?? false,
            destructiveHint: annotations.destructive ?? false,
            idempotentHint: annotations.idempotent ?? false,
            openWorldHint: false,
        },
    };
}
async function runWithRuntime(manager, args, allowedKeys, operation) {
    return runAdapter(args, allowedKeys, async (input) => manager.withRuntime(input['project_root'], (runtime) => operation(runtime, input)));
}
async function runAdapter(args, allowedKeys, operation) {
    try {
        const input = validateInput(args, allowedKeys);
        const data = await operation(input);
        return jsonResult({ ok: true, data });
    }
    catch (error) {
        return adapterErrorResult(error);
    }
}
function validateInput(args, allowedKeys) {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new CodexAdapterError('invalid_arguments', 'Tool arguments must be a JSON object.');
    }
    const input = args;
    for (const key of IDENTITY_KEYS) {
        if (Object.hasOwn(input, key)) {
            throw new CodexAdapterError('unsupported_identity_claim', `Caller-supplied ${key} is not accepted by the Codex adapter.`);
        }
    }
    requireProjectRoot(input);
    for (const key of Object.keys(input)) {
        if (!allowedKeys.includes(key)) {
            throw new CodexAdapterError('invalid_arguments', `Unsupported argument: ${key}`);
        }
    }
    return input;
}
function requireProjectRoot(input) {
    const value = input['project_root'];
    if (typeof value !== 'string' || value.length === 0) {
        throw new CodexAdapterError('missing_project_root', 'project_root is required.');
    }
    return value;
}
function requireEnum(input, key, allowed) {
    const value = input[key];
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new CodexAdapterError('invalid_arguments', `${key} must be one of: ${allowed.join(', ')}.`);
    }
    return value;
}
function requireString(input, key) {
    const value = input[key];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new CodexAdapterError('invalid_arguments', `${key} must be a non-empty string.`);
    }
    return value;
}
function optionalString(input, key) {
    if (input[key] !== undefined && typeof input[key] !== 'string') {
        throw new CodexAdapterError('invalid_arguments', `${key} must be a string when provided.`);
    }
}
function optionalBoolean(input, key) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
        throw new CodexAdapterError('invalid_arguments', `${key} must be a boolean when provided.`);
    }
}
function optionalStringArray(input, key) {
    const value = input[key];
    if (value !== undefined &&
        (!Array.isArray(value) ||
            value.length === 0 ||
            !value.every((item) => typeof item === 'string' && item.trim().length > 0))) {
        throw new CodexAdapterError('invalid_arguments', `${key} must be a non-empty array of non-empty strings when provided.`);
    }
}
function optionalInteger(input, key, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    const value = input[key];
    if (value !== undefined &&
        (!Number.isSafeInteger(value) ||
            value < minimum ||
            value > maximum)) {
        throw new CodexAdapterError('invalid_arguments', `${key} must be an integer from ${minimum} to ${maximum}.`);
    }
}
function optionalEnum(input, key, allowed) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
        throw new CodexAdapterError('invalid_arguments', `${key} must be one of: ${allowed.join(', ')}.`);
    }
}
function forceLocalIssueSync(runtime) {
    runtime.db.run(`INSERT INTO plugin_config (key, value_json)
     VALUES ('issue_sync', '"off"')
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`);
}
async function resolvePlanningLabelTaxonomy(runtime) {
    let values;
    try {
        values = getConfigValues(runtime.db, [
            CLASSIFICATION_TAXONOMY_KEY,
            PRIORITY_TAXONOMY_KEY,
        ]);
    }
    catch (error) {
        if (error instanceof Error &&
            [CLASSIFICATION_TAXONOMY_KEY, PRIORITY_TAXONOMY_KEY].some((key) => error.message.startsWith(storedConfigParseErrorPrefix(key)))) {
            const key = error.message.startsWith(storedConfigParseErrorPrefix(CLASSIFICATION_TAXONOMY_KEY))
                ? CLASSIFICATION_TAXONOMY_KEY
                : PRIORITY_TAXONOMY_KEY;
            throw invalidLabelTaxonomy(key);
        }
        throw error;
    }
    const classification = readTaxonomyConfig(values[CLASSIFICATION_TAXONOMY_KEY], CLASSIFICATION_TAXONOMY_KEY, DEFAULT_CLASSIFICATION_LABELS);
    const priority = readTaxonomyConfig(values[PRIORITY_TAXONOMY_KEY], PRIORITY_TAXONOMY_KEY, DEFAULT_PRIORITY_LABELS);
    return {
        classification_labels: classification.labels,
        priority_labels: priority.labels,
        classification_source: classification.source,
        priority_source: priority.source,
    };
}
function requireTaxonomyArray(input, inputKey, configKey) {
    const value = input[inputKey];
    if (!Array.isArray(value) ||
        value.length === 0 ||
        !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
        throw invalidLabelTaxonomy(configKey);
    }
    return [...value];
}
function readTaxonomyConfig(value, key, defaults) {
    if (value === null) {
        return { labels: [...defaults], source: 'default' };
    }
    if (!Array.isArray(value) ||
        value.length === 0 ||
        !value.every((item) => typeof item === 'string' && item.trim().length > 0)) {
        throw invalidLabelTaxonomy(key);
    }
    const labels = value;
    return {
        labels: [...labels],
        source: arraysEqual(labels, defaults) ? 'default' : 'configured',
    };
}
function invalidLabelTaxonomy(key) {
    return new CodexAdapterError('invalid_label_taxonomy', `${key} must be a non-empty array of non-empty strings.`);
}
function arraysEqual(left, right) {
    return (left.length === right.length &&
        left.every((value, index) => value === right[index]));
}
async function callShared(handler, args) {
    const result = await handler(args);
    const first = result.content[0];
    if (!first || first.type !== 'text') {
        throw new CodexAdapterError('operation_failed', 'Shared TMB handler returned no JSON text result.');
    }
    let payload;
    try {
        payload = JSON.parse(first.text);
    }
    catch {
        throw new CodexAdapterError('operation_failed', 'Shared TMB handler returned malformed JSON.');
    }
    if (result.isError) {
        const message = sharedErrorMessage(payload);
        const match = /^([a-z][a-z0-9_-]+):/.exec(message);
        throw new CodexAdapterError(match?.[1] ?? 'operation_failed', message);
    }
    return payload;
}
function sharedErrorMessage(payload) {
    if (typeof payload === 'object' &&
        payload !== null &&
        typeof payload['error'] === 'string') {
        return payload['error'];
    }
    return 'Shared TMB operation failed.';
}
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
class CodexAdapterError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'CodexAdapterError';
    }
}
function adapterErrorResult(error) {
    if (error instanceof CodexRuntimeError) {
        return errorResult(error.code, error.message);
    }
    if (error instanceof CodexAdapterError) {
        return errorResult(error.code, error.message, error.details);
    }
    if (error instanceof CodexAgentMaterializationError) {
        return errorResult(error.code, error.message, error.details);
    }
    return errorResult('operation_failed', error instanceof Error ? error.message : String(error));
}
function errorResult(code, message, details) {
    return jsonResult({
        ok: false,
        error: { code, message, ...(details ? { details } : {}) },
    }, true);
}
function jsonResult(value, isError = false) {
    return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        ...(isError ? { isError: true } : {}),
    };
}
function deepFreeze(value) {
    if (value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=codex-tools.js.map