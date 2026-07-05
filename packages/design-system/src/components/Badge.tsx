import type { ReactNode } from 'react';
import { cn } from '../cn';

/**
 * Status pill hues, following the admin-portal formula `bg-{hue}-100 text-{hue}-800`.
 *
 * Semantic conventions:
 *   gray = pending/none/low, blue = in-progress/info/medium, yellow = testing,
 *   green = completed/active/success, red = blocked/critical/danger,
 *   orange = deferred/high, purple = reopened/resolved, amber = waiting,
 *   indigo = epic, primary = brand accents (roles, plans).
 */
export type BadgeHue =
  | 'gray'
  | 'blue'
  | 'green'
  | 'red'
  | 'yellow'
  | 'orange'
  | 'purple'
  | 'amber'
  | 'indigo'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger';

const HUE_CLASSES: Record<BadgeHue, string> = {
  gray: 'bg-gray-100 text-gray-800',
  blue: 'bg-blue-100 text-blue-800',
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  orange: 'bg-orange-100 text-orange-800',
  purple: 'bg-purple-100 text-purple-800',
  amber: 'bg-amber-100 text-amber-800',
  indigo: 'bg-indigo-100 text-indigo-800',
  primary: 'bg-primary-100 text-primary-800',
  success: 'bg-success-100 text-success-800',
  warning: 'bg-warning-100 text-warning-800',
  danger: 'bg-danger-100 text-danger-800',
};

export interface BadgeProps {
  children: ReactNode;
  hue?: BadgeHue;
  /** 'sm' uses the tighter table-embedded padding (px-2). */
  size?: 'md' | 'sm';
  className?: string;
}

export function Badge({ children, hue = 'gray', size = 'md', className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full text-xs font-medium py-0.5',
        size === 'md' ? 'px-2.5' : 'px-2',
        HUE_CLASSES[hue],
        className
      )}
    >
      {children}
    </span>
  );
}

/** Look up the raw pill classes for a hue (for call sites that build their own element). */
export function badgeHueClasses(hue: BadgeHue): string {
  return HUE_CLASSES[hue];
}
