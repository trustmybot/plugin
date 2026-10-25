import { buttonClass } from '../ui/Button.tsx';

export const BUTTON = buttonClass('default', 'small');
export const FIELD =
  'w-full rounded-md border border-(--control-borderColor-rest) bg-(--control-bgColor-rest) px-2 py-1 text-sm text-(--control-fgColor-rest) placeholder:text-(--control-fgColor-placeholder) hover:bg-(--control-bgColor-hover) focus-visible:border-(--borderColor-accent-emphasis) focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-1 disabled:border-(--control-borderColor-disabled) disabled:bg-(--control-bgColor-disabled) disabled:text-(--control-fgColor-disabled)';
