// bug_report_draft: bro drafts a consent-gated, redacted TMB bug report from the DB and process; it never files anything.
import os from 'node:os';
import { basename } from 'node:path';
import { resolvePluginVersion } from '../db.js';
import { claudeProjectRootOfDb, resolveClaudeProjectRoot } from '../platform.js';
import { requireRoles } from '../middleware/agent-scope.js';
import { AREA_OPTIONS, FREQUENCY_OPTIONS, IMPACT_OPTIONS } from '../bug-report/form.js';
import { redactFields, render } from '../bug-report/render.js';
export const ERROR_CLASSES = ['constraint', 'internal', 'server_died', 'doctor', 'hook_deny', 'user_reported'];
export const CLIENTS = ['cli', 'desktop', 'ide'];
export const SESSIONS = ['worktree', 'main checkout'];
const REQUIRED_TEXT = ['tool', 'error', 'summary', 'what_happened', 'reproduce'];
const HOOK_TOOL_RE = /^hook:/;
const HOOK_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+(?:\.(?:sh|ts|mjs))?$/;
const CONSENT_REFUSAL = "bug_report_consent is not 'yes': bro may draft a TMB bug report only after the Human opts in through /onboard " +
    "(or onboard_apply(bug_report_consent='yes') on an onboarded project), or when the Human asked for this report (user_asked: true)";
