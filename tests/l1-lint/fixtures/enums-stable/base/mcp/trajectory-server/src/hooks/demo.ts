export function demoHook(insertAudit: (e: Record<string, unknown>) => void): void {
  insertAudit({ issue_id: -1, from_node: 'hook:demo', event_type: 'hook_event', summary: 'summary' });
}
