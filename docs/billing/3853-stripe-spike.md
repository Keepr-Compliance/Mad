# BACKLOG-3853 PR-0 — Stripe TEST spike: brokerage subscription on send_invoice

Measured 2026-10-17 in the Stripe TEST sandbox, API version `2025-02-24.acacia` (the
version `broker-portal/lib/stripe.ts` pins), on two test clocks. Raw API responses and
event lists were captured during the run and are kept outside the repo; PR-2 transcribes
its fixtures from them. Anything not measured is marked **INFERRED**.

## Setup used

| Setting | Value |
|---|---|
| Subscription | `collection_method=send_invoice`, `days_until_due=15`, `proration_behavior=none`, `billing_cycle_anchor` = creation time (default) |
| Item | inline `price_data`: usd, `unit_amount=2499`, `recurring.interval=month`, `quantity=5` |
| Payment methods | `payment_settings.payment_method_types = [us_bank_account, card, customer_balance]`, `payment_method_options.customer_balance = {funding_type: bank_transfer, bank_transfer.type: us_bank_transfer}` |
| Metadata | `spike=3853-pr0` only. `kind` was deliberately NOT set, so the existing Agent webhook path ignored these objects |

The API accepted all three payment method types on the subscription. Clock A started on
2026-10-31 15:00 UTC (the 31st, for the anchor check). Clock B started on 2026-11-02.

## Results

