-- ============================================================================
-- BACKLOG-2393: Support access mode — retention, requester deletion, read log
-- ============================================================================
-- Date: 2026-08-02
--
-- Two gaps this closes, both pre-existing:
--
--   1. Nothing ever deleted an uploaded support attachment. Not on a schedule,
--      not on request. A diagnostics bundle uploaded in March is still there.
--   2. Nothing recorded who opened one. There is no way to answer "who read
--      this customer's diagnostics, and when".
--
-- Support access mode makes both unacceptable, because it uploads on a timer
-- rather than only when a person chooses to attach a file.
--
-- Design notes:
--
--  * `expires_at` is NULL by default, so every attachment that exists today
--    keeps its current behaviour (kept indefinitely). Only rows written by
--    `support_add_diagnostic_attachment` get a deadline. Changing retention for
--    human-uploaded attachments is a separate policy decision.
--  * Writes still go exclusively through SECURITY DEFINER RPCs. No INSERT or
--    DELETE policy is added to `support_ticket_attachments`.
--  * The one new *storage* policy mirrors the INSERT policy that already
--    exists ("Customers can upload to own tickets"): if you may write an object
--    under your own ticket prefix, you may remove it. Without it a requester
--    cannot actually delete their own uploaded bytes, only the row that points
--    at them — which is the failure mode this item exists to prevent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Allow gzipped reports through the bucket MIME allow-list.
--    Reports are gzipped because one observed diagnostics log was 15 MB against
--    a 10 MB bucket limit.
-- ----------------------------------------------------------------------------
UPDATE storage.buckets
SET allowed_mime_types = (
  SELECT ARRAY(
    SELECT DISTINCT unnest(
      COALESCE(allowed_mime_types, ARRAY[]::text[]) || ARRAY['application/gzip']
    )
  )
)
WHERE id = 'support-attachments'
  AND NOT ('application/gzip' = ANY(COALESCE(allowed_mime_types, ARRAY[]::text[])));

-- ----------------------------------------------------------------------------
-- 2. Retention deadline.
-- ----------------------------------------------------------------------------
ALTER TABLE public.support_ticket_attachments
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.support_ticket_attachments.expires_at IS
  'When this attachment is purged. NULL means no automatic expiry (all pre-BACKLOG-2393 rows, and anything a human attaches by hand).';

CREATE INDEX IF NOT EXISTS idx_support_ticket_attachments_expires_at
  ON public.support_ticket_attachments (expires_at)
  WHERE expires_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Register an automatically-uploaded diagnostic attachment, with retention.
