# p3878 — Stripe TEST fixtures (BACKLOG-3878)

`charges-list-disputed.json`: `GET /v1/charges?customer=…&limit=20` at API version
`2025-02-24.acacia` (the portal's pinned version), Stripe TEST mode, 2026-10-13.
Producer: a per-export style PaymentIntent (1499 usd, no invoice) confirmed with
`pm_card_createDispute`; Stripe opened a dispute and set `disputed: true` on the
charge. `receipt_url` replaced with `<stripped>` as in p3848. The TEST customer
was deleted after the read.
