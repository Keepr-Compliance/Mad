-- BACKLOG-3608 rollback. Restores the state before 20260929130000:
--   * public.guard_status_history_append_only(): the BACKLOG-3477 body
--     (body md5 46aba17498774aa04a64e679e5a39c84), INVOKER, search_path "",
--     EXECUTE for postgres and service_role only (CREATE OR REPLACE keeps
--     the ACL; the REVOKE below re-states it).
--   * transaction_submissions_update_public: the BACKLOG-3596 text
--     (20260928120000, section 6).
-- Run as ONE transaction.

CREATE OR REPLACE FUNCTION public.guard_status_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_role    text := auth.role();
  v_old     jsonb;
  v_new     jsonb := NEW.status_history;
  v_old_len integer;
  v_new_len integer;
  v_elem    jsonb;
  i         integer;
BEGIN
  IF v_role IS NULL OR v_role = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_new IS NOT NULL AND v_new <> '[]'::jsonb THEN
      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status_history IS NOT DISTINCT FROM OLD.status_history THEN
    RETURN NEW;
  END IF;

  v_old := COALESCE(OLD.status_history, '[]'::jsonb);
  IF jsonb_typeof(v_old) <> 'array' THEN
    v_old := '[]'::jsonb;
  END IF;
  IF v_new IS NULL OR jsonb_typeof(v_new) <> 'array' THEN
    RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
  END IF;

  v_old_len := jsonb_array_length(v_old);
  v_new_len := jsonb_array_length(v_new);

  -- Every existing entry must still be there, unchanged, at the same index.
  -- (A shorter array fails here too: the missing index reads as NULL.)
  FOR i IN 0 .. v_old_len - 1 LOOP
    IF (v_new -> i) IS DISTINCT FROM (v_old -> i) THEN
      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Every appended entry must be a typed object naming the caller.
  FOR i IN v_old_len .. v_new_len - 1 LOOP
    v_elem := v_new -> i;
    IF jsonb_typeof(v_elem) <> 'object'
       OR NOT (v_elem ? 'type')
       OR lower(COALESCE(v_elem ->> 'changed_by', '')) IS DISTINCT FROM COALESCE(auth.uid()::text, '-') THEN
      RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END
$$;

REVOKE EXECUTE ON FUNCTION public.guard_status_history_append_only() FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS transaction_submissions_update_public ON public.transaction_submissions;
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions
  FOR UPDATE TO public
  USING (
    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'uploading'::text])))
    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))
        AND (organization_id IN ( SELECT organization_members.organization_id
           FROM organization_members
          WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text]))))))
  )
  WITH CHECK (
    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['needs_changes'::text, 'resubmitted'::text, 'uploading'::text, 'submitted'::text])))
    OR (organization_id IN ( SELECT organization_members.organization_id
       FROM organization_members
      WHERE ((organization_members.user_id = ( SELECT auth.uid() AS uid)) AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))
  );
