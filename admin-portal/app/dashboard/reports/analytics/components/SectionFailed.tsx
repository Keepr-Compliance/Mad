/**
 * The banner a section shows when its read failed (BACKLOG-3723). A failed
 * read is NOT an empty section: the banner replaces the empty text and every
 * number in that section.
 */

export const SECTION_FAILED_TEXT =
  'This data could not be read. This is a query failure, not an empty result — no number in this section can be trusted.';

export function SectionFailed({ section }: { section: string }) {
  return (
    <div
      data-banner={`${section}-failed`}
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
    >
      {SECTION_FAILED_TEXT}
    </div>
  );
}
