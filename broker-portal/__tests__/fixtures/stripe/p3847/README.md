# Stripe TEST fixtures (BACKLOG-3847)

Captured from Stripe TEST mode on 2026-10-12 with the Stripe CLI and
`--stripe-version=2025-02-24.acacia` (the pinned client version), not written
by hand. Signed Checkout URLs, client secrets, hosted invoice links and request
log links are replaced with `<stripped>`; nothing else is edited. All objects
were cleaned up after capture (sessions expired, customer deleted, the probe's
old price archived). The `agent_month_usd` price is the TEST Agent price and
was kept on purpose.

Producers (one TEST customer, `cus.json`, synthetic user `USER-3847` / org `ORG-P3847`):

| File | Producer |
|---|---|
| `cs-S1-open.json`, `cs-S0-oldprice-open.json` | `checkout.sessions.create` with params from `buildSubscriptionCheckoutParams` (lib/billing/agentCheckoutParams.ts); the exact params are in the matching `*-request.json`. S0 uses a second, since archived, price. |
| `cs-payg-open.json` and the 10 other payment sessions in `sessions-*` | `checkout.sessions.create` with the params shape of `app/api/payments/checkout-session/route.ts` (pay-per-export) |
| `sessions-open-p1/p2.json` | `checkout.sessions.list({customer})`, page 1 and page 2 (default page size 10) while S0/S1 were open |
| `sessions-expired-p1/p2.json` | the same list after S0 and S1 were expired |
| `sub-A-incomplete*.json` | `subscriptions.create` with `payment_behavior=default_incomplete` and `pm_card_authenticationRequired` (the state an abandoned 3DS leaves) |
| `inv-A-void.json`, `sub-A-after-void.json` | `invoices.voidInvoice` on A's invoice, then A re-fetched: `incomplete_expired` |
| `sub-C-incomplete.json`, `sub-C-active-after-pay.json` | a second such subscription, then its invoice paid with `pm_card_visa` (a user finishing 3DS in another tab) |
| `inv-C-void-refused.json` | `invoices.voidInvoice` on C's paid invoice: Stripe's refusal, verbatim |
| `subs-L1..L3.json` | `subscriptions.list({customer, status:'all'})` after A was made, after C was made, after C was paid |
| `subs-L4-p1/p2.json` | the same list after ten more voided subscriptions: the active C is item 11 |
| `sub-C-cancel-at-period-end.json`, `sub-C-keep.json` | `subscriptions.update` on C with `cancel_at_period_end` true, then false |
| `prices-list-lookup.json`, `price-agent-month.json`, `product-agent.json` | the Agent product/price with lookup key `agent_month_usd`, and `prices.list({lookup_keys, active})` |

Where a test edits a field or composes objects, the test says so next to it
(`[EDITED]`, `[COMPOSED]`, `[SEEDED]`).
