import { requireRoles } from '../middleware/agent-scope.js';
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
const KEY_REGEX = /^[a-z][a-z0-9_.-]{0,63}$/i;
export const EFFORT_LEVELS = ['low', 'medium', 'high'];
export const SWE_DEFAULT_EFFORT_KEY = 'swe_default_effort';
export const REVIEWER_EFFORT_KEY = 'reviewer_effort';
const EFFORT_DEFAULTS = {
    [SWE_DEFAULT_EFFORT_KEY]: 'medium',
    [REVIEWER_EFFORT_KEY]: 'high',
};
export function isEffort(value) {
    return typeof value === 'string' && EFFORT_LEVELS.includes(value);
}
export function effortRank(value) {
    return EFFORT_LEVELS.indexOf(value);
}
/**
 * The effort a new swe task runs at when its creator names none, and the
 * effort every pr-reviewer spawn runs at. An unset or unreadable key reads as
 * its default (medium, high). The hooks' twin is tmb_effort_defaults in
 * scripts/hooks/lib/query-task.sh.
 */
export function resolveEffortDefaults(db) {
    const rows = db.all(`SELECT key, value_json FROM plugin_config WHERE key IN (?, ?)`, [SWE_DEFAULT_EFFORT_KEY, REVIEWER_EFFORT_KEY]);
    const read = (key) => {
        const row = rows.find((r) => r.key === key);
        if (row) {
            try {
                const value = JSON.parse(row.value_json);
                if (isEffort(value))
                    return value;
            }
            catch {
                // An unparseable stored value reads as the default.
            }
        }
        return EFFORT_DEFAULTS[key];
    };
    return { swe: read(SWE_DEFAULT_EFFORT_KEY), reviewer: read(REVIEWER_EFFORT_KEY) };
}
export const HIGH_EFFORT_PATHS_KEY = 'high_effort_paths';
/**
 * The project-declared path prefixes whose files[] overlap raises a task's
 * effort to high. Unset, unparseable or not a string[] reads as [].
 */
export function readHighEffortPaths(db) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = ?`, [HIGH_EFFORT_PATHS_KEY]);
    if (!row)
        return [];
    try {
        const value = JSON.parse(row.value_json);
        if (Array.isArray(value) && value.every((el) => typeof el === 'string'))
            return value;
    }
    catch {
        // An unparseable stored value reads as unset.
    }
    return [];
}
function stripTrailingSlash(path) {
    return path.endsWith('/') ? path.slice(0, -1) : path;
}
function pathsOverlap(file, prefix) {
    const a = stripTrailingSlash(file);
    const b = stripTrailingSlash(prefix);
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
export const SWE_EFFORT_AB_KEY = 'swe_effort_ab';
export function isEffortAbConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const { label, target } = value;
    return typeof label === 'string' && label.trim().length > 0 && Number.isInteger(target) && target > 0;
}
/** The swe effort A/B (GH 1745); unset, unparseable or malformed reads as off (null). */
export function readEffortAb(db) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = ?`, [SWE_EFFORT_AB_KEY]);
    if (!row)
        return null;
    try {
        const value = JSON.parse(row.value_json);
        if (isEffortAbConfig(value))
            return { label: value.label, target: value.target };
    }
    catch {
        // An unparseable stored value reads as unset.
    }
    return null;
}
/**
 * The effort a swe task runs at: an explicit valid effort wins; otherwise the
 * swe_default_effort (the task's current effort for a rework), raised to high
 * for a prompt-bearing task, a files[] entry overlapping a high_effort_paths
 * prefix, or a rework. The first matching reason is reported.
 */
export function computeEffort(db, input) {
    if (isEffort(input.effort))
        return { effort: input.effort, reason: 'explicit' };
    const base = input.rework && input.current ? input.current : resolveEffortDefaults(db).swe;
    if (input.prompt_bearing === 1)
        return { effort: 'high', reason: 'prompt_bearing' };
    const prefixes = readHighEffortPaths(db);
    if (input.files.some((file) => prefixes.some((prefix) => pathsOverlap(file, prefix)))) {
        return { effort: 'high', reason: 'high_effort_paths' };
    }
    if (input.rework)
        return { effort: 'high', reason: 'rework' };
    return { effort: base, reason: 'default' };
}
export const ISSUE_AREA_LABELS_KEY = 'issue_area_labels';
export const ISSUE_AREA_PATHS_KEY = 'issue_area_paths';
export function isNonEmptyStringArray(value) {
    return Array.isArray(value) && value.every((el) => typeof el === 'string' && el.trim().length > 0);
}
export function isAreaPathMap(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.entries(value).every(([prefix, area]) => prefix.trim().length > 0 && typeof area === 'string' && area.trim().length > 0));
}
function validateKnownConfigValue(key, value) {
    if (key === ISSUE_AREA_LABELS_KEY && !isNonEmptyStringArray(value)) {
        throw new Error(`typed_field_violation: config key ${JSON.stringify(key)} must be an array of non-empty strings, got ${JSON.stringify(value)}.`);
    }
    if (key === ISSUE_AREA_PATHS_KEY && !isAreaPathMap(value)) {
        throw new Error(`typed_field_violation: config key ${JSON.stringify(key)} must be an object mapping non-empty path prefixes to non-empty area labels, got ${JSON.stringify(value)}.`);
    }
    if (key === HIGH_EFFORT_PATHS_KEY) {
        if (!Array.isArray(value) || value.some((el) => typeof el !== 'string' || el.trim().length === 0)) {
            throw new Error(`typed_field_violation: config key ${JSON.stringify(key)} must be an array of non-empty strings, got ${JSON.stringify(value)}.`);
        }
        return;
    }
    if (key === SWE_EFFORT_AB_KEY && !isEffortAbConfig(value)) {
        throw new Error(`typed_field_violation: config key ${JSON.stringify(key)} must be an object {"label": non-empty string, "target": positive integer}, got ${JSON.stringify(value)}.`);
    }
    if (Object.hasOwn(EFFORT_DEFAULTS, key) && !isEffort(value)) {
        throw new Error(`typed_field_violation: config key ${JSON.stringify(key)} must be one of ${EFFORT_LEVELS.join(', ')}, got ${JSON.stringify(value)}.`);
    }
}
export function storedConfigParseErrorPrefix(key) {
    return `config key ${JSON.stringify(key)}: stored value is not valid JSON`;
}
/**
 * Persist one or more shared plugin-config values atomically. Callers remain
 * responsible for exposing only the keys their host contract permits.
 */
