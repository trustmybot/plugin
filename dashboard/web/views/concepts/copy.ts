import { query, type Trust } from '../../api.ts';
import { BUTTON } from '../../shared/classes.ts';

export const CONCEPT_COPY = {
  placeholder: 'Search concepts or functions…',
  help: 'A concept is a feature, like cold start, traced step by step through the functions that make it up.',
  empty: 'No saved concept matches. Try a function name.',
  unavailable: 'Concepts need a fresh world model scan — run /scan in a Claude Code session.',
  derived: 'Unverified — built from the call graph',
  showGraph: 'Show graph',
  showTable: 'Show as table',
};

export const TRUST_LABEL: Record<Trust, { icon: string; label: string }> = {
  verified: { icon: '✓', label: 'Verified' },
  suspect: { icon: '!', label: 'Suspect' },
  broken: { icon: '✕', label: 'Broken' },
};

export const DERIVED_ID = 'derived';
export const MIN_QUERY = 2;
export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400';
export const MUTED = 'text-zinc-600 dark:text-zinc-400';
export const TARGET = `${BUTTON} min-h-6 ${FOCUS}`;

export const stepCount = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

export const conceptsPath = (id: string | undefined, term: string) =>
  `concepts${id ? `/${id}` : ''}${term ? `?${query({ q: term })}` : ''}`;
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
