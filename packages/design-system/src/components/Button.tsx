import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../cn';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'dangerOutline'
  | 'success'
  | 'warning';

export type ButtonSize = 'md' | 'sm' | 'xs';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary-600 text-white border border-transparent hover:bg-primary-700 focus:ring-primary-500',
  secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:ring-primary-500',
  danger: 'bg-red-600 text-white border border-transparent hover:bg-red-700 focus:ring-red-500',
  dangerOutline: 'bg-white text-red-700 border border-red-300 hover:bg-red-50 focus:ring-red-500',
  success: 'bg-success-600 text-white border border-transparent hover:bg-success-700 focus:ring-success-500',
  warning: 'bg-warning-600 text-white border border-transparent hover:bg-warning-700 focus:ring-warning-500',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: 'gap-2 px-4 py-2 text-sm',
  sm: 'gap-2 px-3 py-1.5 text-sm',
  xs: 'gap-1.5 px-3 py-1.5 text-xs',
};

/**
 * Compose the button class string without the component, for styling
 * `<Link>`/`<a>` elements as buttons.
 */
export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string
): string {
  return cn(
    'inline-flex items-center justify-center rounded-md font-medium transition-colors',
    'focus:outline-none focus:ring-2 focus:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}
