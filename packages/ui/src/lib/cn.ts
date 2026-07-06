import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names with conflict resolution.
 *
 * Unlike @keepr/design-system's dependency-free `cn`, this variant uses
 * clsx + tailwind-merge — the shadcn/ui standard — so component consumers can
 * override any utility via `className` and the later class wins (e.g. passing
 * `className="bg-red-500"` beats a variant's `bg-primary`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
