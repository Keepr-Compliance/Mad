# BACKLOG-3932 fixtures (Stripe TEST, API 2025-02-24.acacia)

Captured 2026-11-09 with the `stripe` CLI on the TEST account (`livemode: false`), every object
re-fetched with `--stripe-version 2025-02-24.acacia` (the SDK's pinned version, lib/stripe.ts).
Raw responses, not invented.

Recipe: a TEST customer (`metadata.kind = brokerage`, `organization_id = ORG-3932-PF`) and a
brokerage-shaped subscription (send_invoice, days_until_due 15, 3 x 2499 usd, payment methods
`us_bank_account` + `card`, subscription `metadata.kind = brokerage`). The first invoice was
finalized, then its PaymentIntent confirmed with Stripe's failing ACH test token
`pm_usBankAccount_insufficientFunds` and `mandate_data[customer_acceptance][type]=offline`
(docs.stripe.com/payments/ach-direct-debit/accept-a-payment, "Test account numbers"). The PI went
`processing`, then `requires_payment_method` (insufficient_funds) about 10 s later, emitting
`invoice.payment_failed`. The same PI was then confirmed a second time with the same token (the
customer's retry): a new ACH payment id, `processing`, then failed again with a second
`invoice.payment_failed`. Afterwards the invoice was marked uncollectible, then voided.

Edits, all disclosed:

- `hosted_invoice_url` -> `https://invoice.stripe.test/REDACTED/<invoice id>`; `invoice_pdf` the same + `.pdf`.
- `client_secret` -> `pi_FIXTURE_secret_REDACTED`; `acct_...` -> `acct_REDACTED`; `@example.com` -> `@example.test`.

| File | State |
|---|---|
| inv-pf1-failed.json | invoice after the first ACH failure, `payment_intent` a string (the webhook's re-fetch) |
| pi-pf1-failed.json | its PaymentIntent: requires_payment_method, `latest_charge` = first ACH payment (`py_...`), `last_payment_error.code` insufficient_funds, no `last_payment_error.charge` |
| inv-pf1-processing.exp.json | invoice with `payment_intent` expanded while the first debit was processing |
| inv-pf1-failed.exp.json | invoice expanded after the first failure (the drain's re-fetch) |
| inv-pf2-processing.exp.json | invoice expanded while the retry was processing (new `latest_charge`) |
| inv-pf2-failed.json / pi-pf2-failed.json / inv-pf2-failed.exp.json | the same three after the retry failed |
| inv-pf-uncollectible.exp.json | marked uncollectible (expanded) |
| inv-pf-void.exp.json | voided (expanded; the PI is canceled) |
| ev-pf1-invoice.payment_failed.json / ev-pf2-... | the two real event envelopes (account default API version; the handler reads only id, type, created, livemode, data.object.id) |

A `paid` invoice was not captured; tests that need one say [EDITED] where they flip status,
amount_remaining and the PI status.
