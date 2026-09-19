-- ============================================
-- AUDIT ALERT WEBHOOK
-- Migration: 20260307_audit_alert_webhook
-- Task: TASK-2143 / BACKLOG-861
-- SOC 2 Control: CC7.2 - Monitoring and alerting for anomalies
--
-- Purpose: Create a database trigger on admin_audit_logs that fires
-- AFTER INSERT for high-risk actions. The trigger invokes the
-- audit-alert Edge Function via Supabase's pg_net extension to
-- deliver webhook alerts without blocking the original admin action.
--
-- High-risk actions:
--   - user.impersonate.start (impersonation started)
--   - user.suspend (user suspended)
--   - internal_user.add (privilege grant)
--   - internal_user.remove (internal user removed)
--   - internal_user.role_change (role change / privilege escalation)
--   - role.create (new role created)
--   - role.delete (role deleted)
--   - role.update_permissions (permissions modified)
--   - auth.login_failed (authentication failure)
--
-- Architecture:
--   admin_audit_logs INSERT
--     -> AFTER INSERT trigger (does NOT block the insert)
--       -> pg_net HTTP POST to audit-alert Edge Function
--         -> Edge Function sends webhook to AUDIT_ALERT_WEBHOOK_URL
--
-- This two-hop approach (trigger -> Edge Function -> webhook) keeps the
-- webhook URL configuration in the Edge Function environment, avoiding
-- storing secrets in the database.
-- ============================================

-- Ensure pg_net extension is available for async HTTP requests
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Create the trigger function
CREATE OR REPLACE FUNCTION public.notify_high_risk_audit_action()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_supabase_url TEXT;
  v_service_role_key TEXT;
  v_function_url TEXT;
  v_payload JSONB;
  v_high_risk_actions TEXT[] := ARRAY[
    'user.impersonate.start',
    'user.suspend',
    'internal_user.add',
    'internal_user.remove',
    'internal_user.role_change',
    'role.create',
    'role.delete',
    'role.update_permissions',
    'auth.login_failed'
  ];
BEGIN
  -- Only process high-risk actions
  IF NOT (NEW.action = ANY(v_high_risk_actions)) THEN
    RETURN NEW;
  END IF;

  -- Get Supabase project URL from app settings
  -- These are set automatically by Supabase in the database
  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_role_key := current_setting('app.settings.service_role_key', true);

  -- If settings are not available, try environment-based approach
  IF v_supabase_url IS NULL THEN
    -- Fallback: use the Supabase project URL from vault or config
    -- This will be set during deployment
    v_supabase_url := current_setting('supabase.url', true);
  END IF;

  -- If we still don't have a URL, log and exit gracefully
  IF v_supabase_url IS NULL THEN
    RAISE WARNING '[audit-alert] Cannot send alert: Supabase URL not configured. Action: %', NEW.action;
    RETURN NEW;
  END IF;

  v_function_url := v_supabase_url || '/functions/v1/audit-alert';

  -- Build the webhook payload matching the expected format
  v_payload := jsonb_build_object(
    'type', 'INSERT',
    'table', 'admin_audit_logs',
    'schema', 'public',
    'record', jsonb_build_object(
      'id', NEW.id,
      'actor_id', NEW.actor_id,
      'action', NEW.action,
      'target_type', NEW.target_type,
      'target_id', NEW.target_id,
      'metadata', COALESCE(NEW.metadata, '{}'::jsonb),
      'ip_address', NEW.ip_address::text,
      'created_at', NEW.created_at
    ),
    'old_record', NULL
  );

  -- Send async HTTP POST via pg_net (non-blocking)
  -- pg_net.http_post returns immediately; the HTTP call happens asynchronously.
  -- If it fails, the audit log insert is NOT affected.
  PERFORM net.http_post(
    url := v_function_url,
    body := v_payload,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || COALESCE(v_service_role_key, '')
    )
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Fire-and-forget: never block the audit log insert
    RAISE WARNING '[audit-alert] Failed to send alert (non-blocking): % - %', SQLSTATE, SQLERRM;
    RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS audit_high_risk_alert ON public.admin_audit_logs;

-- Create AFTER INSERT trigger
-- IMPORTANT: AFTER INSERT ensures the audit log entry is committed
-- before the alert is sent. This prevents the alert from blocking
-- the original admin action.
CREATE TRIGGER audit_high_risk_alert
  AFTER INSERT ON public.admin_audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_high_risk_audit_action();

-- Add a comment for documentation
COMMENT ON FUNCTION public.notify_high_risk_audit_action() IS
  'SOC 2 CC7.2: Sends webhook alerts for high-risk admin actions via the audit-alert Edge Function. Fire-and-forget -- never blocks the audit log insert.';

COMMENT ON TRIGGER audit_high_risk_alert ON public.admin_audit_logs IS
  'SOC 2 CC7.2: Fires after high-risk admin action is logged. Sends async alert via pg_net to audit-alert Edge Function.';
