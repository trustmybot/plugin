import { query } from '../lib/snapshot.ts';

export interface ToolInput {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

function ids(sql: string): string[] {
  return query<{ v: string | number }>(sql).map((r) => String(r.v));
}

/** Four real calls per read tool, picked by a fixed rule so a rerun on a newer snapshot picks comparable inputs. */
export function pickInputs(): ToolInput[] {
  const out: ToolInput[] = [];
  const audit = ids(`select issue_id v from audit group by 1 having count(*) between 40 and 300 order by issue_id desc limit 4`);
  for (const issue of audit) out.push({ id: `audit_list:${issue}`, tool: 'audit_list', args: { issue_id: issue } });
  const disc = ids(`select issue_id v from discussions group by 1 having count(*) between 12 and 60 order by issue_id desc limit 4`);
  for (const issue of disc) out.push({ id: `discussion_list:${issue}`, tool: 'discussion_list', args: { issue_id: issue } });
  const val = ids(`select task_id v from validation_attempts group by 1 having count(*) >= 2 order by task_id desc limit 4`);
  for (const task of val) out.push({ id: `validation_history:${task}`, tool: 'validation_history', args: { task_id: task } });
  const tasks = ids(`select id v from tasks where completion_report is not null and completion_report != '' order by id desc limit 4`);
  for (const task of tasks) out.push({ id: `task_get:${task}`, tool: 'task_get', args: { task_id: task } });
  out.push({ id: 'issue_list:default', tool: 'issue_list', args: {} });
  out.push({ id: 'issue_list:open', tool: 'issue_list', args: { status: 'open', limit: 50 } });
  out.push({ id: 'issue_list:closed', tool: 'issue_list', args: { status: 'closed', limit: 50 } });
  out.push({ id: 'issue_list:100', tool: 'issue_list', args: { limit: 100, offset: 50 } });
  for (const [path, depth] of [['', 2], ['mcp/trajectory-server/src', 1], ['hooks', 2], ['dashboard', 2]] as const) {
    out.push({ id: `world_model_get:${path || 'root'}`, tool: 'world_model_get', args: { repo: 'plugin', path, depth } });
  }
  return out;
}
