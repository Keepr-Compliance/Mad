-- ============================================
-- TICKET CONFIRMATION WEBHOOK: SHARED SECRET HEADER
-- Migration: 20261004120000_backlog_3711_ticket_webhook_secret
-- Task: BACKLOG-3711
--
-- 1. Creates a Vault secret `ticket_webhook_secret` with a value generated
--    inside the database (no person handles it).
-- 2. The support_tickets INSERT trigger sends it as `x-webhook-secret`.
-- 3. `public.ticket_webhook_secret()` returns it to service_role only, so the
--    send-ticket-confirmation Edge Function can compare the header.
--
-- APPLY ORDER: this migration BEFORE deploying the matching Edge Function.
-- The new function rejects requests without the header.
-- ============================================

-- 1. Secret (idempotent; never regenerated if present)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'ticket_webhook_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'ticket_webhook_secret',
      'BACKLOG-3711: x-webhook-secret for the send-ticket-confirmation Edge Function'
    );
  END IF;
END
$$;

-- 2. Service-role-only accessor for the Edge Function
CREATE OR REPLACE FUNCTION public.ticket_webhook_secret()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT decrypted_secret
  FROM vault.decrypted_secrets
  WHERE name = 'ticket_webhook_secret'
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.ticket_webhook_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ticket_webhook_secret() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_webhook_secret() TO service_role;

COMMENT ON FUNCTION public.ticket_webhook_secret() IS
  'BACKLOG-3711: returns the send-ticket-confirmation webhook secret. service_role only.';

-- 3. Trigger function sends the header
CREATE OR REPLACE FUNCTION public.notify_ticket_confirmation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _project_url text := 'https://nercleijfrxqcvfjskbc.supabase.co';
  _function_url text;
  _payload jsonb;
  _secret text;
BEGIN
  _function_url := _project_url || '/functions/v1/send-ticket-confirmation';

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'ticket_webhook_secret'
  LIMIT 1;

  _payload := jsonb_build_object(
    'type', 'INSERT',
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', jsonb_build_object(
      'id', NEW.id,
      'ticket_number', NEW.ticket_number,
      'subject', NEW.subject,
      'requester_email', NEW.requester_email,
      'requester_name', NEW.requester_name,
      'source_channel', NEW.source_channel,
      'created_at', NEW.created_at
    ),
    'old_record', null
  );

  -- Fire-and-forget: pg_net.http_post is async, does not block the INSERT
  PERFORM net.http_post(
    url := _function_url,
    body := _payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', COALESCE(_secret, '')
    )
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.notify_ticket_confirmation() IS
  'BACKLOG-1573/3711: async trigger that calls send-ticket-confirmation on ticket INSERT, authenticated with x-webhook-secret.';
