import { posix } from 'node:path';
import type { FileRegistryRow } from '../types.js';

const DEFAULT_LANGUAGES = ['ts', 'tsx', 'js', 'jsx'];

function slugify(p: string): string {
  return 'n_' + p.replace(/[^A-Za-z0-9_]/g, '_');
}

function externalPackageRoot(importPath: string): string {
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/');
    return parts.slice(0, 2).join('/');
  }
  return importPath.split('/')[0];
}

function extPackageId(pkg: string): string {
  return `ext_${pkg.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function resolveRelativeImport(importerPath: string, importTarget: string): string {
  const dir = posix.dirname(importerPath);
  return posix.normalize(posix.join(dir, importTarget));
}

function isRelativeImport(importPath: string): boolean {
  return importPath.startsWith('./') || importPath.startsWith('../');
}

export function renderModuleGraph(
  rows: FileRegistryRow[],
  opts: { generatedAt: string; languages?: string[] },
): string {
  const languages = opts.languages ?? DEFAULT_LANGUAGES;
  const langSet = new Set(languages);

  const header = `<!-- Auto-rendered ${opts.generatedAt}. Do not edit. -->`;

  const filtered = rows.filter(r => r.type === 'source' && r.language !== null && langSet.has(r.language));

  if (rows.length > 0 && filtered.length === 0) {
    return [
      header,
      '',
      '# Module Graph',
      '',
      'no TS/JS modules indexed',
      '',
    ].join('\n');
  }

  const pathSet = new Set(filtered.map(r => r.path));

  interface Edge {
    fromId: string;
    toId: string;
  }

  const nodes = new Map<string, string>();
  const externalPkgs = new Map<string, string>();
  const edges: Edge[] = [];
  const danglingLines: string[] = [];
  const edgeSeen = new Set<string>();

  for (const row of filtered) {
    const nodeId = slugify(row.path);
    nodes.set(nodeId, row.path);

    let imports: string[];
    try {
      imports = JSON.parse(row.imports_json);
      if (!Array.isArray(imports)) imports = [];
    } catch {
      imports = [];
    }

    for (const imp of imports) {
      if (typeof imp !== 'string' || imp.length === 0) continue;

      if (isRelativeImport(imp)) {
        const resolved = resolveRelativeImport(row.path, imp);
        const targetId = slugify(resolved);
        const edgeKey = `${nodeId}->${targetId}`;
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          edges.push({ fromId: nodeId, toId: targetId });
          if (!pathSet.has(resolved)) {
            nodes.set(targetId, resolved);
            danglingLines.push(`- \`${row.path}\` → \`${imp}\` (not in registry)`);
          }
        }
      } else {
        const pkg = externalPackageRoot(imp);
        const extId = extPackageId(pkg);
        externalPkgs.set(extId, pkg);
        const edgeKey = `${nodeId}->${extId}`;
        if (!edgeSeen.has(edgeKey)) {
          edgeSeen.add(edgeKey);
          edges.push({ fromId: nodeId, toId: extId });
        }
      }
    }
  }

  const sortedNodes = [...nodes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const sortedEdges = [...edges].sort((a, b) => {
    const cmp = a.fromId.localeCompare(b.fromId);
    return cmp !== 0 ? cmp : a.toId.localeCompare(b.toId);
  });
  const sortedExtPkgs = [...externalPkgs.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const moduleCount = filtered.length;
  const edgeCount = sortedEdges.length;
  const extPkgCount = sortedExtPkgs.length;

  const edgeSummary = extPkgCount > 0
    ? `Edges: ${edgeCount} (${extPkgCount} external package${extPkgCount === 1 ? '' : 's'})`
    : `Edges: ${edgeCount}`;

  const mermaidLines: string[] = ['graph LR'];

  if (sortedExtPkgs.length > 0) {
    mermaidLines.push('    subgraph external');
    for (const [extId, pkg] of sortedExtPkgs) {
      mermaidLines.push(`        ${extId}["${pkg}"]`);
    }
    mermaidLines.push('    end');
  }

  for (const [nodeId, label] of sortedNodes) {
    if (!externalPkgs.has(nodeId)) {
      mermaidLines.push(`    ${nodeId}["${label}"]`);
    }
  }

  for (const edge of sortedEdges) {
    mermaidLines.push(`    ${edge.fromId} --> ${edge.toId}`);
  }

  const lines: string[] = [
    header,
    '',
    '# Module Graph',
    '',
    `Languages: ${languages.join(', ')}`,
    `Modules: ${moduleCount}`,
    edgeSummary,
    '',
    '```mermaid',
    ...mermaidLines,
    '```',
  ];

  if (danglingLines.length > 0) {
    lines.push('');
    lines.push('## Dangling imports');
    lines.push('');
    for (const dl of danglingLines.sort()) {
      lines.push(dl);
    }
  }

  lines.push('');
  return lines.join('\n');
}
