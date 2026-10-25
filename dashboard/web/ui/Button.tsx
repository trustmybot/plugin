// Forked from Primer React Button (github.com/primer/react, MIT), rebuilt on Primer --button-* tokens without @primer/react.
import type { Icon } from '@primer/octicons-react';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'invisible';
export type ButtonSize = 'small' | 'medium';

const BASE =
  'inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap select-none transition-colors disabled:cursor-not-allowed focus-visible:outline-(length:--focus-outline-width) focus-visible:outline-(--focus-outline-color) focus-visible:-outline-offset-2';

const SIZE: Record<ButtonSize, string> = {
  small: 'min-h-(--control-small-size) gap-(--control-small-gap) px-(--control-small-paddingInline-condensed) text-xs',
  medium: 'min-h-(--control-medium-size) gap-(--control-medium-gap) px-(--control-medium-paddingInline-normal) text-sm',
};

const VARIANT: Record<ButtonVariant, string> = {
  default:
    'border-(--button-default-borderColor-rest) bg-(--button-default-bgColor-rest) text-(--button-default-fgColor-rest) shadow-(--button-default-shadow-resting) hover:border-(--button-default-borderColor-hover) hover:bg-(--button-default-bgColor-hover) active:border-(--button-default-borderColor-active) active:bg-(--button-default-bgColor-active) disabled:border-(--button-default-borderColor-disabled) disabled:bg-(--button-default-bgColor-disabled) disabled:text-(--button-default-fgColor-disabled)',
  primary:
    'border-(--button-primary-borderColor-rest) bg-(--button-primary-bgColor-rest) text-(--button-primary-fgColor-rest) hover:border-(--button-primary-borderColor-hover) hover:bg-(--button-primary-bgColor-hover) active:border-(--button-primary-borderColor-active) active:bg-(--button-primary-bgColor-active) disabled:border-(--button-primary-borderColor-disabled) disabled:bg-(--button-primary-bgColor-disabled) disabled:text-(--button-primary-fgColor-disabled)',
  danger:
    'border-(--button-danger-borderColor-rest) bg-(--button-danger-bgColor-rest) text-(--button-danger-fgColor-rest) hover:border-(--button-danger-borderColor-hover) hover:bg-(--button-danger-bgColor-hover) hover:text-(--button-danger-fgColor-hover) active:border-(--button-danger-borderColor-active) active:bg-(--button-danger-bgColor-active) active:text-(--button-danger-fgColor-active) disabled:bg-(--button-danger-bgColor-disabled) disabled:text-(--button-danger-fgColor-disabled)',
  invisible:
    'border-(--button-invisible-borderColor-rest) bg-(--button-invisible-bgColor-rest) text-(--button-invisible-fgColor-rest) hover:border-(--button-invisible-borderColor-hover) hover:bg-(--button-invisible-bgColor-hover) hover:text-(--button-invisible-fgColor-hover) active:bg-(--button-invisible-bgColor-active) active:text-(--button-invisible-fgColor-active) disabled:border-(--button-invisible-borderColor-disabled) disabled:bg-(--button-invisible-bgColor-disabled) disabled:text-(--button-invisible-fgColor-disabled)',
};

const ICON: Record<ButtonVariant, string> = {
  default: 'text-fg-muted',
  primary: 'text-(--button-primary-iconColor-rest)',
  danger: 'text-(--button-danger-iconColor-rest)',
  invisible: 'text-(--button-invisible-iconColor-rest)',
};

export const buttonClass = (variant: ButtonVariant = 'default', size: ButtonSize = 'medium') => `${BASE} ${SIZE[size]} ${VARIANT[variant]}`;

type Common = { variant?: ButtonVariant; size?: ButtonSize; leadingVisual?: Icon; children?: ReactNode };
type AnchorProps = Common & AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };
type NativeButtonProps = Common & ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };

export function Button(props: AnchorProps | NativeButtonProps) {
  const { variant = 'default', size = 'medium', leadingVisual: Visual, children, className, ...rest } = props;
  const classes = className ? `${buttonClass(variant, size)} ${className}` : buttonClass(variant, size);
  const content = (
    <>
      {Visual && <Visual size={16} className={ICON[variant]} aria-hidden="true" />}
      {children}
    </>
  );
  if (rest.href !== undefined) {
    return (
      <a {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)} className={classes}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)} className={classes}>
      {content}
    </button>
  );
}
