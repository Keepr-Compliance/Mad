# Stripe TEST fixtures (BACKLOG-3848, billing blocks 4–6)

Captured from Stripe TEST mode on 2026-10-13 with the Stripe CLI and
`--stripe-version=2025-02-24.acacia` (the pinned client version), not written
by hand. Every `https://` value (hosted invoice pages, invoice PDFs, charge
receipts) is replaced with `<stripped>`; nothing else is edited. All objects
were removed after capture (the test clock was deleted, which removes its
customer and subscription).

One TEST customer on a test clock (synthetic user `USER-3848-PR1`, email on
`example.invalid`):

1. `pm_card_visa` attached; one `payment_intents.create` + confirm with the
   customer set and no invoice (the shape of a pay-per-export charge).
2. An Agent subscription on the TEST `agent_month_usd` price, paid by
   `pm_card_visa` (first invoice `paid`).
3. Subscription default switched to `pm_card_chargeCustomerFail`, clock moved
   past the period end: the renewal invoice is `open`, the subscription
   `past_due`. One more `invoices.pay` with the failing card.
4. `invoices.pay` with `pm_card_visa`: the renewal invoice is `paid`.

| File | Producer |
|---|---|
| `sub-pastdue-expand-pm.json` | `subscriptions.retrieve(id, {expand: ['default_payment_method']})` after step 3 (the failing card, last4 0341) |
| `invoices-list-pastdue.json` | `invoices.list({customer, limit: 20})` after step 3: one `open` renewal (attempt_count 1) + the paid first invoice |
| `charges-list-pastdue.json` | `charges.list({customer, limit: 20})` after step 3 |
| `cus-expand-pm.json` | `customers.retrieve(id, {expand: ['invoice_settings.default_payment_method']})` after step 3 (customer default: `pm_card_visa`, last4 4242) |
| `pm-good.json` | `paymentMethods.retrieve` of the `pm_card_visa` method |
| `invoices-list-after-pay.json` | `invoices.list({customer, limit: 20})` after step 4: two `paid` invoices |
| `charges-list-after-pay.json` | `charges.list({customer, limit: 20})` after step 4: five charges for two invoices + one per-export payment (4 carry `invoice`, 1 does not) |
| `inv-voided.json` | `invoices.voidInvoice` on a past_due renewal invoice (BACKLOG-3848 step-0 spike, `END-inv-voided`) |

Charge `created` values are wall-clock while invoice `created` values follow
the test clock, so the two do not interleave as they would in production.

Where a test edits a field or composes objects, the test says so next to it
(`[EDITED]`, `[COMPOSED]`, `[SEEDED]`).
