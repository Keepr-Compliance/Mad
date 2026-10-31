/**
 * Public help article "Where do I find my invoices?" — BACKLOG-3855 (founder e007a05a).
 *
 * Linked from /help, from the brokerage Billing page and from both support forms when the
 * Billing & Subscription category is picked. Public (middleware protects /dashboard only), no
 * breadcrumb, same layout as /guides/microsoft-approval. Operational: where to click, nothing
 * about how Keepr works inside.
 */

export const metadata = { title: 'Where do I find my invoices? | Keepr' };

export default function InvoicesGuidePage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
          <h1 className="text-3xl font-bold text-gray-900">Where do I find my invoices?</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-10 sm:px-6 lg:px-8 space-y-8 text-gray-700">
        <section>
          <h2 className="text-xl font-semibold text-gray-900">If you pay Keepr yourself</h2>
          <p className="mt-3">
            Open <strong>Billing</strong> in the Keepr web portal. Your payments are under <strong>Receipts</strong> (pay as
            you go) or <strong>Invoices</strong> (Agent plan).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">Brokerage Broker, Admin or billing contact</h2>
          <p className="mt-3">
            Open <strong>Billing</strong> and go to <strong>Invoices &amp; payment method</strong>. Your last five invoices
            are listed there with <strong>Download PDF</strong>, and <strong>Pay</strong> on any invoice that is due.
          </p>
          <p className="mt-3">
            <strong>View all invoices</strong> opens Stripe&apos;s billing page with every invoice and your payment method.
            Invoices are also emailed to your brokerage&apos;s billing contact.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">Brokerage agents and IT admins</h2>
          <p className="mt-3">Your brokerage pays for Keepr. Ask your Broker or Admin for a copy of an invoice.</p>
        </section>
      </div>
    </div>
  );
}
