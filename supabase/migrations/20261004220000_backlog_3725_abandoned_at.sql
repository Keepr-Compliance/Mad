-- BACKLOG-3725: the submission abandon marker becomes its own column.
--
-- Applied AFTER 20261004192647_backlog_3403_finalize_submission.sql. Apply as
-- ONE transaction (`psql -1 -f <file>`, or the whole file in one SQL editor
-- run). It opens none of its own, and every statement is safe to run twice.
--
--   1. public.transaction_submissions.abandoned_at timestamptz NULL.
--      The desktop fences an upload it is giving up on with
--        UPDATE transaction_submissions SET abandoned_at = now()
--         WHERE id = $1 AND status = 'uploading' AND abandoned_at IS NULL;
--      0 rows = already committed or already abandoned.
--
--   2. transaction_submissions_update_public: the submitter branch of USING
--      also requires abandoned_at IS NULL, so no client statement (a 2.38
--      desktop's status flip included) reaches a fenced row. Otherwise the
--      20261004192647 text.
--
--   3. public.guard_submission_abandoned_at() BEFORE INSERT OR UPDATE trigger,
--      for client statements (current_user authenticated / anon) only; the
--      service role and SECURITY DEFINER functions (current_user postgres,
--      e.g. a server sweep) pass through:
--        - INSERT: abandoned_at must be NULL.
--        - UPDATE that changes abandoned_at: only the submitter, only while
--          the row is and stays 'uploading', and only from NULL to a value.
--      A trigger, because the policies cannot compare old and new values:
--      USING sees the old row, WITH CHECK the new one. The "only from NULL"
--      term is extra protection: with the USING term in (2), no client UPDATE
--      reaches a row whose abandoned_at is set.
--
--   4. public.finalize_submission: the 20261004192647 body verbatim, except
--      the abandon check reads abandoned_at instead of
--      submission_metadata->>'abandoned'.
--
--   5. agents_can_delete_own_attachments and the storage policy
--      "Submitters can delete attachments of their abandoned upload": the
--      20261004192647 text, with abandoned_at IS NOT NULL in place of the
--      submission_metadata term.
--
-- 2.38 desktops never set abandoned_at; their cleanup ends with the parent
-- delete, which cascades to every child row.
--
-- Rollback: supabase/tests/backlog-3725/rollback-3725.sql.

-- ---------------------------------------------------------------------------
-- 1. Column.
-- ---------------------------------------------------------------------------
ALTER TABLE public.transaction_submissions
  ADD COLUMN IF NOT EXISTS abandoned_at timestamptz NULL;

COMMENT ON COLUMN public.transaction_submissions.abandoned_at IS
  'BACKLOG-3725: set once by the submitter while uploading, when the desktop gives up on the upload. finalize_submission refuses a set row; the submitter may then delete its files and rows.';

-- ---------------------------------------------------------------------------
-- 2. Guard trigger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_submission_abandoned_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'abandoned_at_insert' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at THEN
    IF OLD.abandoned_at IS NOT NULL
       OR OLD.submitted_by IS DISTINCT FROM auth.uid()
       OR (OLD.status)::text <> 'uploading'
       OR (NEW.status)::text <> 'uploading' THEN
      RAISE EXCEPTION 'abandoned_at_submitter_once_while_uploading' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.guard_submission_abandoned_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS submission_abandoned_at_guard ON public.transaction_submissions;
CREATE TRIGGER submission_abandoned_at_guard
  BEFORE INSERT OR UPDATE ON public.transaction_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_submission_abandoned_at();

-- ---------------------------------------------------------------------------
-- 3. Submission UPDATE policy.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS transaction_submissions_update_public ON public.transaction_submissions;
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions
  FOR UPDATE
  USING (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text) AND (abandoned_at IS NULL))
    OR (((status)::text = ANY (ARRAY['submitted'::text, 'resubmitted'::text, 'under_review'::text]))
        AND (organization_id IN (SELECT organization_members.organization_id
                                   FROM public.organization_members
                                  WHERE ((organization_members.user_id = (SELECT auth.uid() AS uid))
                                    AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))))
  WITH CHECK (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = ANY (ARRAY['resubmitted'::text, 'uploading'::text, 'submitted'::text])))
    OR (((status)::text <> 'uploading'::text)
        AND (organization_id IN (SELECT organization_members.organization_id
                                   FROM public.organization_members
                                  WHERE ((organization_members.user_id = (SELECT auth.uid() AS uid))
                                    AND ((organization_members.role)::text = ANY (ARRAY[('broker'::character varying)::text, ('admin'::character varying)::text])))))));

