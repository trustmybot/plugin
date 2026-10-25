// Forked from Primer CSS Header (github.com/primer/css, MIT), rebuilt on Primer --header-* tokens without Primer CSS.
import { DeviceDesktopIcon, MoonIcon, PulseIcon, SunIcon } from '@primer/octicons-react';
import { nextColorMode, useColorMode, type ColorMode } from '../theme/colorMode.ts';

const MODE_ICON = { auto: DeviceDesktopIcon, light: SunIcon, dark: MoonIcon } as const;
const MODE_LABEL: Record<ColorMode, string> = { auto: 'auto (system)', light: 'light', dark: 'dark' };

function ColorModeToggle() {
  const [mode, setMode] = useColorMode();
  const ModeIcon = MODE_ICON[mode];
  const label = `Colour mode: ${MODE_LABEL[mode]}. Switch to ${MODE_LABEL[nextColorMode(mode)]}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setMode(nextColorMode(mode))}
      className="flex size-8 items-center justify-center rounded-md border border-(--header-borderColor-divider) text-(--header-fgColor-default) hover:text-(--header-fgColor-logo) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color)"
    >
      <ModeIcon size={16} aria-hidden="true" />
    </button>
  );
}

export function AppHeader() {
  return (
    <header className="bg-(--header-bgColor) text-(--header-fgColor-default)">
      <div className="mx-auto flex w-full max-w-[120rem] items-center gap-3 px-4 py-3 sm:px-6 2xl:px-10">
        <PulseIcon size={24} className="text-(--header-fgColor-logo)" aria-hidden="true" />
        <h1 className="text-base font-semibold text-(--header-fgColor-logo)">TMB dashboard</h1>
        <span className="ml-auto flex items-center gap-1.5 text-xs">
          <span aria-hidden="true" className="size-2 rounded-full bg-(--bgColor-success-emphasis)" />
          live
        </span>
        <ColorModeToggle />
      </div>
    </header>
  );
}
