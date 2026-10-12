# Stripe TEST fixtures: a subscription made BY Checkout (BACKLOG-3847, QA round 3)

Captured from Stripe TEST mode on 2026-10-12 with the Stripe CLI and
`--stripe-version 2025-02-24.acacia` (the pinned client version), not written by
hand. The state was left by a real Checkout attempt in TEST whose 3DS step
failed: one `incomplete` subscription, its `open` unpaid invoice, and the `open`
subscription-mode Checkout session that made them.

Edited in every file ([EDITED]): user and organization ids replaced with
`USER-3847` / `ORG-P3847`, the email with `agent-3847@fixture.example.test`, the
customer id with the one in `../p3847/cus.json`, and every URL and client secret
with `<stripped>`. Nothing else is edited.

| File | Producer, in the order it was run |
|---|---|
| `sub-Q-incomplete.json`, `inv-Q-open.json`, `cs-Q-open.json` | retrieve of the subscription, its latest invoice, and the session (`cs.subscription` / `cs.invoice` point at them) |
| `subs-by-customer-Q-incomplete.json` | `subscriptions.list({customer, status:'all'})` at the same moment |
| `sessions-by-customer-Q-open.json` | `checkout.sessions.list({customer})` at the same moment (its one item is the sanitized `cs-Q-open`) |
| `inv-Q-void-refused-open-session.json` | `invoices.voidInvoice` while the session is open: refused, "You cannot void an invoice with an active checkout session" |
| `cs-Q-expire.json` | `checkout.sessions.expire` on the session |
| `sub-Q-after-expire.json`, `inv-Q-after-expire.json` | re-fetched right after: subscription `incomplete_expired`, invoice `void` (Stripe did both on expiry; the invoice's PaymentIntent became `canceled`) |
| `inv-Q-void-refused-not-open.json` | `invoices.voidInvoice` again: refused, "This invoice isn't open" |
| `cs-Q-expire-refused-not-open.json` | `checkout.sessions.expire` again: refused, status `expired` |
| `sessions-by-sub-Q-after-expire.json` | `checkout.sessions.list({subscription})` after expiry (`status` and `subscription` cannot be combined: Stripe refuses) |

Where a test composes objects, the test says so next to it (`[COMPOSED]`).