-- ---------------------------------------------------------------------------
-- 4. finalize_submission.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_submission(p_submission_id uuid, p_manifest jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_sub public.transaction_submissions%ROWTYPE;
  v_target text;
  v_msgs uuid[];
  v_att jsonb := coalesce(p_manifest->'attachments', '[]'::jsonb);
  v_att_ids int;
  v_prefix text;
  v_msg_missing int; v_msg_extra int;
  v_att_missing int; v_att_extra int; v_obj_missing int; v_outside int; v_link_bad int;
  v_cl_expected int := nullif(p_manifest->>'checklists', '')::int;
  v_cl_found int := 0;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated'); END IF;
  SELECT * INTO v_sub FROM public.transaction_submissions WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'not_found'); END IF;
  IF v_sub.submitted_by <> v_uid THEN RETURN jsonb_build_object('ok', false, 'code', 'not_owner'); END IF;
  v_target := CASE WHEN v_sub.parent_submission_id IS NOT NULL THEN 'resubmitted' ELSE 'submitted' END;
  IF v_sub.status = v_target THEN RETURN jsonb_build_object('ok', true, 'already_final', true, 'status', v_target); END IF;
  IF v_sub.status <> 'uploading' THEN RETURN jsonb_build_object('ok', false, 'code', 'not_uploading'); END IF;
  IF v_sub.abandoned_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'abandoned');
  END IF;

  SELECT coalesce(array_agg(DISTINCT x::uuid), '{}') INTO v_msgs
    FROM jsonb_array_elements_text(coalesce(p_manifest->'message_ids', '[]'::jsonb)) x;
  SELECT count(*) INTO v_msg_missing FROM unnest(v_msgs) d
   WHERE NOT EXISTS (SELECT 1 FROM public.submission_messages m WHERE m.id = d AND m.submission_id = p_submission_id);
  SELECT count(*) INTO v_msg_extra FROM public.submission_messages m
   WHERE m.submission_id = p_submission_id AND NOT (m.id = ANY(v_msgs));

  v_prefix := v_sub.organization_id::text || '/' || p_submission_id::text || '/';
  WITH d AS (
    SELECT (e->>'id')::uuid id, e->>'storage_path' path, nullif(e->>'message_id', '')::uuid message_id
      FROM jsonb_array_elements(v_att) e)
  SELECT count(*) FILTER (WHERE a.id IS NULL OR a.storage_path IS DISTINCT FROM d.path),
         count(*) FILTER (WHERE a.id IS NOT NULL AND (a.message_id IS DISTINCT FROM d.message_id
                                OR (d.message_id IS NOT NULL AND NOT (d.message_id = ANY(v_msgs))))),
         count(*) FILTER (WHERE d.path IS NULL OR left(d.path, length(v_prefix)) <> v_prefix),
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM storage.objects o
                                WHERE o.bucket_id = 'submission-attachments' AND o.name = d.path)),
         count(DISTINCT d.id)
    INTO v_att_missing, v_link_bad, v_outside, v_obj_missing, v_att_ids
    FROM d LEFT JOIN public.submission_attachments a ON a.id = d.id AND a.submission_id = p_submission_id;
  SELECT count(*) INTO v_att_extra FROM public.submission_attachments a
   WHERE a.submission_id = p_submission_id
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_att) e WHERE (e->>'id')::uuid = a.id);

  IF v_cl_expected IS NOT NULL THEN
    SELECT count(*) INTO v_cl_found FROM public.submission_checklists c WHERE c.submission_id = p_submission_id;
  END IF;

  IF v_msg_missing + v_msg_extra + v_att_missing + v_att_extra + v_obj_missing + v_outside + v_link_bad > 0
     OR (v_cl_expected IS NOT NULL AND v_cl_found <> v_cl_expected) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'incomplete',
      'messages_missing', v_msg_missing, 'messages_extra', v_msg_extra,
      'attachment_rows_missing', v_att_missing, 'attachment_rows_extra', v_att_extra,
      'objects_missing', v_obj_missing, 'paths_outside_submission', v_outside,
      'attachment_message_links_wrong', v_link_bad,
      'checklists_expected', v_cl_expected, 'checklists_found', v_cl_found);
  END IF;

  UPDATE public.transaction_submissions
     SET status = v_target,
         message_count = cardinality(v_msgs),
         attachment_count = v_att_ids,
         submission_metadata = coalesce(submission_metadata, '{}'::jsonb)
                               || jsonb_build_object('finalized_by', 'finalize_submission')
   WHERE id = p_submission_id;

  INSERT INTO public.submission_attempts AS a
    (submission_id, user_id, organization_id, is_resubmit, outcome, stage, ended_at)
  VALUES
    (p_submission_id, v_uid, v_sub.organization_id, v_sub.parent_submission_id IS NOT NULL, 'committed', 'finalize', now())
  ON CONFLICT (submission_id) DO UPDATE
     SET outcome = 'committed', stage = 'finalize', reason_code = NULL, updated_at = now(), ended_at = now()
   WHERE a.user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'already_final', false, 'status', v_target);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_submission(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Delete policies.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS agents_can_delete_own_attachments ON public.submission_attachments;
CREATE POLICY agents_can_delete_own_attachments ON public.submission_attachments
  FOR DELETE
  USING (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)
       AND (transaction_submissions.status)::text = 'uploading'::text
       AND transaction_submissions.abandoned_at IS NOT NULL));

DROP POLICY IF EXISTS "Submitters can delete attachments of their abandoned upload" ON storage.objects;
CREATE POLICY "Submitters can delete attachments of their abandoned upload" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    (bucket_id = 'submission-attachments'::text)
    AND (EXISTS (
      SELECT 1
        FROM public.transaction_submissions s
       WHERE s.id = CASE
                      WHEN (split_part(objects.name, '/'::text, 2) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text)
                        THEN (split_part(objects.name, '/'::text, 2))::uuid
                      ELSE NULL::uuid
                    END
         AND (s.organization_id)::text = split_part(objects.name, '/'::text, 1)
         AND s.submitted_by = (SELECT auth.uid() AS uid)
         AND (s.status)::text = 'uploading'::text
         AND s.abandoned_at IS NOT NULL)));
