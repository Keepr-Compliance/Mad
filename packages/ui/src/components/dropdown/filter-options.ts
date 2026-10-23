import type { DropdownOption } from './types';

/**
 * Pure filter for Dropdown options. Matches the trimmed, case-folded query as
 * a substring of the label, the description or any keyword. An empty query
 * returns every option. Order is preserved.
 */
export function filterDropdownOptions<V extends string>(
  options: readonly DropdownOption<V>[],
  query: string
): readonly DropdownOption<V>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => {
    if (o.label.toLowerCase().includes(q)) return true;
    if (o.description && o.description.toLowerCase().includes(q)) return true;
    return (o.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  });
}
