# p3878 — Stripe TEST fixtures (BACKLOG-3878)

`charges-list-disputed.json`: `GET /v1/charges?customer=…&limit=20` at API version
`2025-02-24.acacia` (the portal's pinned version), Stripe TEST mode, 2026-10-13.
Producer: a per-export style PaymentIntent (1499 usd, no invoice) confirmed with
`pm_card_createDispute`; Stripe opened a dispute and set `disputed: true` on the
charge. `receipt_url` replaced with `<stripped>` as in p3848. The TEST customer
was deleted after the read.

## BACKLOG-3878 PR-2 (pause / resume, D2)

All re-fetched with `2025-02-24.acacia`, Stripe TEST mode, 2026-10-13, test clocks deleted after.
Signed URLs (`hosted_invoice_url`, `invoice_pdf`, `receipt_url`, session `url`) replaced with
`<stripped>`; nothing else edited. Customer emails are `@example.com` spike addresses.

Step 0 spike (`p3878-work/a1-a3.py, b1.py`, plan pm_comments 5b0e2a49):
- `x1-sub-past-due-before-pause`, `x1-renewal-open`: renewal failed, sub `past_due`, renewal
  invoice `open` (attempt 1), before any pause.
- `x1-renewal-paid-while-paused`: the same renewal 4 days after `pause_collection{void}` alone:
  Stripe's smart retry paid it (the double charge the void prevents).
- `x2-sub-after-void-and-pause`: open renewal voided, then paused: sub `active` + `pause_collection{void}`.
- `x2-resume-sub`, `x2-resume-invoice-marker`: after the resume (`pause_collection ''`,
  `billing_cycle_anchor now`, `proration_behavior none`, `metadata[keepr_resume]`): the
  `subscription_update` invoice, paid; the marker is in `subscription_details.metadata.keepr_resume`
  (`invoice.metadata` is `{}`). The marker value is the spike's label, not a uuid.
- `x3-sub-canceled-cape-paused`: `cancel_at_period_end` + paused, rolled past period end: `canceled`.
- `y1-renewal-voided-by-pause`: a renewal that was a `draft` when the pause was set, finalized `void`.
- `y2-resume-invoice-open-marker`: resume with a failing card: `subscription_update` invoice `open`.

PR-2 spike (`p3878-pr2-spike/x4.py`):
- `x4-sub-paused-inside-period`, `x4-latest-invoice-paid`: paid `subscription_create`, paused
  `{void}`, clock +3 days (inside the paid period). `x4-sub-after-unpause-only`: after
  `pause_collection ''` only: `active`, same `current_period_end`, no new invoice (SR R5 / X4).
- `x4cape-*`: the same with `cancel_at_period_end: true`; un-pausing it made no invoice.
- `x4-subscriptions-list-customer`: `GET /v1/subscriptions?customer=…&status=all` for the x4 customer.
- `x4-checkout-sessions-list-open`, `x4-checkout-session-expired`: a subscription-mode Checkout
  session opened before the pause: `GET /v1/checkout/sessions?customer=…&status=open`, then
  `POST …/expire`.
- `x2-resume-charge`: the charge of `x2-resume-invoice-marker`, re-fetched after the spike (`GET /v1/charges/<id>`).
- `x2-resume-ev-invoice.paid`: the `invoice.paid` event delivered for that invoice (account version `2026-06-24.dahlia`, request idempotency key stripped).
