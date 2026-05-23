import { discussionTools } from './discussions.js';
import { issueTools } from './issues.js';
import { taskTools } from './tasks.js';
import { auditTools } from './audit.js';
import { validationTools } from './validation.js';
import { skillTools } from './skills.js';
import { ruleTools } from './rules.js';
import { commandTools } from './commands.js';
import { agentTools } from './agents.js';
import { reportTools } from './reports.js';
import { configTools } from './config.js';
import { branchReportMdTools } from './branch_report_md.js';
import { statsTools } from './stats.js';
import { roundtableTools } from './roundtable.js';
import { prCommentsTools } from './pr_comments.js';
import { compositeTools } from './composites.js';
import { onboardTools } from './onboard.js';
import { scanTools } from './scan.js';
import { worldModelTools } from './world-model.js';
export let toolDefinitions = [];
export let toolHandlers = {};
function decorateWithAgent(tools) {
    return tools.map((t) => ({
        ...t,
        inputSchema: {
            ...t.inputSchema,
            properties: {
                ...(t.inputSchema.properties ?? {}),
                agent: {
                    type: 'string',
                    pattern: '^[a-z][a-z0-9_-]*$',
                    description: "Calling agent identity. First-class roles: bro, swe, pr-reviewer. Any other valid name is treated as consultant.",
                },
            },
        },
    }));
}
export function registerTools(server, db, dbPath = '') {
    const discussions = discussionTools(db);
    const issues = issueTools(db, dbPath);
    const tasks = taskTools(db);
    const audit = auditTools(db);
    const validation = validationTools(db);
    const skills = skillTools(db);
    const rules = ruleTools(db);
    const commands = commandTools(db);
    const agents = agentTools(db);
    const reports = reportTools(db);
    const config = configTools(db);
    const branchReport = branchReportMdTools(db);
    const stats = statsTools(db);
    const roundtable = roundtableTools(db);
    const prComments = prCommentsTools(db);
    const composites = compositeTools(db, dbPath);
    const onboard = onboardTools(db, dbPath);
    const scan = scanTools(db);
    const worldModel = worldModelTools(db);
    toolDefinitions = decorateWithAgent([
        ...discussions.definitions,
        ...issues.definitions,
        ...tasks.definitions,
        ...audit.definitions,
        ...validation.definitions,
        ...skills.definitions,
        ...rules.definitions,
        ...commands.definitions,
        ...agents.definitions,
        ...reports.definitions,
        ...config.definitions,
        ...branchReport.definitions,
        ...stats.definitions,
        ...roundtable.definitions,
        ...prComments.definitions,
        ...composites.definitions,
        ...onboard.definitions,
        ...scan.definitions,
        ...worldModel.definitions,
    ]);
    toolHandlers = {
        ...discussions.handlers,
        ...issues.handlers,
        ...tasks.handlers,
        ...audit.handlers,
        ...validation.handlers,
        ...skills.handlers,
        ...rules.handlers,
        ...commands.handlers,
        ...agents.handlers,
        ...reports.handlers,
        ...config.handlers,
        ...branchReport.handlers,
        ...stats.handlers,
        ...roundtable.handlers,
        ...prComments.handlers,
        ...composites.handlers,
        ...onboard.handlers,
        ...scan.handlers,
        ...worldModel.handlers,
    };
}
//# sourceMappingURL=index.js.map