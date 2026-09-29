-- BACKLOG-3608: client-role updates of transaction_submissions.
--
-- 1. public.guard_status_history_append_only() (BACKLOG-3477). On UPDATE by
--    a statement that runs as a client role (authenticated / anon):
--    a. status_history may not change at all. Entries are written by
--       track_submission_status_changes (a BEFORE UPDATE trigger that fires
--       after this guard, so the guard never sees its entry) and by the
--       SECURITY DEFINER review functions, whose statements run as their
--       owner, not as the client role. Neither path changes. A future writer
--       must be SECURITY DEFINER: a SECURITY INVOKER function called by a
--       client runs as the client role and is refused.
--    b. reviewed_by, reviewed_at and review_notes may change only when the
--       caller can review the row's current organization, and reviewed_by
--       may only be set to the caller's own id
--       (errcode 42501, 'review_fields_reviewer_only').
--    c. id, organization_id, submitted_by, local_transaction_id,
--       parent_submission_id and version may not change
--       (errcode 42501, 'submission_owner_fields_locked').
--    The service role and owner connections bypass the guard, as before.
--    Every other rule of the guard is unchanged: existing entries must stay
--    unchanged and in place, and every appended entry must be a typed object
--    naming the caller.
--
-- 2. transaction_submissions_update_public: the submitter branch's USING
--    matches only the submitter's own 'uploading' rows (was 'needs_changes'
--    or 'uploading'). The reviewer branch, the WITH CHECK and the role list
--    are unchanged from BACKLOG-3596.
--
-- No table, grant or row changes. Apply as ONE transaction: the policy is
-- dropped and re-created.

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

  IF current_user IN ('authenticated', 'anon') THEN
    -- Review fields: a reviewer of the row's current organization, naming
    -- itself.
    IF NEW.reviewed_by     IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at  IS DISTINCT FROM OLD.reviewed_at
       OR NEW.review_notes IS DISTINCT FROM OLD.review_notes THEN
      IF NOT public.can_review_submission(OLD.organization_id) THEN
        RAISE EXCEPTION 'review_fields_reviewer_only' USING ERRCODE = '42501';
      END IF;
      IF NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
         AND NEW.reviewed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'review_fields_reviewer_only' USING ERRCODE = '42501';
      END IF;
    END IF;
    -- Ownership columns are fixed for a client statement.
    IF NEW.id                      IS DISTINCT FROM OLD.id
       OR NEW.organization_id      IS DISTINCT FROM OLD.organization_id
       OR NEW.submitted_by         IS DISTINCT FROM OLD.submitted_by
       OR NEW.local_transaction_id IS DISTINCT FROM OLD.local_transaction_id
       OR NEW.parent_submission_id IS DISTINCT FROM OLD.parent_submission_id
       OR NEW.version              IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'submission_owner_fields_locked' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.status_history IS NOT DISTINCT FROM OLD.status_history THEN
    RETURN NEW;
  END IF;

  -- A client statement may not change the history at all.
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'status_history_append_only' USING ERRCODE = '42501';
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

-- ---------------------------------------------------------------------------
-- 2. UPDATE rule. Copied from BACKLOG-3596 (20260928120000, section 6); the
--    only change is the submitter branch's USING status list.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS transaction_submissions_update_public ON public.transaction_submissions;
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions
  FOR UPDATE TO public
  USING (
    ((submitted_by = ( SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text))
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
