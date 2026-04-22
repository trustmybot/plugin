interface ColumnDef {
  name: string;
  type: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isUnique: boolean;
  references: { table: string; col: string } | null;
}

interface TableDef {
  name: string;
  columns: ColumnDef[];
}

interface Relation {
  fromTable: string;
  fromCol: string;
  toTable: string;
  toCol: string;
  isUnique: boolean;
}

function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function extractCreateTableBlocks(sql: string): Array<{ name: string; body: string; lineHint: number }> {
  const results: Array<{ name: string; body: string; lineHint: number }> = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(sql)) !== null) {
    const tableName = match[1];
    const startParen = match.index + match[0].length - 1;
    let depth = 0;
    let i = startParen;

    while (i < sql.length) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }

    const body = sql.slice(startParen + 1, i);
    const lineHint = sql.slice(0, match.index).split('\n').length;
    results.push({ name: tableName, body, lineHint });
  }

  return results;
}

function normaliseType(raw: string): string {
  const upper = raw.toUpperCase().trim();
  if (upper.startsWith('INT') || upper === 'BIGINT' || upper === 'SMALLINT' || upper === 'TINYINT') return 'INTEGER';
  if (upper === 'BOOL' || upper === 'BOOLEAN') return 'INTEGER';
  if (upper.startsWith('VARCHAR') || upper.startsWith('CHAR') || upper.startsWith('NVARCHAR')) return 'TEXT';
  if (upper === 'FLOAT' || upper === 'DOUBLE' || upper === 'NUMERIC') return 'REAL';
  return upper.replace(/\(.*?\)/, '').trim() || 'TEXT';
}

function parseTableBody(
  body: string,
  tableName: string,
  uniqueCols: Set<string>,
): { columns: ColumnDef[]; relations: Relation[] } {
  const columns: ColumnDef[] = [];
  const relations: Relation[] = [];
  const pkCols = new Set<string>();

  const lines = body.split(',').map(l => l.trim()).filter(l => l.length > 0);

  for (const line of lines) {
    const upper = line.toUpperCase().trimStart();

    if (upper.startsWith('PRIMARY KEY')) {
      const m = line.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (m) {
        m[1].split(',').map(s => s.trim()).forEach(c => pkCols.add(c));
      }
      continue;
    }

    if (upper.startsWith('FOREIGN KEY')) {
      const m = line.match(/FOREIGN\s+KEY\s*\((\w+)\)\s*REFERENCES\s+(\w+)\s*\((\w+)\)/i);
      if (m) {
        const fromCol = m[1];
        const toTable = m[2];
        const toCol = m[3];
        relations.push({
          fromTable: tableName,
          fromCol,
          toTable,
          toCol,
          isUnique: uniqueCols.has(fromCol),
        });
      }
      continue;
    }

    if (upper.startsWith('UNIQUE') || upper.startsWith('CHECK') || upper.startsWith('CONSTRAINT')) {
      const um = line.match(/UNIQUE\s*\(([^)]+)\)/i);
      if (um) {
        um[1].split(',').map(s => s.trim()).forEach(c => uniqueCols.add(c));
      }
      continue;
    }

    const colMatch = line.match(/^(\w+)\s+(\w+(?:\([^)]*\))?)(.*)/i);
    if (!colMatch) continue;

    const colName = colMatch[1];
    const colType = normaliseType(colMatch[2]);
    const rest = colMatch[3];

    const isPrimaryKey = /\bPRIMARY\s+KEY\b/i.test(rest) || pkCols.has(colName);
    const isUnique = /\bUNIQUE\b/i.test(rest) || uniqueCols.has(colName);

    let references: { table: string; col: string } | null = null;
    const refMatch = rest.match(/\bREFERENCES\s+(\w+)\s*\((\w+)\)/i);
    if (refMatch) {
      references = { table: refMatch[1], col: refMatch[2] };
      relations.push({
        fromTable: tableName,
        fromCol: colName,
        toTable: refMatch[1],
        toCol: refMatch[2],
        isUnique,
      });
    }

    columns.push({
      name: colName,
      type: colType,
      isPrimaryKey,
      isForeignKey: references !== null,
      isUnique,
      references,
    });
  }

  for (const col of columns) {
    if (pkCols.has(col.name)) col.isPrimaryKey = true;
  }

  return { columns, relations };
}

function collectUniqueConstraints(body: string): Set<string> {
  const unique = new Set<string>();
  const re = /UNIQUE\s*\(([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    m[1].split(',').map(s => s.trim()).forEach(c => unique.add(c));
  }
  return unique;
}

function renderTableBlock(table: TableDef): string {
  const lines = [`    ${table.name} {`];
  for (const col of table.columns) {
    const label = col.isPrimaryKey ? ' PK' : col.isForeignKey ? ' FK' : '';
    lines.push(`        ${col.type} ${col.name}${label}`);
  }
  lines.push('    }');
  return lines.join('\n');
}

function dedupRelations(relations: Relation[]): Relation[] {
  const seen = new Set<string>();
  return relations.filter(r => {
    const key = `${r.fromTable}.${r.fromCol}->${r.toTable}.${r.toCol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderRelation(r: Relation): string {
  const cardinality = r.isUnique ? '||--o|' : '||--o{';
  const label = r.fromCol;
  if (r.fromTable === r.toTable) {
    return `    ${r.fromTable} ||--o{ ${r.fromTable} : "${label}"`;
  }
  return `    ${r.toTable} ${cardinality} ${r.fromTable} : "${label}"`;
}

export function renderErd(
  sqlText: string,
  opts: { generatedAt: string; schemaSource: string },
): string {
  const warnings: string[] = [];
  const tables: TableDef[] = [];
  const allRelations: Relation[] = [];

  const cleaned = stripLineComments(sqlText);
  const blocks = extractCreateTableBlocks(cleaned);

  for (const block of blocks) {
    try {
      const uniqueCols = collectUniqueConstraints(block.body);
      const { columns, relations } = parseTableBody(block.body, block.name, uniqueCols);
      tables.push({ name: block.name, columns });
      allRelations.push(...relations);
    } catch {
      warnings.push(`<!-- warn: skipped unrecognised statement at line ${block.lineHint} -->`);
    }
  }

  const deduped = dedupRelations(allRelations);
  const tableCount = tables.length;
  const relationCount = deduped.length;

  const tableBlocks = tables.map(renderTableBlock).join('\n');
  const relationLines = deduped.map(renderRelation).join('\n');

  const mermaidBody = tableCount === 0
    ? 'erDiagram'
    : [
        'erDiagram',
        tableBlocks,
        ...(relationLines ? [relationLines] : []),
      ].join('\n');

  const warningBlock = warnings.length > 0 ? '\n' + warnings.join('\n') + '\n' : '';

  return [
    `<!-- Generated ${opts.generatedAt} via /tmb refresh-architecture. Do not edit; regenerate. -->`,
    '',
    '# Entity-Relationship Diagram',
    '',
    `Source: \`${opts.schemaSource}\``,
    `Tables: ${tableCount}`,
    `Relations: ${relationCount}`,
    '',
    '```mermaid',
    mermaidBody,
    '```',
    warningBlock,
  ]
    .join('\n')
    .trimEnd() + '\n';
}
