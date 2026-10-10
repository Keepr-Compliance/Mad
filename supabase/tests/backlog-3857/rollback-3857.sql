-- BACKLOG-3857 rollback: restores the license_type CHECK, the four column
-- defaults and the admin_update_license body as they were before
-- 20261010120000_backlog_3857_no_trial_license_type.sql.

BEGIN;

ALTER TABLE public.licenses DROP CONSTRAINT IF EXISTS licenses_license_type_check;
ALTER TABLE public.licenses ADD CONSTRAINT licenses_license_type_check
  CHECK (license_type = ANY (ARRAY['trial'::text, 'individual'::text, 'team'::text]));

ALTER TABLE public.licenses ALTER COLUMN license_type SET DEFAULT 'trial'::text;
ALTER TABLE public.licenses ALTER COLUMN trial_status SET DEFAULT 'active'::text;
ALTER TABLE public.licenses ALTER COLUMN trial_started_at SET DEFAULT now();
ALTER TABLE public.licenses ALTER COLUMN trial_expires_at SET DEFAULT (now() + '14 days'::interval);

CREATE OR REPLACE FUNCTION public.admin_update_license(p_license_id uuid, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_license RECORD;
  v_old_values JSONB;
BEGIN
  IF NOT public.has_internal_role(auth.uid()) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_license FROM public.licenses WHERE id = p_license_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'License not found';
  END IF;

  v_old_values := jsonb_build_object(
    'status', v_license.status,
    'expires_at', v_license.expires_at,
    'license_type', v_license.license_type,
    'transaction_limit', v_license.transaction_limit,
    'trial_status', v_license.trial_status
  );

  IF p_changes ? 'status' THEN
    UPDATE public.licenses SET status = (p_changes->>'status'), updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'expires_at' THEN
    UPDATE public.licenses SET expires_at = (p_changes->>'expires_at')::TIMESTAMPTZ, updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'license_type' THEN
    UPDATE public.licenses SET license_type = (p_changes->>'license_type'), updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'transaction_limit' THEN
    UPDATE public.licenses SET transaction_limit = (p_changes->>'transaction_limit')::INTEGER, updated_at = NOW() WHERE id = p_license_id;
  END IF;
  IF p_changes ? 'trial_status' THEN
    UPDATE public.licenses SET trial_status = (p_changes->>'trial_status'), updated_at = NOW() WHERE id = p_license_id;
  END IF;

  PERFORM public.log_admin_action(
    'license.update',
    'license',
    p_license_id::TEXT,
    jsonb_build_object('old_values', v_old_values, 'new_values', p_changes, 'user_id', v_license.user_id)
  );

  RETURN jsonb_build_object('success', true, 'old_values', v_old_values, 'new_values', p_changes);
END;
$fn$;

COMMIT;
