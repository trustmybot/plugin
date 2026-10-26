import { AlertIcon, CheckIcon, XCircleIcon, type Icon } from '@primer/octicons-react';
import type { Trust } from '../../api.ts';
import { buttonClass } from '../../ui/Button.tsx';

export const CONCEPT_COPY = {
  placeholder: 'Search concepts or functions…',
  help: 'A concept is a feature, like cold start, traced step by step through the functions that make it up.',
  empty: 'No saved concept matches. Try a function name.',
  unavailable: 'Concepts need a fresh scan. Run /scan in a Claude Code session.',
  derived: 'Unverified — built from the call graph',
  showGraph: 'Show graph',
  showTable: 'Show as table',
};

export const TRUST_LABEL: Record<Trust, { icon: Icon; label: string }> = {
  verified: { icon: CheckIcon, label: 'Verified' },
  suspect: { icon: AlertIcon, label: 'Suspect' },
  broken: { icon: XCircleIcon, label: 'Broken' },
};

export const DERIVED_ID = 'derived';
export const MIN_QUERY = 2;
export const MUTED = 'text-fg-muted';
export const TARGET = `${buttonClass('invisible', 'small')} aria-pressed:bg-(--button-invisible-bgColor-active) aria-expanded:bg-(--button-invisible-bgColor-active)`;

export const stepCount = (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`;

export const CONCEPTS_HELP_ID = 'concepts-help';
export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
