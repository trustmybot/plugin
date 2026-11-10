export function extraHook(insertAudit: (e: Record<string, unknown>) => void): void {
  insertAudit({ issue_id: -1, from_node: 'hook:extra', event_type: 'ghost_event', summary: 'summary' });
}
