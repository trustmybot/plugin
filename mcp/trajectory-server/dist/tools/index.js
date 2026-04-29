import { discussionTools } from './discussions.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { ledgerTools } from './ledger.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { reportTools } from './reports.js';
import { configTools } from './config.js';
import { identityTools } from './identity.js';
import { regenStateTools } from './regen-state.js';
import { fileRegistryTools } from './file-registry.js';
import { architectureRegenTools } from './architecture-regen.js';
import { branchReportMdTools } from './branch_report_md.js';
import { withAgentScope } from '../middleware/agent-scope.js';
export let toolDefinitions = [];
export let toolHandlers = {};
function wrapAll(handlers) {
    return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, withAgentScope(name, handler)]));
}
function decorateWithAgent(tools) {
    return tools.map((t) => ({
        ...t,
        inputSchema: {
            ...t.inputSchema,
            properties: {
                ...(t.inputSchema.properties ?? {}),
                agent: {
                    type: 'string',
                    enum: ['bro', 'architect', 'swe', 'pr-reviewer'],
                    description: "Calling agent identity. Required for role-enforced writes (identity_set, config_set, task_update_status, validation_record, etc.). Must match the spawning agent's role.",
                },
            },
        },
    }));
}
export function registerTools(server, db) {
    const discussions = discussionTools(db);
    const issues = issueTools(db);
    const tasks = taskTools(db);
    const ledger = ledgerTools(db);
    const audit = auditTools(db);
    const validation = validationTools(db);
    const skills = skillTools(db);
    const reports = reportTools(db);
    const config = configTools(db);
    const identity = identityTools(db);
    const regenState = regenStateTools(db);
    const fileRegistry = fileRegistryTools(db);
    const architectureRegen = architectureRegenTools(db);
    const branchReport = branchReportMdTools(db);
    toolDefinitions = decorateWithAgent([
        ...discussions.definitions,
        ...issues.definitions,
        ...tasks.definitions,
        ...ledger.definitions,
        ...audit.definitions,
        ...validation.definitions,
        ...skills.definitions,
        ...reports.definitions,
        ...config.definitions,
        ...identity.definitions,
        ...regenState.definitions,
        ...fileRegistry.definitions,
        ...architectureRegen.definitions,
        ...branchReport.definitions,
    ]);
    toolHandlers = {
        ...wrapAll(discussions.handlers),
        ...wrapAll(issues.handlers),
        ...wrapAll(tasks.handlers),
        ...wrapAll(ledger.handlers),
        ...wrapAll(audit.handlers),
        ...wrapAll(validation.handlers),
        ...wrapAll(skills.handlers),
        ...wrapAll(reports.handlers),
        ...wrapAll(config.handlers),
        ...wrapAll(identity.handlers),
        ...wrapAll(regenState.handlers),
        ...wrapAll(fileRegistry.handlers),
        ...wrapAll(architectureRegen.handlers),
        ...wrapAll(branchReport.handlers),
    };
}
//# sourceMappingURL=index.js.map