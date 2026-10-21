# BACKLOG-4019 fixtures (Stripe TEST, API 2025-02-24.acacia)

Both files are `../p3853/sub-create.json` (a real TEST capture, see that README) with ONLY the
cancellation fields changed, to the shape measured in the BACKLOG-4019 sandbox probe
(stripe_probe.out, 2026-10-20, test clock, metadata kind probe4019; plan-4019 section 1, S1 and S4):

| File | Probe line | Fields set [EDITED] |
|---|---|---|
| sub-cancel-pending.json | "A off" (cancel_at_period_end true on an active send_invoice subscription) | `cancel_at_period_end` true, `cancel_at` = `current_period_end`, `canceled_at` = `created` |
| sub-ended.json | "A after end" (test clock advanced past the period end) | as above, plus `status` "canceled", `ended_at` = `cancel_at` |

Measured in the probe and kept: status stays `active` until the period end; `cancel_at` equals the
period end; after the end `ended_at` equals `cancel_at`. The top-level `current_period_end` is kept
(the server pins 2025-02-24.acacia, where it still exists).
