-- BACKLOG-3403: all-or-nothing submission, database part.
--
-- Applied AFTER 20261003195046 (production ledger head on 2026-10-04). Apply as
-- ONE transaction (`psql -1 -f <file>`, or the whole file in one SQL editor
-- run). It opens none of its own, and every statement is safe to run twice.
--
--   1. Indexes on submission_messages(submission_id) and
--      submission_attachments(submission_id).
--
--   2. public.submission_attempts: one row per submit attempt (keyed by the
--      submission id the desktop mints for that attempt). Outcome, last stage,
--      a reason code (snake_case, never free text), retry count, counts only,
--      timestamps. No foreign key to transaction_submissions: an attempt whose
--      submission row was removed keeps its row.
--        SELECT: the agent who made it, a reviewer of its organization
--          (can_review_submission), or an internal user.
--        INSERT / UPDATE / DELETE: none for clients. Writes go through
--          record_submission_attempt() and finalize_submission().
--
--   3. public.record_submission_attempt(...): SECURITY DEFINER. Creates or
--      updates the caller's row for a submission id. Keeps only snake_case
--      count keys with whole-number values. A row already marked committed
--      is not changed. Refuses outcome 'committed' (code
--      committed_is_server_only): only finalize_submission writes it.
--
--   4. public.finalize_submission(submission, manifest): SECURITY DEFINER.
--      Verifies that the stored messages, attachment rows, storage objects
--      and checklist headers equal the manifest, then moves the submission
--      from 'uploading' to 'submitted' (or 'resubmitted' when it has a
--      parent) in one UPDATE, and marks the attempt row committed. Returns
--      jsonb; refusals carry counts only and write nothing.
--      Manifest: { message_ids: uuid[],
--                  attachments: [{id, storage_path, message_id|null}],
--                  checklists: int|null }
--      Codes: not_authenticated, not_found, not_owner, not_uploading,
--             abandoned (submission_metadata.abandoned = true), incomplete.
--      submission_metadata.excluded_files (files the agent chose to leave
--      out) is not part of the manifest and is kept as written.
--
--   5. RLS:
--      - agents_can_insert_messages: the parent must be 'uploading'.
--      - agents_can_insert_attachments: the parent must be 'uploading', and
--        storage_path must start with {organization_id}/{submission_id}/.
--      - transaction_submissions_update_public: the reviewer branch of
--        WITH CHECK no longer accepts status 'uploading'. Otherwise the
--        production text.
--      - agents_can_delete_own_attachments: the parent must also be marked
--        abandoned. (A 2.38 cleanup still ends with every row gone: its parent
--        delete cascades.)
--      - storage.objects: new DELETE policy for bucket submission-attachments:
--        the submitter of the submission named by the path, while it is
--        'uploading' and marked abandoned.
--
-- Rollback: supabase/tests/backlog-3403/rollback-3403.sql.

-- ---------------------------------------------------------------------------
-- 1. Indexes.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS submission_messages_submission_id_idx
  ON public.submission_messages (submission_id);
CREATE INDEX IF NOT EXISTS submission_attachments_submission_id_idx
  ON public.submission_attachments (submission_id);

