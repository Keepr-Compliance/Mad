-- Drift fixture for A: an accept_invitation with a different body already exists.
CREATE FUNCTION public.accept_invitation(p_token text, p_tenant_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql AS $f$ SELECT '{}'::jsonb $f$;
