function buildTree(rows) {
    const root = { name: '', fullPath: '', children: new Map(), file: null };
    for (const row of rows) {
        const parts = row.path.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!node.children.has(part)) {
                const fullPath = parts.slice(0, i + 1).join('/') + '/';
                node.children.set(part, { name: part, fullPath, children: new Map(), file: null });
            }
            node = node.children.get(part);
        }
        const filename = parts[parts.length - 1];
        if (!node.children.has(filename)) {
            node.children.set(filename, { name: filename, fullPath: row.path, children: new Map(), file: row });
        }
        else {
            node.children.get(filename).file = row;
        }
    }
    return root;
}
function isDirectoryNode(node) {
    return node.file === null && node.children.size > 0;
}
function hasSingleChildDir(node) {
    if (node.children.size !== 1)
        return false;
    const [child] = node.children.values();
    return isDirectoryNode(child);
}
function collapseNode(node) {
    let displayName = node.name;
    let target = node;
    while (hasSingleChildDir(target)) {
        const [child] = target.children.values();
        displayName = displayName + '/' + child.name;
        target = child;
    }
    return { displayName, target };
}
function maxFilenameWidth(node) {
    let max = 0;
    for (const child of node.children.values()) {
        if (child.file !== null) {
            max = Math.max(max, child.name.length);
        }
    }
    return max;
}
function paddingWidth(maxLen) {
    const MIN_PADDING = 2;
    const COLUMN = 40;
    const needed = Math.max(MIN_PADDING, COLUMN - maxLen);
    const boundary = Math.ceil(needed / 4) * 4;
    return Math.min(boundary, needed + 4);
}
function formatAnnotation(row) {
    if (row.language !== null && row.language !== '') {
        return `(${row.type}, ${row.language})`;
    }
    return `(${row.type})`;
}
function renderNode(node, lines, prefix, isLast, isRoot) {
    const sortedKeys = Array.from(node.children.keys()).sort((a, b) => {
        const aNode = node.children.get(a);
        const bNode = node.children.get(b);
        const aIsDir = isDirectoryNode(aNode);
        const bIsDir = isDirectoryNode(bNode);
        if (aIsDir !== bIsDir)
            return aIsDir ? -1 : 1;
        return a.localeCompare(b);
    });
    const maxLen = maxFilenameWidth(node);
    const padWidth = paddingWidth(maxLen);
    for (let i = 0; i < sortedKeys.length; i++) {
        const key = sortedKeys[i];
        const child = node.children.get(key);
        const childIsLast = i === sortedKeys.length - 1;
        const connector = childIsLast ? '└── ' : '├── ';
        const continuation = childIsLast ? '    ' : '│   ';
        if (isDirectoryNode(child)) {
            const { displayName, target } = collapseNode(child);
            lines.push(`${prefix}${connector}${displayName}/`);
            renderNode(target, lines, prefix + continuation, childIsLast, false);
        }
        else {
            const annotation = child.file ? formatAnnotation(child.file) : '';
            const pad = ' '.repeat(Math.max(1, padWidth - child.name.length + maxLen - maxLen));
            const paddedName = child.name + ' '.repeat(Math.max(2, padWidth - child.name.length));
            lines.push(`${prefix}${connector}${paddedName}${annotation}`);
        }
    }
}
function renderRootLevel(root, lines) {
    const sortedKeys = Array.from(root.children.keys()).sort((a, b) => {
        const aNode = root.children.get(a);
        const bNode = root.children.get(b);
        const aIsDir = isDirectoryNode(aNode);
        const bIsDir = isDirectoryNode(bNode);
        if (aIsDir !== bIsDir)
            return aIsDir ? -1 : 1;
        return a.localeCompare(b);
    });
    const maxLen = maxFilenameWidth(root);
    const padWidth = paddingWidth(maxLen);
    for (let i = 0; i < sortedKeys.length; i++) {
        const key = sortedKeys[i];
        const child = root.children.get(key);
        const childIsLast = i === sortedKeys.length - 1;
        const connector = childIsLast ? '└── ' : '├── ';
        const continuation = childIsLast ? '    ' : '│   ';
        if (isDirectoryNode(child)) {
            const { displayName, target } = collapseNode(child);
            lines.push(`${connector}${displayName}/`);
            renderNode(target, lines, continuation, childIsLast, false);
        }
        else {
            const paddedName = child.name + ' '.repeat(Math.max(2, padWidth - child.name.length));
            const annotation = child.file ? formatAnnotation(child.file) : '';
            lines.push(`${connector}${paddedName}${annotation}`);
        }
    }
}
function countByType(rows) {
    const counts = new Map();
    for (const row of rows) {
        counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    }
    return counts;
}
export function renderCodebaseTree(rows, opts) {
    const activeRows = rows.filter(r => r.last_change_type !== 'deleted');
    const fileCount = activeRows.length;
    const tree = buildTree(activeRows);
    const treeLines = [];
    renderRootLevel(tree, treeLines);
    const typeCounts = countByType(activeRows);
    const typeOrder = ['source', 'test', 'doc', 'config', 'unknown'];
    const allTypes = [
        ...typeOrder.filter(t => typeCounts.has(t)),
        ...Array.from(typeCounts.keys()).filter(t => !typeOrder.includes(t)).sort(),
    ];
    const tableRows = allTypes.map(t => {
        const count = typeCounts.get(t) ?? 0;
        return `| ${t.padEnd(6)} | ${String(count).padStart(5)} |`;
    });
    const summaryTable = [
        '| Type   | Count |',
        '|--------|-------|',
        ...tableRows,
    ].join('\n');
    const lines = [
        `<!-- Auto-rendered ${opts.generatedAt}. Do not edit. -->`,
        '',
        '# Codebase Tree',
        '',
        `_Generated from \`file_registry\` by MCP renderer. ${fileCount} files indexed._`,
        '',
        '```',
        ...treeLines,
        '```',
        '',
        '## Summary by type',
        '',
        summaryTable,
    ];
    return lines.join('\n') + '\n';
}
//# sourceMappingURL=codebase-tree.js.map