-- ---------------------------------------------------------------------------
-- 2. Per-attempt table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.submission_attempts (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  submission_id    uuid        NOT NULL,
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  is_resubmit      boolean     NOT NULL DEFAULT false,
  outcome          text        NOT NULL DEFAULT 'in_progress',
  stage            text        NULL,
  reason_code      text        NULL,
  retry_count      integer     NOT NULL DEFAULT 0,
  counts           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  app_version      text        NULL,
  platform         text        NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz NULL,
  CONSTRAINT submission_attempts_submission_id_key UNIQUE (submission_id),
  CONSTRAINT submission_attempts_outcome_check
    CHECK (outcome IN ('in_progress', 'committed', 'failed', 'abandoned', 'cancelled', 'unconfirmed')),
  CONSTRAINT submission_attempts_stage_check CHECK (stage IS NULL OR stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT submission_attempts_reason_check CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT submission_attempts_retry_check CHECK (retry_count BETWEEN 0 AND 1000),
  CONSTRAINT submission_attempts_counts_check CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT submission_attempts_app_version_check CHECK (app_version IS NULL OR app_version ~ '^[0-9A-Za-z.+-]{1,40}$'),
  CONSTRAINT submission_attempts_platform_check CHECK (platform IS NULL OR platform ~ '^[a-z0-9_]{1,20}$')
);

CREATE INDEX IF NOT EXISTS submission_attempts_org_started_idx
  ON public.submission_attempts (organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS submission_attempts_user_started_idx
  ON public.submission_attempts (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS submission_attempts_started_idx
  ON public.submission_attempts (started_at DESC);

ALTER TABLE public.submission_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.submission_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.submission_attempts TO authenticated;
GRANT ALL ON public.submission_attempts TO service_role;

DROP POLICY IF EXISTS submission_attempts_select ON public.submission_attempts;
CREATE POLICY submission_attempts_select ON public.submission_attempts
  FOR SELECT TO authenticated
  USING (
    (user_id = (SELECT auth.uid()))
    OR public.can_review_submission(organization_id)
    OR EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid()))
  );

COMMENT ON TABLE public.submission_attempts IS
  'BACKLOG-3403: one row per desktop submit attempt (outcome, stage, reason code, counts only). Written only by record_submission_attempt() and finalize_submission(). Read by the agent, reviewers of the organization, and internal users.';

-- ---------------------------------------------------------------------------
-- 3. record_submission_attempt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_submission_attempt(
  p_submission_id   uuid,
  p_organization_id uuid,
  p_outcome         text,
  p_stage           text    DEFAULT NULL,
  p_reason_code     text    DEFAULT NULL,
  p_retry_count     integer DEFAULT 0,
  p_counts          jsonb   DEFAULT '{}'::jsonb,
  p_is_resubmit     boolean DEFAULT false,
  p_app_version     text    DEFAULT NULL,
  p_platform        text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_existing public.submission_attempts%ROWTYPE;
  v_counts   jsonb;
  v_row      public.submission_attempts%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;
  IF p_submission_id IS NULL OR p_organization_id IS NULL OR p_outcome IS NULL THEN
    RAISE EXCEPTION 'missing_argument' USING ERRCODE = '22023';
  END IF;
  IF p_outcome = 'committed' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'committed_is_server_only');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organization_members om
                  WHERE om.organization_id = p_organization_id AND om.user_id = v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_member');
  END IF;
  IF EXISTS (SELECT 1 FROM public.transaction_submissions s
              WHERE s.id = p_submission_id
                AND (s.submitted_by <> v_uid OR s.organization_id <> p_organization_id)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner');
  END IF;

  SELECT * INTO v_existing FROM public.submission_attempts a
   WHERE a.submission_id = p_submission_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id <> v_uid OR v_existing.organization_id <> p_organization_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'not_owner');
    END IF;
    IF v_existing.outcome = 'committed' THEN
      RETURN jsonb_build_object('ok', true, 'outcome', 'committed', 'unchanged', true);
    END IF;
  END IF;

  -- Counts only: snake_case keys, whole numbers 0..999999999. Anything else is dropped.
  SELECT coalesce(jsonb_object_agg(k.key, (k.value #>> '{}')::bigint), '{}'::jsonb)
    INTO v_counts
    FROM (SELECT e.key, e.value
            FROM jsonb_each(CASE WHEN jsonb_typeof(p_counts) = 'object' THEN p_counts ELSE '{}'::jsonb END) e
           WHERE e.key ~ '^[a-z][a-z0-9_]{0,39}$'
             AND jsonb_typeof(e.value) = 'number'
             AND (e.value #>> '{}') ~ '^[0-9]{1,9}$'
           ORDER BY e.key
           LIMIT 40) k;

  INSERT INTO public.submission_attempts AS a
    (submission_id, user_id, organization_id, is_resubmit, outcome, stage, reason_code,
     retry_count, counts, app_version, platform, ended_at)
  VALUES
    (p_submission_id, v_uid, p_organization_id, coalesce(p_is_resubmit, false), p_outcome, p_stage, p_reason_code,
     coalesce(p_retry_count, 0), v_counts, p_app_version, p_platform,
     CASE WHEN p_outcome = 'in_progress' THEN NULL ELSE now() END)
  ON CONFLICT (submission_id) DO UPDATE
     SET outcome     = EXCLUDED.outcome,
         stage       = EXCLUDED.stage,
         reason_code = EXCLUDED.reason_code,
         retry_count = EXCLUDED.retry_count,
         counts      = a.counts || EXCLUDED.counts,
         app_version = coalesce(EXCLUDED.app_version, a.app_version),
         platform    = coalesce(EXCLUDED.platform, a.platform),
         updated_at  = now(),
         ended_at    = EXCLUDED.ended_at
   WHERE a.user_id = v_uid AND a.outcome <> 'committed'
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'outcome', 'committed', 'unchanged', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'outcome', v_row.outcome, 'unchanged', false);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_submission_attempt(uuid, uuid, text, text, text, integer, jsonb, boolean, text, text) TO authenticated;

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

-- ---------------------------------------------------------------------------
-- 5. RLS.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS agents_can_insert_messages ON public.submission_messages;
CREATE POLICY agents_can_insert_messages ON public.submission_messages
  FOR INSERT
  WITH CHECK (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)
       AND (transaction_submissions.status)::text = 'uploading'::text));

DROP POLICY IF EXISTS agents_can_insert_attachments ON public.submission_attachments;
CREATE POLICY agents_can_insert_attachments ON public.submission_attachments
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1
      FROM public.transaction_submissions ts
     WHERE ts.id = submission_attachments.submission_id
       AND ts.submitted_by = (SELECT auth.uid() AS uid)
       AND (ts.status)::text = 'uploading'::text
       AND split_part(submission_attachments.storage_path, '/'::text, 1) = (ts.organization_id)::text
       AND split_part(submission_attachments.storage_path, '/'::text, 2) = (ts.id)::text));

DROP POLICY IF EXISTS agents_can_delete_own_attachments ON public.submission_attachments;
CREATE POLICY agents_can_delete_own_attachments ON public.submission_attachments
  FOR DELETE
  USING (submission_id IN (
    SELECT transaction_submissions.id
      FROM public.transaction_submissions
     WHERE transaction_submissions.submitted_by = (SELECT auth.uid() AS uid)
       AND (transaction_submissions.status)::text = 'uploading'::text
       AND coalesce(transaction_submissions.submission_metadata->>'abandoned', '') = 'true'));

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