--    Separate from support_add_attachment so the human-attachment path keeps
--    its existing signature and its existing (no-expiry) behaviour.
--
--    Unlike support_add_attachment, this one checks that the caller is the
--    ticket requester or an internal role. An automatic uploader has no reason
--    to write to a ticket that is not its own.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_add_diagnostic_attachment(
  p_ticket_id uuid,
  p_file_name text,
  p_file_size bigint,
  p_file_type text,
  p_storage_path text,
  p_retention_days integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attachment_id uuid;
  v_expires_at timestamptz;
  v_caller uuid;
  v_retention integer;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT (
    support_is_ticket_requester(p_ticket_id::text)
    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller)
  ) THEN
    RAISE EXCEPTION 'Not authorised to attach to this ticket';
  END IF;

  -- Clamp: a caller must not be able to ask for a 100-year retention, and a
  -- zero/negative value would make an upload expire before it is readable.
  v_retention := LEAST(GREATEST(COALESCE(p_retention_days, 30), 1), 90);
  v_expires_at := now() + (v_retention || ' days')::interval;

  INSERT INTO support_ticket_attachments (
    ticket_id, message_id, file_name, file_size, file_type,
    storage_path, uploaded_by, expires_at
  ) VALUES (
    p_ticket_id, NULL, p_file_name, p_file_size, p_file_type,
    p_storage_path, v_caller, v_expires_at
  )
  RETURNING id INTO v_attachment_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value, metadata)
  VALUES (
    p_ticket_id, v_caller, 'diagnostic_attachment_uploaded', p_file_name,
    jsonb_build_object(
      'attachment_id', v_attachment_id,
      'file_size', p_file_size,
      'expires_at', v_expires_at,
      'source', 'support_access_mode'
    )
  );

  RETURN jsonb_build_object(
    'id', v_attachment_id,
    'storage_path', p_storage_path,
    'expires_at', v_expires_at
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. Requester-initiated deletion of the attachment row.
--
--    The *object* is removed by the caller through the Storage API immediately
--    before this call (see the storage DELETE policy in section 7) — that is
--    the only path that removes the bytes rather than just the metadata row.
--    This function removes the record and logs it.
--
--    Idempotent on purpose: a client retrying after a partial failure must be
--    able to finish the job, so a missing row is success, not an error.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_delete_own_attachment(
  p_attachment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
  v_ticket_id uuid;
  v_file_name text;
  v_storage_path text;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.ticket_id, a.file_name, a.storage_path
    INTO v_ticket_id, v_file_name, v_storage_path
  FROM support_ticket_attachments a
  WHERE a.id = p_attachment_id;

  IF v_ticket_id IS NULL THEN
    RETURN jsonb_build_object('deleted', true, 'already_absent', true);
  END IF;

  IF NOT (
    support_is_ticket_requester(v_ticket_id::text)
    OR EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller)
  ) THEN
    RAISE EXCEPTION 'Not authorised to delete this attachment';
  END IF;

  -- Belt and braces: drop the storage metadata row too, so the object is
  -- unreachable through every API even if the caller's Storage API delete was
  -- the half that failed.
  DELETE FROM storage.objects
  WHERE bucket_id = 'support-attachments' AND name = v_storage_path;

  DELETE FROM support_ticket_attachments WHERE id = p_attachment_id;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, metadata)
  VALUES (
    v_ticket_id, v_caller, 'attachment_deleted_by_requester', v_file_name,
    jsonb_build_object('attachment_id', p_attachment_id, 'storage_path', v_storage_path)
  );

  RETURN jsonb_build_object('deleted', true, 'already_absent', false);
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. Retention enforcement.
--
--    CAVEAT, stated rather than hidden: removing the storage.objects row makes
--    the file unreachable through the Storage API, the signed-URL path and the
--    portals — but the underlying bytes are only reclaimed by Supabase's own
--    object cleanup, because SQL cannot call the Storage API. The fully correct
--    implementation is a scheduled Edge Function holding the service-role key
--    that calls storage.remove() and then this function. That is a follow-up;
--    this gets the deadline enforced and the record removed today.
--
--    Not exposed to `authenticated` — service role / scheduled job only.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_purge_expired_attachments()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_purged integer := 0;
  v_row record;
BEGIN
  FOR v_row IN
    SELECT a.id, a.ticket_id, a.file_name, a.storage_path
    FROM support_ticket_attachments a
    WHERE a.expires_at IS NOT NULL AND a.expires_at < now()
  LOOP
    DELETE FROM storage.objects
    WHERE bucket_id = 'support-attachments' AND name = v_row.storage_path;

    DELETE FROM support_ticket_attachments WHERE id = v_row.id;

    INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, old_value, metadata)
    VALUES (
      v_row.ticket_id, NULL, 'attachment_expired', v_row.file_name,
      jsonb_build_object('attachment_id', v_row.id, 'storage_path', v_row.storage_path)
    );

    v_purged := v_purged + 1;
  END LOOP;

  RETURN jsonb_build_object('purged', v_purged, 'at', now());
END;
$$;