function ok(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function err(message, extra = {}) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: message, ...extra }) }], isError: true };
}
export function defaultArea(tool) {
    if (tool.startsWith('world_model_') || tool === 'scan_run')
        return 'World Model';
    if (tool.startsWith('cheatcode_'))
        return 'Cheatcode';
    if (HOOK_TOOL_RE.test(tool) || HOOK_NAME_RE.test(tool))
        return 'Hooks';
    return 'Trajectory Server';
}
export function versionChannel(version) {
    if (!version)
        return 'unknown';
    if (/-dev\b/.test(version))
        return 'dev';
    if (/-rc\b/.test(version))
        return 'rc';
    return 'stable';
}
function readConfig(db, key) {
    const row = db.get(`SELECT value_json FROM plugin_config WHERE key = ?`, [key]);
    if (!row?.value_json)
        return null;
    try {
        return JSON.parse(row.value_json);
    }
    catch {
        return null;
    }
}
function column(db, sql) {
    return db
        .all(sql)
        .map((r) => (typeof r.v === 'string' ? r.v.trim() : ''))
        .filter((v) => v.length > 0);
}
function projectRoot(db, env) {
    return claudeProjectRootOfDb(db.dbPath) ?? resolveClaudeProjectRoot(env) ?? process.cwd();
}
export function redactContext(db, home, root) {
    const repoPaths = column(db, `SELECT path AS v FROM repos`);
    return {
        home,
        projectRoot: root,
        remoteUrls: column(db, `SELECT url AS v FROM repo_remotes`),
        repoNames: [...new Set([...column(db, `SELECT name AS v FROM repos`), ...repoPaths, ...repoPaths.map((p) => basename(p))])],
        branchNames: column(db, `SELECT branch_id AS v FROM tasks
       UNION SELECT parent_branch_id FROM tasks
       UNION SELECT target_branch FROM repos`),
        titles: column(db, `SELECT objective AS v FROM issues UNION SELECT title FROM tasks`),
    };
}
function projectShape(db) {
    const repos = db.get(`SELECT COUNT(*) AS n FROM repos`)?.n ?? 0;
    const remotes = db.get(`SELECT COUNT(*) AS n FROM repo_remotes`)?.n ?? 0;
    const shape = remotes > 0 ? 'remote' : 'local';
    return repos > 1 ? `${shape}, ${repos} repos` : shape;
}
function branching(db) {
    const models = column(db, `SELECT DISTINCT branching_model AS v FROM repos ORDER BY branching_model`);
    return models.length > 0 ? models.join(', ') : 'unknown';
}
function environment(db, args, env) {
    const version = resolvePluginVersion(env);
    const ccVersion = typeof args['claude_code_version'] === 'string' && args['claude_code_version'].trim()
        ? args['claude_code_version'].trim()
        : 'unknown';
    const client = typeof args['client'] === 'string' ? ` (${args['client']})` : '';
    const shell = env['SHELL'] ? basename(env['SHELL']) : 'unknown';
    return {
        tmb: version ?? 'unknown',
        channel: versionChannel(version),
        'claude-code': ccVersion + client,
        os: `${os.platform()} ${os.release()} ${os.arch()}`,
        shell,
        node: process.version,
        'project-shape': projectShape(db),
        branching: branching(db),
        'issue-sync': String(readConfig(db, 'issue_sync') ?? 'off'),
        session: typeof args['session'] === 'string' ? args['session'] : 'unknown',
        sandbox: String(readConfig(db, 'sandbox_enforcement') ?? 'no'),
        'reported-by': 'bro',
    };
}
export function alreadyFiled(db, signature) {
    const row = db.get(`SELECT json_extract(content_json, '$.url') AS url, json_extract(content_json, '$.mode') AS mode, created_at
       FROM audit
      WHERE event_type = 'bug_report_filed'
        AND CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.signature') END = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`, [signature]);
    if (!row)
        return null;
    return {
        url: typeof row.url === 'string' ? row.url : null,
        mode: typeof row.mode === 'string' ? row.mode : null,
        created_at: row.created_at,
    };
}
function oneOf(args, name, allowed, required) {
    const value = args[name];
    if (value === undefined || value === null) {
        if (required)
            throw new Error(`Missing required arg: ${name}`);
        return null;
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
        throw new Error(`${name} must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
    }
    return value;
}
function optionalText(args, name) {
    const value = args[name];
    if (value === undefined || value === null)
        return '';
    if (typeof value !== 'string')
        throw new Error(`${name} must be a string`);
    return value;
}
function doctorText(raw) {
    if (raw === undefined || raw === null)
        return '';
    if (!Array.isArray(raw))
        throw new Error('doctor_violations must be an array of {name, count}');
    return raw
        .map((v) => {
        const item = v;
        if (typeof item?.name !== 'string' || typeof item.count !== 'number') {
            throw new Error('doctor_violations must be an array of {name, count}');
        }
        return `${item.name}: ${item.count}`;
    })
        .join('\n');
}
function reproduceText(reproduce, tool, toolArgs) {
    if (toolArgs === undefined || toolArgs === null)
        return reproduce;
    if (typeof toolArgs !== 'object' || Array.isArray(toolArgs))
        throw new Error('args must be an object');
    return `${reproduce}\n\nArgs passed to \`${tool}\`:\n\n\`\`\`json\n${JSON.stringify(toolArgs, null, 2)}\n\`\`\``;
}
export function buildInput(args) {
    for (const name of REQUIRED_TEXT) {
        const value = args[name];
        if (typeof value !== 'string' || value.trim().length === 0)
            throw new Error(`Missing required arg: ${name}`);
    }
    const tool = args['tool'].trim();
    const errorClass = oneOf(args, 'error_class', ERROR_CLASSES, true);
    const frequency = oneOf(args, 'frequency', FREQUENCY_OPTIONS, true);
    const impact = oneOf(args, 'impact', IMPACT_OPTIONS, true);
    const area = oneOf(args, 'area', AREA_OPTIONS, false) ?? defaultArea(tool);
    oneOf(args, 'client', CLIENTS, false);
    oneOf(args, 'session', SESSIONS, false);
    return {
        tool,
        error_class: errorClass,
        summary: args['summary'],
        'what-happened': args['what_happened'],
        reproduce: reproduceText(args['reproduce'], tool, args['args']),
        'repro-script': optionalText(args, 'repro_script'),
        frequency,
        error: args['error'],
        area,
        impact,
        doctor: doctorText(args['doctor_violations']),
        workaround: optionalText(args, 'workaround'),
    };
}
export function bugReportTools(db, opts = {}) {
    const definitions = [
        {
            name: 'bug_report_draft',
            description: "Draft a redacted TMB bug report for github.com/trustmybot/plugin; files nothing. Refused unless bug_report_consent is 'yes' or user_asked. already_filed: {url, mode, created_at} of the newest bug_report_filed audit row with this signature, else null.",
            inputSchema: {
                type: 'object',
                properties: {
                    agent: { type: 'string' },
                    tool: { type: 'string', description: "Required. The failing tool, or a hook as hook:<name> or its kebab-case name." },
                    error: { type: 'string', description: 'Required. The error message, verbatim.' },
                    error_class: { type: 'string', enum: [...ERROR_CLASSES], description: 'Required. How the failure surfaced.' },
                    summary: { type: 'string', description: 'Required. One line: what broke.' },
                    what_happened: { type: 'string', description: 'Required. Expected vs actual.' },
                    reproduce: { type: 'string', description: 'Required. Steps to reproduce.' },
                    frequency: { type: 'string', enum: [...FREQUENCY_OPTIONS], description: 'Required.' },
                    impact: { type: 'string', enum: [...IMPACT_OPTIONS], description: 'Required.' },
                    args: { type: 'object', description: 'Optional. The failing call\'s arguments; rendered as JSON under the steps, then redacted.' },
                    repro_script: { type: 'string', description: 'Optional. A minimal shell repro.' },
                    area: { type: 'string', enum: [...AREA_OPTIONS], description: 'Optional. Default from tool: world_model_* / scan_run → World Model, cheatcode_* → Cheatcode, a hook → Hooks, else Trajectory Server.' },
                    workaround: { type: 'string', description: 'Optional.' },
                    doctor_violations: {
                        type: 'array',
                        items: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } }, required: ['name', 'count'] },
                        description: 'Optional. trajectory_doctor violations as {name, count}.',
                    },
                    claude_code_version: { type: 'string', description: "Optional. Claude Code's version; 'unknown' when absent." },
                    client: { type: 'string', enum: [...CLIENTS], description: 'Optional. The Claude Code client.' },
                    session: { type: 'string', enum: [...SESSIONS], description: 'Optional. Where bro runs.' },
                    user_asked: { type: 'boolean', description: 'Optional. True only when the Human asked for this report; admits a draft without bug_report_consent.' },
                },
                required: ['agent', 'tool', 'error', 'error_class', 'summary', 'what_happened', 'reproduce', 'frequency', 'impact'],
            },
        },
    ];
    const handler = async (args) => {
        const env = opts.env ?? process.env;
        const stored = readConfig(db, 'bug_report_consent');
        const userAsked = args['user_asked'] === true;
        if (stored !== 'yes' && !userAsked) {
            return err(CONSENT_REFUSAL, { reason: 'bug_report_consent_required', bug_report_consent: stored ?? 'unset' });
        }
        try {
            const input = buildInput(args);
            const reportEnv = environment(db, args, env);
            const ctx = redactContext(db, opts.home ?? os.homedir(), projectRoot(db, env));
            const report = render(input, reportEnv, ctx);
            return ok({
                ...report,
                consent: stored === 'yes' ? 'yes' : 'user_asked',
                redactions: redactFields(input, reportEnv, ctx).counts,
                already_filed: alreadyFiled(db, report.signature),
            });
        }
        catch (e) {
            return err(e.message);
        }
    };
    return { definitions, handlers: { bug_report_draft: requireRoles('bug_report_draft', ['bro'], handler) } };
}
//# sourceMappingURL=bug-report.js.map