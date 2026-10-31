export function writer(fromNode: string): string {
  if (fromNode.startsWith('hook:')) return 'hook';
  return 'hook:' + fromNode;
}
