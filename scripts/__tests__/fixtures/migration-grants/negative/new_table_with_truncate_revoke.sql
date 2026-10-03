-- FIXTURE (BACKLOG-3611). Transcribed from supabase/migrations/20260906000000_backlog_2077_chargeback_suspension.sql
-- lines 47-75: the account_suspensions table and its indexes, renamed account_suspensions_copy. Plus the TRUNCATE revoke docs rule 4 asks for.
-- --- 1. Append-only suspension/reinstatement audit table --------------------
CREATE TABLE IF NOT EXISTS public.account_suspensions_copy (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'suspended' = account blocked (chargeback); 'reinstated' = support lifted it.
  event_type               text NOT NULL CHECK (event_type IN ('suspended', 'reinstated')),
  -- Human-readable reason (chargeback summary or support's lift justification).
  reason                   text NOT NULL,
  -- Dispute provenance (populated on 'suspended'; null on 'reinstated').
  stripe_dispute_id        text,
  stripe_payment_intent_id text,
  local_transaction_id     text,
  amount_cents             integer,
  dispute_created_at       timestamptz,
  -- The license status the account held immediately BEFORE this suspension, so a
  -- reinstate restores it (e.g. a suspended-then-lifted expired trial goes back to
  -- 'expired', not 'active'). Populated on 'suspended'.
  previous_license_status  text,
  -- Who acted: the support operator (auth.uid()) for a reinstate; NULL for the
  -- system/webhook suspend (service-role has no auth.uid()).
  acted_by                 uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_suspensions_copy_user_id_created_at_idx
  ON public.account_suspensions_copy (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_suspensions_copy_dispute_id_idx
  ON public.account_suspensions_copy (stripe_dispute_id)
  WHERE stripe_dispute_id IS NOT NULL;

REVOKE TRUNCATE ON public.account_suspensions_copy FROM anon, authenticated;
