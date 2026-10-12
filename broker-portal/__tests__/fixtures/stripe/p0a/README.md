# Stripe TEST fixtures (BACKLOG-3846)

Transcribed from Stripe TEST mode, not written by hand. Signed URLs, client
secrets and request idempotency keys are replaced with `<stripped>`; nothing
else is edited.

- `ev-*`: webhook event envelopes as Stripe delivered them (account API
  version, `2026-06-24.dahlia`). The webhook reads only `id`, `type`, `created`,
  `livemode` and `data.object.id` from them (E0).
- `inv-*`, `sub-*`, `ch-*`, `pi-*`, `dp-*`, `cs-*`: the same objects re-fetched
  with the pinned client version `2025-02-24.acacia`, which is what the webhook
  reads.
- `2a/2b/2c/2d/4/W2` come from the BACKLOG-3648 P0-a spike (test clocks,
  2026-10-10). `A` (dispute on a subscription invoice, card
  `pm_card_createDispute`), `B` (subscription deleted), `C` (partial refund of a
  subscription invoice charge), `D` (two more subscriptions on the `C` customer)
  `E` (a trialing subscription and its $0 invoice, re-fetched while trialing)
  and `cs-W1-B` (P0-a session B re-fetched) were captured for BACKLOG-3846 on
  2026-10-12.

Where a test pairs an event with a re-fetch taken at a different moment, or
edits a field, the test says so next to the fixture.
