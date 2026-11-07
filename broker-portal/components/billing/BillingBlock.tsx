/**
 * The frame every Billing block shares — BACKLOG-3844.
 *
 * Synchronous server component, no client JS. Later slices fill each block in
 * place (3847 plan and checkout, 3848 payment, 3854 seats, 3855 invoices).
 *
 * BACKLOG-4187: optional `action` (a button) on the title line. From sm up it sits on the right of
 * the title; below sm it goes under the title instead of squeezing it. Without `action` the block
 * renders exactly as before.
 */
export function BillingBlock({
  id,
  title,
  action,
  children,
}: {
  id: string;
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const headingId = `billing-${id}-heading`;
  const heading = (
    <h2 id={headingId} className="text-lg font-semibold text-gray-900">
      {title}
    </h2>
  );
  return (
    <section
      aria-labelledby={headingId}
      data-billing-block={id}
      className="rounded-lg border border-gray-200 bg-white p-6"
    >
      {action ? (
        <div data-billing-header="" className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
          {heading}
          <div data-billing-header-action="" className="shrink-0">
            {action}
          </div>
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}