| # | Behaviour (INFERRED in SR v1/v2) | Measured |
|---|---|---|
| 1 | First invoice timing | Created at subscribe time as a **draft** (`billing_reason=subscription_create`). Stripe finalised it **1 hour later**: status became `open`, and the hosted URL, PDF and PaymentIntent appeared then. The subscription is `active` immediately. |
| 2 | Due date | `due_date` = invoice **creation** + 15 days (10-31 15:00 → 11-15 15:00), not finalisation + 15 days. The same rule held for every renewal invoice. |
| 3 | Anniversary on the 31st | Renewals were created on **Nov 30, Dec 31, Jan 31, Feb 28 and Mar 31**. The anchor stays at day 31 and falls back to the last day of shorter months. `billing_reason=subscription_cycle`. Each renewal was finalised 1 hour after creation. |
| 4 | Hosted invoice page | Shows amount, "Due <date>", Invoice PDF, and three choices: **Card, US bank account, Bank transfer**. One line: `5 × <product> (at $24.99 / month)`. |
| 5 | past_due transition | Unpaid with no payment attempt: the subscription went `active → past_due` **within 1 hour of the due date** (still `active` 1 h before the due time). `customer.delinquent` flipped at the same time. |
| 6 | After past_due | The subscription stayed `past_due` for **106 days** (to 2027-03-01). It was not cancelled or set to `unpaid`, every invoice stayed `open`, and renewal invoices kept arriving monthly. The sandbox's past-due setting therefore leaves the subscription past_due (or its cancel threshold is above 106 days). |
| 7 | Payment → active | Paying only the oldest overdue invoice did **not** clear past_due. The subscription returned to `active` only after the **last past-due invoice** was paid. An open invoice not yet due (the current month's) did not hold it in past_due. The `customer.subscription.updated` (→ active) event came **after** that invoice's `invoice.paid`. |
| 8 | Bank transfer (`customer_balance`) | A simulated incoming transfer of the exact amount (`fund_cash_balance`) paid the open invoice automatically (`reconciliation_mode=automatic`, merchant default). Events: `customer_cash_balance_transaction.created` ×2 → `payment_intent.succeeded` → `charge.succeeded` → `invoice.updated` → `invoice.paid` → `invoice.payment_succeeded`. |
| 9 | ACH (`us_bank_account`) | A manually entered bank account **cannot be attached** to a customer before verification. Confirming the invoice's PaymentIntent with it returned `requires_action` (`verify_with_microdeposits`) and **emitted `invoice.payment_failed`** plus `invoice.payment_action_required`. After microdeposit verification: `processing` → `succeeded` in about 15 s of real time. Advancing the clock did not drive it. |
| 10 | ACH in flight across the due date | **Partly INFERRED.** Test-mode ACH settles in seconds, so a 4-business-day `processing` window could not be held across the due date. Measured instead: an invoice with a payment **attempt** in `requires_action` stayed `open` and its subscription stayed **`active` for 7 days past the due date**. The unattempted invoice in #5 went past_due within 1 hour. |
| 11 | Seat change | `quantity 5 → 7` with `proration_behavior=none` created no invoice and no pending invoice items. The upcoming invoice shows `7 × … $174.93` with no proration lines. One event: `customer.subscription.updated` (prev: `items, quantity`). |
| 12 | Cancel | `cancel_at_period_end=true` → `customer.subscription.updated` now. At period end → `customer.subscription.deleted` (status `canceled`), and no further invoice was created. Immediate cancel → `customer.subscription.deleted`. Its unpaid open invoice stays `open` (`auto_advance` turned off). The event name is `customer.subscription.deleted`. |
| 13 | Idempotency key per org | Same key and same parameters returned the **same subscription** (one subscription on the customer). Same key with different parameters (quantity 6) was refused with `idempotency_error`. So a key `brokerage:<org>:<mode>:subscription:<deal version>` must change whenever the deal changes. |
| 14 | Search after write | `customers/search` on a fresh customer's metadata returned nothing at first and found it after **~11 s**. A deleted customer still appeared in search results afterwards. Find-before-create must not rely on Search alone (supports SR R5). |
| 15 | Test-clock limit | A 4th customer on one clock was refused: "maximum number (3) of customers allowed on this test clock". |
| 16 | Invoice emails | Every finalisation emitted `invoice.sent` (5 of 5 on clock A). Whether a TEST-mode email actually reaches a team inbox: **INFERRED**; the customers used `example.com` addresses. |
| 17 | `invoice.overdue` | Not emitted in 106 days past due. It needs a dashboard automation, so key overdue on `customer.subscription.updated` → `past_due` (plan v1 stands). |

### Event order (send_invoice subscription, measured)

- **Subscribe:** `customer.created`, `customer.updated`, `invoice.created` (draft), `customer.subscription.created` (active); then +1 h: `payment_intent.created`, `invoice.updated`, `invoice.finalized`, `invoice.sent`.
- **Renewal:** `invoice.created`, `customer.subscription.updated` (period), then +1 h: `payment_intent.created`, `invoice.updated`, `invoice.finalized`, `invoice.sent`.
- **Due date passes unpaid:** `customer.subscription.updated` (prev `status`, now `past_due`), `customer.updated` (prev `delinquent`).
- **Card payment of an invoice:** `charge.succeeded`, `payment_intent.succeeded`, `invoice.updated`, `invoice.paid`, `invoice.payment_succeeded` (and `invoice_payment.paid` on one of them). When it clears the last overdue invoice, `customer.subscription.updated` (→ active) follows.

Under a test clock, `event.created` is wall-clock time, not clock time. Order must come from list position.

## Plan impact (for PR-1 / PR-2)

1. `invoice.payment_failed` fires when an ACH payment **needs verification**, not only on an ACH return. The brokerage handler must not alert the account manager on it without checking the PaymentIntent status (`requires_action` ≠ failure).
2. Auto-reinstate (R8) is consistent with Stripe's own transition. `active` arrives only after the last overdue invoice is paid. Re-fetching the subscription on `invoice.paid` reads the final state, because the handlers re-fetch.
3. `notify_org_overdue`: in ONE run (#10), in the `requires_action` state only, an attempted-but-unfinished payment kept the subscription `active` past the due date and no overdue event arrived. A payment still `processing` across the due date was NOT measured (INFERRED: same behaviour). SR v1 rule: the overdue notification skips when the latest invoice's PaymentIntent is `processing` or `requires_action`.
4. A deal saved on the 29th–31st bills on the last day of shorter months (#3).
5. Two test clocks with ≤3 customers each are enough for the PR-2 harness (#15).

## Dashboard-only settings (not settable or readable by API)

`GET /v1/account` exposes only `settings.invoices.{default_account_tax_ids, hosted_payment_method_save}`. The following are dashboard settings (Settings → Billing → Subscriptions and emails / Invoices):

| Setting | TEST sandbox now (from behaviour) | Needed |
|---|---|---|
| Past-due handling for send_invoice subscriptions | leaves the subscription past_due (≥106 days) | leave past-due, no auto-cancel |
| Email finalised invoices to customers | `invoice.sent` emitted on every finalisation (on) | on |
| Reminder emails before/after due | not observable by API (INFERRED unknown) | founder choice |
| Overdue automation (`invoice.overdue`) | none | not needed |

Payment methods: the sandbox has `card_payments` and `us_bank_account_ach_payments` **active**. `bank_transfer_payments` / `us_bank_transfer_payments` show **unrequested**, although bank-transfer funding worked in TEST. In LIVE, card, ACH Direct Debit and Bank transfers must each be enabled in the dashboard before go-live (INFERRED for live: not checked, live mode not touched).

## Not measured

- A subscription schedule for a future start date: not needed (founder Q4 = a).
- ACH return / failure after `processing` (needs the failing test account number). INFERRED: arrives as `invoice.payment_failed` + `payment_intent.payment_failed`.
- Disputes and refunds on a brokerage invoice: not run.

## Test objects (TEST sandbox, all tagged `metadata.spike=3853-pr0`)

Both test clocks were deleted after the run, which deleted their customers, subscriptions, invoices and payment methods.

| Object | Id | State |
|---|---|---|
| Product "Keepr Team seat (spike 3853 PR-0)" | `prod_VSZ7s4JhRpHrrb` | archived (`active=false`) |
| Test clock A / B | two test clocks | deleted |
| Customers | four customers (A1, B1, B2, B3) | deleted with clocks |
| Subscriptions | four subscriptions | deleted with clocks |
| Search probe customer (no clock) | one customer | deleted |