-- ----------------------------------------------------------------------------
-- 5b. Schedule the purge.
--
--     The consent checkbox a user must tick to turn support access on says
--     reports are deleted after 30 days. Creating the function and leaving it
--     unscheduled meant nothing ever deleted anything, so that sentence was
--     false — and the desktop app compounded it by dropping its own local row
--     at the deadline, removing the user's Delete button while the server copy
--     lived on. Both halves are fixed; this is the server half.
--
--     Hourly rather than every five minutes: retention is measured in days, and
--     this scans an indexed partial index of expired rows. There is no reason to
--     wake up 288 times a day to enforce a 30-day deadline.
--
--     Idempotent: cron.schedule upserts on job name, so re-running this
--     migration re-points the same job rather than creating a duplicate.
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

SELECT cron.schedule(
  'purge-expired-support-attachments',
  '17 * * * *',
  $$SELECT public.support_purge_expired_attachments();$$
);

-- ----------------------------------------------------------------------------
-- 6. Read access logging.
--
--    Called by the admin and broker portals immediately before a signed URL is
--    minted. This logs the app's read path; it is not a tamper-proof audit of
--    the storage layer, and it does not claim to be. It answers "who opened
--    this through Keepr", which today has no answer at all.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_record_attachment_access(
  p_attachment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
  v_ticket_id uuid;
  v_file_name text;
  v_is_internal boolean;
BEGIN
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT a.ticket_id, a.file_name INTO v_ticket_id, v_file_name
  FROM support_ticket_attachments a
  WHERE a.id = p_attachment_id;

  IF v_ticket_id IS NULL THEN
    RETURN jsonb_build_object('logged', false, 'reason', 'not_found');
  END IF;

  v_is_internal := EXISTS (SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller);

  IF NOT (support_is_ticket_requester(v_ticket_id::text) OR v_is_internal) THEN
    RAISE EXCEPTION 'Not authorised to read this attachment';
  END IF;

  INSERT INTO support_ticket_events (ticket_id, actor_id, event_type, new_value, metadata)
  VALUES (
    v_ticket_id, v_caller, 'attachment_read', v_file_name,
    jsonb_build_object(
      'attachment_id', p_attachment_id,
      'reader', CASE WHEN v_is_internal THEN 'internal' ELSE 'requester' END
    )
  );

  RETURN jsonb_build_object('logged', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. Storage DELETE for requesters, scoped to their own ticket prefix.
--    Mirrors "Customers can upload to own tickets" exactly.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Customers can delete own ticket attachments" ON storage.objects;
CREATE POLICY "Customers can delete own ticket attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'support-attachments'
    AND auth.uid() IS NOT NULL
    AND support_is_ticket_requester(split_part(name, '/', 1))
  );

-- ----------------------------------------------------------------------------
-- 8. Grants.
--    support_purge_expired_attachments is deliberately NOT granted to
--    `authenticated` — a scheduled job runs it, not a user.
-- ----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.support_add_diagnostic_attachment(uuid, text, bigint, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.support_delete_own_attachment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.support_record_attachment_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.support_purge_expired_attachments() TO service_role;

REVOKE EXECUTE ON FUNCTION public.support_purge_expired_attachments() FROM authenticated, anon;

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- SELECT cron.unschedule('purge-expired-support-attachments');
-- DROP POLICY IF EXISTS "Customers can delete own ticket attachments" ON storage.objects;
-- DROP FUNCTION IF EXISTS public.support_record_attachment_access(uuid);
-- DROP FUNCTION IF EXISTS public.support_purge_expired_attachments();
-- DROP FUNCTION IF EXISTS public.support_delete_own_attachment(uuid);
-- DROP FUNCTION IF EXISTS public.support_add_diagnostic_attachment(uuid, text, bigint, text, text, integer);
-- DROP INDEX IF EXISTS idx_support_ticket_attachments_expires_at;
-- ALTER TABLE public.support_ticket_attachments DROP COLUMN IF EXISTS expires_at;
-- (The bucket MIME allow-list change is additive and intentionally not reverted.)
