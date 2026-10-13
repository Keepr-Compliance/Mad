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

## PR-2 (writes): `pr2-*` and `SR-*`

Second TEST spike, 2026-10-13, same CLI version. One customer on a test clock
(synthetic user `USER-3848-PR2`, email on `example.invalid`), cleaned up (clock
deleted; the setup session expired). Strings containing `https://` were cut to
`<stripped>` inside the string (error messages keep their text).

1. `pm_card_visa`, Agent subscription on `agent_month_usd`; default switched to
   `pm_card_chargeCustomerFail`; clock past the period end: `past_due`.
2. A setup-mode Checkout session created with the exact parameters
   `startCardUpdate` sends.
3. Stripe refuses `setup_intents.confirm` on a Checkout-made SetupIntent ("You
   cannot confirm SetupIntents created by Checkout"), so a standalone
   SetupIntent on the same customer was confirmed with `pm_card_visa`.
   Tests that pair the session with it say `[COMPOSED]`.
4. Customer and subscription default set to that card; contact edited.
5. `invoices.pay` with `pm_card_authenticationRequired` (error), then with the
   new card (paid), then again (error), then `voidInvoice` on the paid invoice
   (error).

| File | Producer |
|---|---|
| `pr2-sub-past_due.json` | `subscriptions.retrieve` after step 1 |
| `pr2-inv-open.json` | `invoices.retrieve(sub.latest_invoice)` after step 1 (the open renewal) |
| `pr2-invoices-list-sub-open.json` | `invoices.list({subscription, status: 'open', limit: 100})` after step 1 |
| `pr2-cs-setup-open.json` | `checkout.sessions.create({mode: 'setup', ...})` (step 2) |
| `pr2-seti-before.json` | `setupIntents.retrieve` of the session's SetupIntent (`requires_payment_method`) |
| `pr2-seti-succeeded.json` | the standalone SetupIntent, `succeeded` (step 3) |
| `pr2-cus-update-default.json` | `customers.update(id, {invoice_settings: {default_payment_method}})` |
| `pr2-sub-update-default.json` | `subscriptions.update(id, {default_payment_method})` |
| `pr2-cus-update-contact.json` | `customers.update(id, {name, email})` |
| `pr2-pay-auth-required.json` | `invoices.pay` with the 3DS card: error `invoice_payment_intent_requires_action` |
| `pr2-inv-after-3ds.json` | `invoices.retrieve` after that (still `open`) |
| `pr2-inv-paid.json` | `invoices.pay` with the new card: `paid` |
| `pr2-pay-already-paid.json` | `invoices.pay` again: error "Invoice is already paid" (no `code`) |
| `pr2-void-paid-refused.json` | `invoices.voidInvoice` on the paid invoice: error (no `code`) |
| `pr2-inv-paid-expand-charge.json` | `invoices.retrieve(id, {expand: ['charge']})`: `charge.receipt_number` is null in TEST |
| `pr2-sub-after-pay.json` | `subscriptions.retrieve` after the payment: `active` |

SR plan-review spike (`3848-sr/spike`, TEST, acacia, clock deleted):

| File | Producer |
|---|---|
| `SR-PAY-decline.json` | `invoices.pay` with a declining card: error `card_declined` |
| `SR-VOID-inv-voided.json` | `invoices.voidInvoice` on a past_due renewal |
| `SR-VOID-sub-after-void.json` | `subscriptions.retrieve` after the void: `active` |
| `SR-VOID-sub-canceled.json` | `subscriptions.cancel(id, {prorate: false, invoice_now: false})`: `canceled` |
