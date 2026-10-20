export function demo(insertAudit: (e: Record<string, unknown>) => void): void {
  insertAudit({ issue_id: -1, from_node: 'bro', event_type: 'demo_event', summary: 's' });
}
