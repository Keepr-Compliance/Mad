/**
 * Join class names, skipping falsy values.
 *
 * Deliberately dependency-free (no clsx/tailwind-merge): consumers pass
 * pre-resolved strings or `condition && 'classes'` expressions.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
