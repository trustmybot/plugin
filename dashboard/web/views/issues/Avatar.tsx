const AUTHOR_BG: Record<string, string> = {
  bro: 'bg-(--bgColor-accent-emphasis)',
  swe: 'bg-(--bgColor-success-emphasis)',
  frontend: 'bg-(--bgColor-done-emphasis)',
  'pr-reviewer': 'bg-(--bgColor-severe-emphasis)',
  pm: 'bg-(--bgColor-attention-emphasis)',
  human: 'bg-(--bgColor-neutral-emphasis)',
};

const FALLBACK_BG = [
  'bg-(--bgColor-open-emphasis)',
  'bg-(--bgColor-danger-emphasis)',
  'bg-(--bgColor-sponsors-emphasis)',
  'bg-(--bgColor-upsell-emphasis)',
];

const authorBg = (author: string) => {
  const key = author.toLowerCase();
  if (AUTHOR_BG[key]) return AUTHOR_BG[key];
  const hash = [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
  return FALLBACK_BG[hash % FALLBACK_BG.length]!;
};

const SIZE = { small: 'size-5 text-[9px]', medium: 'size-10 text-[13px]' } as const;

export function Avatar({ author, size = 'medium', className = '' }: { author: string; size?: keyof typeof SIZE; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-grid shrink-0 place-items-center rounded-full font-semibold text-(--fgColor-onEmphasis) ${SIZE[size]} ${authorBg(author)} ${className}`}
    >
      {(author || '?').slice(0, 2).toUpperCase()}
    </span>
  );
}