export function setConfigValues(db, entries) {
    const serialized = entries.map(({ key, value }) => ({
        key,
        valueJson: serializeConfigValue(key, value),
    }));
    db.transaction(() => {
        for (const { key, valueJson } of serialized) {
            db.run(`INSERT INTO plugin_config (key, value_json)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, [key, valueJson]);
        }
    });
}
/**
 * Read a bounded set of shared plugin-config values from one SQLite statement.
 * A single statement gives callers one database snapshot even when another
 * host process atomically replaces related keys at the same time.
 */
export function getConfigValues(db, keys) {
    if (keys.length === 0)
        return Object.freeze({});
    const placeholders = keys.map(() => '?').join(', ');
    const rows = db.all(`SELECT key, value_json
     FROM plugin_config
     WHERE key IN (${placeholders})`, [...keys]);
    const result = Object.fromEntries(keys.map((key) => [key, null]));
    for (const row of rows) {
        try {
            result[row.key] = JSON.parse(row.value_json);
        }
        catch {
            throw new Error(`${storedConfigParseErrorPrefix(row.key)} — raw: ${row.value_json.slice(0, 200)}`);
        }
    }
    return Object.freeze(result);
}
function serializeConfigValue(key, rawValue) {
    if (typeof key !== 'string' || !KEY_REGEX.test(key)) {
        throw new Error(`Invalid config key ${JSON.stringify(key)}: must match /^[a-z][a-z0-9_.-]{0,63}$/i`);
    }
    if (rawValue === undefined || rawValue === null) {
        throw new Error('Missing required arg: value');
    }
    validateKnownConfigValue(key, rawValue);
    if (typeof rawValue === 'string') {
        const trimmed = rawValue.trim();
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
            (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
            try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'object' && parsed !== null) {
                    throw new Error(`config value for key=${JSON.stringify(key)} looks like a pre-serialized JSON ${Array.isArray(parsed) ? 'array' : 'object'} (passed as a string). Pass the raw value directly — e.g. value=["main"], not value="[\\"main\\"]". The server calls JSON.stringify() on whatever you pass; double-encoding it breaks downstream consumers that expect the original shape.`);
                }
            }
            catch (error) {
                if (error instanceof SyntaxError) {
                    // not valid JSON — fall through, treat as a plain string value
                }
                else {
                    throw error;
                }
            }
        }
    }
    try {
        // Preserve config_set's existing runtime behavior for JSON.stringify
        // inputs whose result is undefined; node:sqlite remains the final binder
        // check for those unsupported values.
        return JSON.stringify(rawValue);
    }
    catch {
        throw new Error('config value not JSON-serializable');
    }
}
export function configTools(db) {
    const definitions = [
        {
            name: 'config_set',
            description: 'Set a plugin config key to a JSON-serializable value.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string', description: 'Config key (1-64 chars, must match /^[a-z][a-z0-9_.-]{0,63}$/i)' },
                    value: { description: 'Any JSON-serializable value' },
                },
                required: ['key', 'value'],
            },
        },
        {
            name: 'config_get',
            description: 'Get a plugin config value by key. Returns null if not set.',
            inputSchema: {
                type: 'object',
                properties: {
                    key: { type: 'string' },
                },
                required: ['key'],
            },
        },
        {
            name: 'config_list',
            description: 'List all plugin config entries as a key→value object.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
    ];
    const handlers = {
        config_set: requireRoles('config_set', ['bro'], wrapHandler(async (args) => {
            const key = args['key'];
            setConfigValues(db, [{ key: key, value: args['value'] }]);
            return ok({ key });
        })),
        config_get: wrapHandler(async (args) => {
            const key = args['key'];
            return ok(getConfigValues(db, [key])[key] ?? null);
        }),
        config_list: wrapHandler(async () => {
            const rows = db.all(`SELECT key, value_json FROM plugin_config ORDER BY key`);
            const result = {};
            for (const row of rows) {
                try {
                    result[row.key] = JSON.parse(row.value_json);
                }
                catch {
                    return err(`${storedConfigParseErrorPrefix(row.key)} — raw: ${row.value_json.slice(0, 200)}`);
                }
            }
            return ok(result);
        }),
    };
    return { definitions, handlers };
}
//# sourceMappingURL=config.js.map