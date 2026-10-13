/**
 * The frame every Billing block shares — BACKLOG-3844.
 *
 * Synchronous server component, no client JS. Later slices fill each block in
 * place (3847 plan and checkout, 3848 payment, 3854 seats, 3855 invoices).
 */
export function BillingBlock({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children?: React.ReactNode;
}) {
  const headingId = `billing-${id}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      data-billing-block={id}
      className="rounded-lg border border-gray-200 bg-white p-6"
    >
      <h2 id={headingId} className="text-lg font-semibold text-gray-900">
        {title}
      </h2>
      {children}
    </section>
  );
}
