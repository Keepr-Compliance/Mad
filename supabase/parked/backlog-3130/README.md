# Parked: high-risk audit alert webhook — BACKLOG-3130

`20260307_audit_alert_webhook.sql` is **parked, not deleted.** It was written, committed,
and never applied to any database. Nothing calls what it creates.

## What it holds

A `notify_high_risk_audit_action` trigger function that fires an HTTP call at an
`audit-alert` edge function whenever a high-risk row lands in the audit log. The edge
function is not deployed, so the trigger would fire at nothing.

## Why it is out of `supabase/migrations/`

Two reasons, both mechanical:

1. `supabase migration list` reports it as a local migration that no environment has run.
   Reconciling that list is the whole point of BACKLOG-3126: a file sitting in
   `migrations/` is a claim that it belongs in every database, and this one does not.
2. `supabase db reset` runs every file in `migrations/`. A local reset would install a
   trigger that calls a URL that answers nothing.

Moving it here removes both without losing the work. It is a plain `git mv` — the file
is byte-identical to what was in `migrations/`, and `git log --follow` still reaches its
original commit.

## What happens to it

BACKLOG-3130 finishes the feature: post high-risk audit alerts to a Teams channel and
surface them on an admin-portal Alerts & Performance dashboard. When that work starts,
this file moves back into `supabase/migrations/` **under a fresh timestamp**, reviewed
against the schema as it stands then. Do not move it back on its own — an unapplied
2026-03-07 stamp among today's migrations is how this drift started.

The founder's decision (2026-09-05, BACKLOG-3126): park rather than delete, because a
high-risk-action alerting path is plausible SOC 2 evidence. Delete remains open to him.
