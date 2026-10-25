import { query, type WmNode } from '../../api.ts';

export const dirName = (node: WmNode) => (node.path === '' ? node.repo : node.path.split('/').pop()!);

export const ancestors = (path: string) => {
  const parts = path === '' ? [] : path.split('/');
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
};

export const childrenPath = (repo: string, path: string) => `world-model?${query({ repo, path, depth: '1' })}`;

export const childrenOf = (nodes: WmNode[], path: string) => nodes.filter((n) => n.parent_path === path && n.path !== path);
