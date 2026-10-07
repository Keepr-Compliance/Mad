-- FIXTURE (BACKLOG-3611). Transcribed from supabase/migrations/20261001044453_backlog_3611_function_execute_grants.sql
-- lines 1-22: function renamed support_update_template_copy (a NEW function), REVOKE line removed.
-- support_update_template_copy: require an internal_roles caller.
CREATE OR REPLACE FUNCTION public.support_update_template_copy(p_id uuid, p_name text, p_body text, p_category text DEFAULT NULL::text, p_is_active boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Support agent access required' USING ERRCODE = '42501';
  END IF;

  UPDATE support_response_templates
  SET name = p_name, body = p_body, category = p_category, 
      is_active = p_is_active, updated_by = auth.uid(), updated_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'updated', true);
END;
$function$
;

