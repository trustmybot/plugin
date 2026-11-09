// The Project Map's treemap of the selected directory's children, sized by file count, with README drift marked.
import { useId, useState, type KeyboardEvent } from 'react';
import { useApi, type WmNode, type WorldModel } from '../../api.ts';
import { Loading } from '../../shared/Loading.tsx';
import { Box, BoxHeader, BoxRow } from '../../ui/Box.tsx';
import { driftLines, driftOf } from './Drift.tsx';
import { childrenOf, childrenPath, dirName } from './paths.ts';
import { squarify } from './treemap.ts';

const WIDTH = 960;
const HEIGHT = 400;
const PAD = 4;
const LINE = 16;
const MIN_LABEL_W = 48;

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

export const cellDetail = (node: WmNode) => {
  const drift = driftOf(node);
  return [node.path, files(node.file_count), ...(drift ? driftLines(drift) : [])].join('\n');
};

export function DirectoryTreemap({ repo, path, onSelect }: { repo: string; path: string; onSelect: (path: string) => void }) {
  const q = useApi<WorldModel>(childrenPath(repo, path), { keepPrevious: true });
  const [hovered, setHovered] = useState<WmNode | null>(null);
  const clip = `treemap-${useId().replace(/[^\w-]/g, '')}`;
  const title = path === '' ? repo : path;
  return (
    <Box className="min-w-0 overflow-hidden">
      <BoxHeader className="text-sm font-semibold break-all">{title}</BoxHeader>
      <Loading q={q}>
        {(wm) => {
          const kids = childrenOf(wm.nodes, path);
          if (!kids.some((k) => k.file_count > 0)) return <BoxRow className="text-sm text-fg-muted">No subdirectories with files.</BoxRow>;
          const shown = hovered && kids.some((k) => k.path === hovered.path) ? hovered : null;
          return (
            <>
              <BoxRow>
                <TreemapChart kids={kids} title={title} clip={clip} onSelect={onSelect} onHover={setHovered} />
              </BoxRow>
              <BoxRow aria-live="polite" className="min-h-10 py-2 text-xs whitespace-pre-line text-fg-muted">
                {shown ? cellDetail(shown) : 'Hover or focus a cell for details; click to open it.'}
              </BoxRow>
            </>
          );
        }}
      </Loading>
    </Box>
  );
}

export function TreemapChart({
  kids,
  title,
  clip,
  onSelect,
  onHover,
}: {
  kids: WmNode[];
  title: string;
  clip: string;
  onSelect: (path: string) => void;
  onHover: (node: WmNode | null) => void;
}) {
  const cells = squarify(
    kids.map((node) => ({ node, value: node.file_count })),
    { x: 0, y: 0, w: WIDTH, h: HEIGHT },
  );
  return (
    <svg
      role="group"
      aria-label={`Treemap of ${title} by file count`}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="block h-auto w-full"
      onMouseLeave={() => onHover(null)}
    >
      {cells.map(({ item: { node }, x, y, w, h }, i) => {
        const drift = driftOf(node);
        const select = () => onSelect(node.path);
        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          select();
        };
        const room = Math.floor((h - PAD) / LINE);
        const labels = w >= MIN_LABEL_W ? [dirName(node), files(node.file_count), ...(drift ? driftLines(drift) : [])].slice(0, room) : [];
        return (
          <g
            key={node.path}
            role="button"
            tabIndex={0}
            aria-label={cellDetail(node).replaceAll('\n', ', ')}
            data-path={node.path}
            data-drift={drift ? 'true' : undefined}
            className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-(--focus-outline-color) [&:focus-visible>rect]:stroke-2"
            onClick={select}
            onKeyDown={onKeyDown}
            onMouseEnter={() => onHover(node)}
            onFocus={() => onHover(node)}
          >
            <title>{cellDetail(node)}</title>
            <clipPath id={`${clip}-${i}`}>
              <rect x={x + 1} y={y + 1} width={Math.max(w - PAD, 0)} height={Math.max(h - 2, 0)} />
            </clipPath>
            <rect
              x={x + 1}
              y={y + 1}
              width={Math.max(w - 2, 0)}
              height={Math.max(h - 2, 0)}
              rx={3}
              fill={drift ? 'var(--bgColor-attention-muted)' : 'var(--bgColor-accent-muted)'}
              stroke={drift ? 'var(--borderColor-attention-emphasis)' : 'var(--borderColor-default)'}
              strokeDasharray={drift ? '6 3' : undefined}
              className="hover:opacity-80"
            />
            {labels.length > 0 && (
              <text x={x + PAD + 2} y={y + PAD} fontSize={12} fill="var(--fgColor-default)" clipPath={`url(#${clip}-${i})`} className="pointer-events-none">
                {labels.map((line, j) => (
                  <tspan
                    key={j}
                    x={x + PAD + 2}
                    dy={LINE}
                    fontWeight={j === 0 ? 600 : undefined}
                    fill={j >= 2 ? 'var(--fgColor-attention)' : j === 1 ? 'var(--fgColor-muted)' : undefined}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
