import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { TrajectoryDB } from '../db.js';
import { nowISO } from '../db.js';

type Fn = (args: Record<string, unknown>) => Promise<CallToolResult>;

const VALID_TRUST_TIERS = new Set(['curated', 'agent']);

// Skill name must be kebab-case: starts with a lowercase letter, followed by
// lowercase letters, digits, or hyphens, max 64 chars total. The tmb_ prefix
// (with underscore, not hyphen) is reserved for plugin-shipped skills registered
// at scope='global'; user-created skills at scope='project-local' or 'template'
// must not use it to avoid confusion with the canonical plugin catalog.
const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

const VALID_STATUS_TRANSITIONS = new Map<string, Set<string>>([
  ['draft', new Set(['pending_review'])],
  ['pending_review', new Set(['active'])],
  ['active', new Set(['deprecated'])],
]);

const VALID_TIER_TRANSITIONS = new Map<string, Set<string>>([
  ['agent', new Set(['curated'])],
]);

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function err(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function requireArg(args: Record<string, unknown>, name: string): unknown {
  if (args[name] === undefined || args[name] === null) {
    throw new Error(`Missing required arg: ${name}`);
  }
  return args[name];
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

const VALID_SCOPES = new Set(['global', 'template', 'project-local']);
const VALID_INVOCATION_OUTCOMES = new Set(['completed', 'failed', 'partial']);

interface Skill {
  id: number;
  name: string;
  description: string;
  file_path: string;
  scope: string;
  trust_tier: string;
  status: string;
  uses: number;
  successes: number;
  effectiveness: number | null;
  created_at: string;
  updated_at: string;
}

export function skillTools(db: TrajectoryDB): {
  definitions: Tool[];
  handlers: Record<string, Fn>;
} {
  const definitions: Tool[] = [
    {
      name: 'skill_register',
      description: 'Register a new skill. Status defaults to draft. Scope defaults to project-local (the common case for tmb_skill-creator output); plugin-shipped skills are schema-seeded with scope=global.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          file_path: { type: 'string' },
          trust_tier: { type: 'string', enum: ['curated', 'agent'] },
          scope: {
            type: 'string',
            enum: ['global', 'template', 'project-local'],
            description: 'Defaults to project-local.',
          },
        },
        required: ['agent', 'name', 'description', 'file_path', 'trust_tier'],
      },
    },
    {
      name: 'skill_record_invocation',
      description:
        'Record one skill load — bridges the catalog (skills) to the agent_run that invoked it. Writes one row to skill_invocations. agent_run_id and task_id are optional (free-floating invocations during onboarding etc.).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          skill_name: { type: 'string', description: 'Must reference an existing skills.name.' },
          agent_name: { type: 'string', description: 'bro / swe / pr-reviewer / consultant name.' },
          agent_run_id: { type: 'integer', description: 'Optional agent_runs.id this invocation belongs to.' },
          task_id: { type: 'integer', description: 'Optional tasks.id when scoped to a specific task.' },
          outcome: {
            type: 'string',
            enum: ['completed', 'failed', 'partial'],
            description: 'Defaults to completed.',
          },
        },
        required: ['agent', 'skill_name', 'agent_name'],
      },
    },
    {
      name: 'skill_invocations_list',
      description:
        'List skill_invocations rows. Bidirectional: filter by skill_name (which agent_runs used skill X?) or by agent_run_id/task_id (what did this run/task touch?).',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          skill_name: { type: 'string' },
          agent_run_id: { type: 'integer' },
          task_id: { type: 'integer' },
          limit: { type: 'integer', description: 'Default 200, max 1000.' },
        },
      },
    },
    {
      name: 'skill_record_outcome',
      description: 'Record a success or failure outcome for a skill, updating effectiveness.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          name: { type: 'string' },
          success: { type: 'boolean' },
        },
        required: ['agent', 'name', 'success'],
      },
    },
    {
      name: 'skill_promote',
      description: 'Promote or deprecate a skill status or trust_tier.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          name: { type: 'string' },
          from_status: { type: 'string' },
          to_status: { type: 'string' },
        },
        required: ['agent', 'name', 'from_status', 'to_status'],
      },
    },
  ];

  const handlers: Record<string, Fn> = {
    skill_register: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const name = requireArg(args, 'name') as string;
      const description = requireArg(args, 'description') as string;
      const filePath = requireArg(args, 'file_path') as string;
      const trustTier = requireArg(args, 'trust_tier') as string;
      const scope = (args['scope'] as string | undefined) ?? 'project-local';

      if (!VALID_TRUST_TIERS.has(trustTier)) {
        throw new Error(
          `Invalid trust_tier: "${trustTier}". Allowed values: ${[...VALID_TRUST_TIERS].join(', ')}`,
        );
      }
      if (!VALID_SCOPES.has(scope)) {
        throw new Error(
          `Invalid scope: "${scope}". Allowed values: ${[...VALID_SCOPES].join(', ')}`,
        );
      }

      if (!SKILL_NAME_RE.test(name)) {
        throw new Error(
          `skill_register rejected: invalid name "${name}". ` +
          `Skill names must match ^[a-z][a-z0-9-]{0,63}$ — ` +
          `lowercase letters, digits, and hyphens only, starting with a letter, max 64 chars. ` +
          `Examples: my-skill, data-export-v2.`,
        );
      }
      if (name.startsWith('tmb_') && scope !== 'global') {
        throw new Error(
          `skill_register rejected: the 'tmb_' prefix is reserved for plugin-shipped global skills. ` +
          `Rename your skill (e.g. replace 'tmb_' with your project prefix) or set scope='global' ` +
          `if you are contributing an official plugin skill.`,
        );
      }

      const now = nowISO();

      db.run(
        `INSERT INTO skills
           (name, description, file_path, scope, trust_tier, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
        [name, description, filePath, scope, trustTier, now, now],
      );

      const row = db.get<Skill>('SELECT * FROM skills WHERE rowid = last_insert_rowid()');
      return ok(row);
    }),

    skill_record_invocation: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const skillName = requireArg(args, 'skill_name') as string;
      const agentName = requireArg(args, 'agent_name') as string;
      const agentRunId = args['agent_run_id'] === undefined || args['agent_run_id'] === null
        ? null
        : Number(args['agent_run_id']);
      const taskId = args['task_id'] === undefined || args['task_id'] === null
        ? null
        : Number(args['task_id']);
      const outcome = (args['outcome'] as string | undefined) ?? 'completed';

      if (!VALID_INVOCATION_OUTCOMES.has(outcome)) {
        throw new Error(
          `Invalid outcome: "${outcome}". Allowed values: ${[...VALID_INVOCATION_OUTCOMES].join(', ')}`,
        );
      }
      if (agentRunId !== null && !Number.isInteger(agentRunId)) {
        throw new Error('agent_run_id must be an integer when provided');
      }
      if (taskId !== null && !Number.isInteger(taskId)) {
        throw new Error('task_id must be an integer when provided');
      }

      const skill = db.get<{ name: string }>('SELECT name FROM skills WHERE name = ?', [skillName]);
      if (!skill) {
        throw new Error(`Skill not registered: ${skillName}`);
      }

      const now = nowISO();
      db.run(
        `INSERT INTO skill_invocations
           (skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [skillName, agentName, agentRunId, taskId, now, outcome],
      );

      const row = db.get<Record<string, unknown>>(
        'SELECT * FROM skill_invocations WHERE rowid = last_insert_rowid()',
      );
      return ok(row);
    }),

    skill_invocations_list: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const filters: string[] = [];
      const params: unknown[] = [];
      if (typeof args['skill_name'] === 'string') {
        filters.push('skill_name = ?');
        params.push(args['skill_name']);
      }
      if (args['agent_run_id'] !== undefined && args['agent_run_id'] !== null) {
        filters.push('agent_run_id = ?');
        params.push(Number(args['agent_run_id']));
      }
      if (args['task_id'] !== undefined && args['task_id'] !== null) {
        filters.push('task_id = ?');
        params.push(Number(args['task_id']));
      }
      const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
      const limit = Math.min(Math.max(1, Number(args['limit'] ?? 200)), 1000);
      params.push(limit);

      const rows = db.all<Record<string, unknown>>(
        `SELECT id, skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome
           FROM skill_invocations
           ${where}
           ORDER BY id DESC
           LIMIT ?`,
        params,
      );
      return ok({ rows, count: rows.length });
    }),

    skill_record_outcome: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const name = requireArg(args, 'name') as string;
      requireArg(args, 'success');
      const success = args['success'] as boolean;

      const updated = db.transaction(() => {
        const skill = db.get<Skill>('SELECT * FROM skills WHERE name = ?', [name]);
        if (!skill) {
          throw new Error(`Skill not registered: ${name}`);
        }

        const now = nowISO();
        const newUses = skill.uses + 1;
        const newSuccesses = skill.successes + (success ? 1 : 0);
        const newEffectiveness = newSuccesses / newUses;

        db.run(
          `UPDATE skills
           SET uses = ?, successes = ?, effectiveness = ?, updated_at = ?
           WHERE name = ?`,
          [newUses, newSuccesses, newEffectiveness, now, name],
        );

        return db.get<Skill>('SELECT * FROM skills WHERE name = ?', [name]);
      });

      return ok(updated);
    }),

    skill_promote: wrapHandler(async (args) => {
      requireArg(args, 'agent');
      const name = requireArg(args, 'name') as string;
      const fromStatus = requireArg(args, 'from_status') as string;
      const toStatus = requireArg(args, 'to_status') as string;

      const skill = db.get<Skill>('SELECT * FROM skills WHERE name = ?', [name]);
      if (!skill) {
        throw new Error(`Skill not registered: ${name}`);
      }

      const isStatusTransition = VALID_STATUS_TRANSITIONS.get(fromStatus)?.has(toStatus) ?? false;
      const isTierTransition = VALID_TIER_TRANSITIONS.get(fromStatus)?.has(toStatus) ?? false;

      if (!isStatusTransition && !isTierTransition) {
        throw new Error(`Invalid transition: ${fromStatus}→${toStatus}`);
      }

      if (isStatusTransition && skill.status !== fromStatus) {
        throw new Error(
          `skill_promote rejected: skill '${name}' is in status '${skill.status}', not '${fromStatus}'. ` +
          `from_status must match the skill's current status.`
        );
      }

      if (isTierTransition && skill.trust_tier !== fromStatus) {
        throw new Error(
          `skill_promote rejected: skill '${name}' has trust_tier '${skill.trust_tier}', not '${fromStatus}'. ` +
          `from_status must match the skill's current trust_tier for tier transitions.`
        );
      }

      const now = nowISO();

      if (isStatusTransition) {
        db.run(
          `UPDATE skills SET status = ?, updated_at = ? WHERE name = ?`,
          [toStatus, now, name],
        );
      } else {
        db.run(
          `UPDATE skills SET trust_tier = ?, updated_at = ? WHERE name = ?`,
          [toStatus, now, name],
        );
      }

      const updated = db.get<Skill>('SELECT * FROM skills WHERE name = ?', [name]);
      return ok(updated);
    }),
  };

  return { definitions, handlers };
}
