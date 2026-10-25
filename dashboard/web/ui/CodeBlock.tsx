// Forked from Primer CSS markdown code blocks (github.com/primer/css, MIT), rebuilt on Primer bgColor tokens without Primer CSS. Text renders as React text only, never as HTML.
import { CopyButton } from './CopyButton.tsx';

const LINE_HEIGHT_EM = 1.45;

export function CodeBlock({ text, label, maxLines }: { text: string; label: string; maxLines?: number }) {
  return (
    <div className="relative min-w-0">
      <pre
        tabIndex={0}
        aria-label={label}
        style={maxLines ? { maxHeight: `calc(${maxLines * LINE_HEIGHT_EM}em + 1.5rem)` } : undefined}
        className="overflow-auto rounded-md bg-(--bgColor-muted) py-3 pr-10 pl-3 font-mono text-xs leading-[1.45] text-fg focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2"
      >
        <code>{text}</code>
      </pre>
      <div className="absolute top-1 right-1">
        <CopyButton value={text} label={`Copy ${label}`} />
      </div>
    </div>
  );
}
