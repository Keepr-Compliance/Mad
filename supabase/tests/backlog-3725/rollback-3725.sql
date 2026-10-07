-- BACKLOG-3725 rollback: returns the catalogue to the state after
-- 20261004192647_backlog_3403_finalize_submission.sql (its text, verbatim).
-- Run as ONE transaction. Drops transaction_submissions.abandoned_at.

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
  IF coalesce(v_sub.submission_metadata->>'abandoned', '') = 'true' THEN
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

DROP POLICY IF EXISTS agents_can_delete_own_attachments ON public.submission_attachments;
CREATE POLICY agents_can_delete_own_attachments ON public.submission_attachments
  FOR DELETE
  USING (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)
       AND (transaction_submissions.status)::text = 'uploading'::text
       AND coalesce(transaction_submissions.submission_metadata->>'abandoned', '') = 'true'));

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
         AND coalesce(s.submission_metadata->>'abandoned', '') = 'true')));

DROP POLICY IF EXISTS transaction_submissions_update_public ON public.transaction_submissions;
CREATE POLICY transaction_submissions_update_public ON public.transaction_submissions
  FOR UPDATE
  USING (
    ((submitted_by = (SELECT auth.uid() AS uid)) AND ((status)::text = 'uploading'::text))
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

DROP TRIGGER IF EXISTS submission_abandoned_at_guard ON public.transaction_submissions;
DROP FUNCTION IF EXISTS public.guard_submission_abandoned_at();
ALTER TABLE public.transaction_submissions DROP COLUMN IF EXISTS abandoned_at;
