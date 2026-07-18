/**
 * Payment Cancelled (BACKLOG-2015).
 *
 * The desktop app's Stripe Checkout `cancel_url` points here (set in
 * broker-portal/app/api/payments/checkout-session/route.ts). No session is
 * passed and nothing is charged — this is a static reassurance page. The user
 * simply returns to the desktop app (still locked; they can retry the unlock).
 */

export default function PaymentCancelledPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <h1 className="text-3xl font-bold text-gray-900">Keepr.</h1>
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-4">
          <p className="text-lg font-semibold text-gray-900">Checkout cancelled</p>
          <p className="text-sm text-gray-600">
            No payment was taken. You can close this tab and return to the Keepr
            app — the deal is still locked, and you can unlock it whenever you’re
            ready.
          </p>
          <a
            href="keepr://payment-callback"
            className="inline-block rounded-lg border border-gray-300 bg-white px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Return to Keepr
          </a>
        </div>
      </div>
    </div>
  );
}
