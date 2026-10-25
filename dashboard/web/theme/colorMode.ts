import { useCallback, useState } from 'react';

export type ColorMode = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'tmb-color-mode';
const MODES: readonly ColorMode[] = ['auto', 'light', 'dark'];

const isColorMode = (value: unknown): value is ColorMode => MODES.includes(value as ColorMode);

export function storedColorMode(): ColorMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isColorMode(value) ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyColorMode(mode: ColorMode) {
  document.documentElement.dataset['colorMode'] = mode;
}

export const nextColorMode = (mode: ColorMode): ColorMode => MODES[(MODES.indexOf(mode) + 1) % MODES.length]!;

export function useColorMode(): [ColorMode, (mode: ColorMode) => void] {
  const [mode, setState] = useState(storedColorMode);
  const setMode = useCallback((next: ColorMode) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode, quota); the mode still applies for this page.
    }
    applyColorMode(next);
    setState(next);
  }, []);
  return [mode, setMode];
}
