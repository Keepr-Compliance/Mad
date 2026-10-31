import type { FilterCaptionProps } from './filter-bar';

// Pure helper (BACKLOG-3502a): no directive and no React, so a Server Component can call it.
/** The caption sentence, as a string (exported for reports that need the text). */
export function filterCaptionText({
  lead,
  periodLabel,
  filterNames,
  emptyText = 'no other filters',
}: Omit<FilterCaptionProps, 'className'>): string {
  const rest = filterNames.length > 0 ? filterNames.join(' · ') : emptyText;
  return `${lead}: ${periodLabel} · ${rest}`;
}
