import type { MultiSelectOption } from './multi-select';

// Pure helper (BACKLOG-3502a): no directive and no React, so a Server Component can call it.
/** Every option value selected, keeping anything already selected, no duplicates. */
export function selectAllValues(
  options: readonly MultiSelectOption[],
  selected: readonly string[]
): string[] {
  const out = [...selected];
  for (const option of options) {
    if (!out.includes(option.value)) out.push(option.value);
  }
  return out;
}
