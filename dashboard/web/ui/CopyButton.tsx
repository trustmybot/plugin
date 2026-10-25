// Forked from Primer's clipboard-copy button (github.com/primer/view_components ClipboardCopy, MIT), rebuilt on Primer --button-invisible-* tokens without Primer.
import { CheckIcon, CopyIcon } from '@primer/octicons-react';
import { useEffect, useState } from 'react';
import { buttonClass } from './Button.tsx';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const Glyph = copied ? CheckIcon : CopyIcon;
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
      }}
      className={`${buttonClass('invisible', 'small')} shrink-0 px-1`}
    >
      <Glyph size={16} className={copied ? 'text-(--fgColor-success)' : 'text-(--button-invisible-iconColor-rest)'} aria-hidden="true" />
    </button>
  );
}
