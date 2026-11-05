export function fromNodeValid(fromNode: string): boolean {
  return fromNode === 'system' || /^hook:[a-z0-9-]+$/.test(fromNode);
}
