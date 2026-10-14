-- Venue parity: production's stripe_customers_select_own (live-mode rows only for the owner).
ALTER TABLE public.stripe_customers ADD COLUMN IF NOT EXISTS stripe_mode text NOT NULL DEFAULT 'live';  -- as 20261011230913:74
ALTER POLICY stripe_customers_select_own ON public.stripe_customers
  USING (((((SELECT auth.uid() AS uid) = user_id) AND (stripe_mode = 'live'::text)) OR has_internal_role((SELECT auth.uid() AS uid))));
