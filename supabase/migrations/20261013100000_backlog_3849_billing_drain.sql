-- ============================================
-- BILLING OUTBOX DRAIN: secret + invoker
-- Migration: 20261013100000_backlog_3849_billing_drain
-- Task: BACKLOG-3849 (depends on BACKLOG-3845: billing_outbox, billing_outbox_claim)
--
-- 1. Vault secret `billing_drain_secret` (generated in the database, never
--    regenerated). The drain route reads it through (2) and compares it with the
--    x-billing-drain-secret header.
-- 2. public.billing_drain_secret()        -> the secret, service_role only.
-- 3. public.billing_drain_invoke(target)  -> pg_net POST to the drain route of one
--    deployment ('live' or 'test'). The URL is read from the vault secret
--    `billing_drain_url_<target>`, which is NOT created here: it is set by SQL
--    applied from the tracker when a schedule is turned on. Without it the
--    function raises 55000 and nothing is sent.
--
-- Additive: no table change, no schedule. The cron jobs that call (3) are
-- separate migrations applied on their own go.
-- ============================================

-- 1. Secret (idempotent; an existing value is never replaced)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'billing_drain_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'billing_drain_secret',
      'BACKLOG-3849: x-billing-drain-secret for the billing outbox drain route'
    );
  END IF;
END
$$;

-- 2. Secret accessor for the drain route (service role only)
CREATE OR REPLACE FUNCTION public.billing_drain_secret()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT decrypted_secret FROM vault.decrypted_secrets
           WHERE name = 'billing_drain_secret' LIMIT 1);
END;
$$;

-- 3. Invoker for the cron jobs (runs as the job owner). The target is checked
--    before any vault read, so no other secret name can be looked up through it.
--    pg_net is asynchronous; the timeout matches the route's maxDuration.
CREATE OR REPLACE FUNCTION public.billing_drain_invoke(p_target text)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  IF p_target IS NULL OR p_target NOT IN ('live', 'test') THEN
    RAISE EXCEPTION 'billing_drain_invoke: target must be live or test' USING ERRCODE = '22023';
  END IF;
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets
   WHERE name = 'billing_drain_url_' || p_target LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name = 'billing_drain_secret' LIMIT 1;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE EXCEPTION 'billing drain (%) is not configured', p_target USING ERRCODE = '55000';
  END IF;
  RETURN net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-billing-drain-secret', v_secret),
    timeout_milliseconds := 60000
  );
END;
$$;

COMMENT ON FUNCTION public.billing_drain_invoke(text) IS
  'BACKLOG-3849: posts to the billing outbox drain route of the live or test deployment. Called by the cron jobs only.';

-- Grants: the accessor for service_role only; the invoker for nobody but its
-- owner (the default ACL on public grants new functions to service_role too).
REVOKE ALL ON FUNCTION public.billing_drain_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_drain_secret() TO service_role;

REVOKE ALL ON FUNCTION public.billing_drain_invoke(text) FROM PUBLIC, anon, authenticated, service_role;
