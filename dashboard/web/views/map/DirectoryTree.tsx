import { FileDirectoryFillIcon, FileDirectoryOpenFillIcon } from '@primer/octicons-react';
import { useApi, type WmNode, type WorldModel } from '../../api.ts';
import { TreeView, TreeViewItem } from '../../ui/TreeView.tsx';
import { childrenOf, childrenPath, dirName } from './paths.ts';

type TreeState = {
  selected: string;
  expanded: ReadonlySet<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
};

const ICON = 'text-(--treeViewItem-leadingVisual-iconColor-rest,var(--fgColor-accent))';

export function DirectoryTree({ root, ...state }: TreeState & { root: WmNode }) {
  return (
    <TreeView label={`Directories in ${root.repo}`}>
      <DirNode node={root} level={1} {...state} />
    </TreeView>
  );
}

function DirNode({ node, level, ...state }: TreeState & { node: WmNode; level: number }) {
  const open = state.expanded.has(node.path);
  const Icon = open ? FileDirectoryOpenFillIcon : FileDirectoryFillIcon;
  return (
    <TreeViewItem
      level={level}
      label={dirName(node)}
      current={state.selected === node.path}
      expanded={open}
      leadingVisual={<Icon size={16} className={ICON} />}
      onSelect={() => state.onSelect(node.path)}
      onToggle={() => state.onToggle(node.path)}
    >
      <DirChildren node={node} level={level + 1} {...state} />
    </TreeViewItem>
  );
}

function DirChildren({ node, level, ...state }: TreeState & { node: WmNode; level: number }) {
  const q = useApi<WorldModel>(childrenPath(node.repo, node.path));
  const note = (text: string) => (
    <li role="none" className="py-1 text-xs text-fg-muted" style={{ paddingLeft: `${level * 16 + 4}px` }}>
      {text}
    </li>
  );
  if (q.error) return note(q.error.message);
  if (q.data === undefined) return note('Loading…');
  const kids = childrenOf(q.data.nodes, node.path);
  if (kids.length === 0) return note('No subdirectories.');
  return <>{kids.map((c) => <DirNode key={c.path} node={c} level={level} {...state} />)}</>;
}
