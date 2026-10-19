# BACKLOG-3853 PR-2 fixtures (Stripe TEST, API 2025-02-24.acacia)

Transcribed from the PR-0 spike captures (docs/billing/3853-stripe-spike.md, clock A / B,
2026-10-17). Raw responses, not invented. Edits, all disclosed:

- `metadata.kind = "brokerage"` and `metadata.organization_id = "ORG-3853-A"` added to the
  subscription, customer and invoice `subscription_details` metadata (and `spike_kind` removed).
  The spike deliberately set no `kind`; PR-2's sync handler is the producer of that metadata.
- Email addresses `@example.com` -> `@example.test`.
- Hosted invoice, PDF and microdeposit-verification URLs replaced with `[REDACTED hosted URL]` (they embed the account id).
- `idempotency-error.json`: `request_log_url` removed (embeds the account id).
- `pi-open.json`, `pi-requires-action.json`: `client_secret` replaced with `pi_FIXTURE_secret_REDACTED`.

| File | Source capture | State |
|---|---|---|
| sub-create.json | subA1_create | active, quantity 5 x 2499, send_invoice, days_until_due 15 |
| sub-pastdue.json | subA1_pastdue | past_due (due date passed unpaid) |
| sub-after-pay.json | subA1_after_pay | active again after the overdue invoices were paid |
| sub-qty7.json | subA1_qty7 | quantity 7 after a seat change, proration none |
| inv-paid.json | invA1_pay_oldest | the oldest invoice, paid by card |
| inv-list-open.json | invA1_list | five open invoices on clock A |
| customer.json | custA1 | customer on test clock A |
| clock.json | clockA | test clock A at its start time (tests that need another time say [EDITED]) |
| pi-open.json | piA1_0 | the oldest invoice's PaymentIntent, requires_payment_method (nothing attempted) |
| pi-requires-action.json | piB1_confirm_ach | ACH PaymentIntent needing microdeposit verification |
| product.json | product | the spike's seat product |
| idempotency-error.json | subB3_idem3_diffparams | same key, different params |
| ev-sub-pastdue.json | evA1_pastdue | customer.subscription.updated -> past_due |

Synthetic (not captured; the spike ran no refunds or disputes, and event envelopes beyond
ev-sub-pastdue were not kept): the webhook tests build event envelopes with only the fields the
handler reads (id, type, created, livemode, data.object.id), and a refund charge / dispute with
only id, customer / payment_intent. Each test says [SYNTHETIC] where it does.
