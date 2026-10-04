-- ============================================
-- SUBMISSION SWEEP: abandoned, stalled and orphaned submission uploads
-- Migration: 20261005120000_backlog_3726_submission_sweep
-- Task: BACKLOG-3726 (depends on BACKLOG-3725: transaction_submissions.abandoned_at)
--
-- 1. Vault secrets `submission_sweep_secret` (generated in the database, never
--    regenerated) and `submission_sweep_url` (the Edge Function URL; seeded with
--    the production URL, overridable on a local stack).
-- 2. public.submission_sweep_secret()   -> the secret, service_role only.
-- 3. public.submission_sweep_runs       -> one counts-only row per run.
-- 4. public.submission_sweep_claim()    -> fences stalled uploads, returns the work list.
-- 5. public.submission_sweep_finish()   -> guarded row delete after the files are removed.
-- 6. public.submission_sweep_invoke()   -> pg_net POST to the Edge Function (the cron job calls it).
--
-- The Edge Function runs as service_role, which bypasses RLS. Every rule about
-- which rows and files may be removed is therefore stated here, inside the
-- SECURITY DEFINER functions, and not left to policies.
--
-- No cron schedule here: 20261005120100_backlog_3726_submission_sweep_schedule.sql.
-- ============================================

-- 1. Secrets (idempotent; existing values are never replaced)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'submission_sweep_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'submission_sweep_secret',
      'BACKLOG-3726: x-webhook-secret for the submission-sweep Edge Function'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'submission_sweep_url') THEN
    PERFORM vault.create_secret(
      'https://nercleijfrxqcvfjskbc.supabase.co/functions/v1/submission-sweep',
      'submission_sweep_url',
      'BACKLOG-3726: URL submission_sweep_invoke() posts to (a local stack points it at functions serve)'
    );
  END IF;
END
$$;

-- 2. Secret accessor for the Edge Function
CREATE OR REPLACE FUNCTION public.submission_sweep_secret()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT decrypted_secret FROM vault.decrypted_secrets
           WHERE name = 'submission_sweep_secret' LIMIT 1);
END;
$$;

-- 3. Run log (counts only; no ids, paths or names)
CREATE TABLE IF NOT EXISTS public.submission_sweep_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  mode text NOT NULL CHECK (mode IN ('dry_run', 'live')),
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running', 'ok', 'partial', 'failed')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS submission_sweep_runs_started_at_idx ON public.submission_sweep_runs (started_at);
ALTER TABLE public.submission_sweep_runs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.submission_sweep_runs IS
  'BACKLOG-3726: one row per submission sweep run, counts only. Written by submission_sweep_claim/finish; kept 30 days.';

-- 4. Claim
--    (a) abandoned: uploading, abandoned_at set, and either abandoned_at older than
--        p_abandoned_grace OR the row older than p_stalled (so a future abandoned_at
--        cannot hide a row), OR fenced by this run.
--    (b) stalled: uploading, abandoned_at NULL, and no activity for p_stalled
--        (activity = the newest of created_at, the newest NOT-FUTURE attachment
--        row, the newest object in the row's own {org}/{id}/ folder) -> fenced
--        (abandoned_at = now()) with FOR UPDATE SKIP LOCKED, so an in-flight
--        finalize (which holds the row lock) is skipped, not waited on.
--        An upload that is still adding files is not stalled.
--    (c) orphan object: no attachment row names it, no submission row has the id
--        in path segment 2 (any status), older than p_orphan_age.
--    Rowless objects inside a non-uploading submission's folder are counted, never listed.
CREATE OR REPLACE FUNCTION public.submission_sweep_claim(
  p_dry_run boolean DEFAULT true,
  p_stalled interval DEFAULT interval '2 hours',
  p_abandoned_grace interval DEFAULT interval '1 hour',
  p_orphan_age interval DEFAULT interval '7 days',
  p_limit integer DEFAULT 50,
  p_orphan_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run uuid;
  v_fenced uuid[] := '{}';
  v_would uuid[] := '{}';
  v_subs jsonb;
  v_orphans jsonb;
  v_live_unreferenced integer;
  v_referenced integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';
  END IF;
  IF p_dry_run IS NULL
     OR p_stalled IS NULL OR p_stalled < interval '2 hours'
     OR p_abandoned_grace IS NULL OR p_abandoned_grace < interval '15 minutes'
     OR p_orphan_age IS NULL OR p_orphan_age < interval '3 days'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
     OR p_orphan_limit IS NULL OR p_orphan_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'sweep parameter outside its allowed range' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.submission_sweep_runs WHERE started_at < now() - interval '30 days';
  INSERT INTO public.submission_sweep_runs (mode)
    VALUES (CASE WHEN p_dry_run THEN 'dry_run' ELSE 'live' END)
    RETURNING id INTO v_run;

  -- (b) stalled
  IF p_dry_run THEN
    SELECT coalesce(array_agg(id), '{}') INTO v_would FROM (
      SELECT t.id FROM public.transaction_submissions t
       WHERE t.status::text = 'uploading' AND t.abandoned_at IS NULL
         AND coalesce(greatest(
               t.created_at,
               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),
               (SELECT max(o.created_at) FROM storage.objects o
                 WHERE o.bucket_id = 'submission-attachments'
                   AND split_part(o.name, '/', 1) = t.organization_id::text
                   AND split_part(o.name, '/', 2) = t.id::text)
             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled
       ORDER BY t.created_at LIMIT p_limit) s;
  ELSE
    WITH cand AS (
      SELECT t.id FROM public.transaction_submissions t
       WHERE t.status::text = 'uploading' AND t.abandoned_at IS NULL
         AND coalesce(greatest(
               t.created_at,
               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),
               (SELECT max(o.created_at) FROM storage.objects o
                 WHERE o.bucket_id = 'submission-attachments'
                   AND split_part(o.name, '/', 1) = t.organization_id::text
                   AND split_part(o.name, '/', 2) = t.id::text)
             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled
       ORDER BY t.created_at LIMIT p_limit
       FOR UPDATE SKIP LOCKED
    ), fenced AS (
      UPDATE public.transaction_submissions t SET abandoned_at = now()
        FROM cand
       WHERE t.id = cand.id AND t.status::text = 'uploading' AND t.abandoned_at IS NULL
      RETURNING t.id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_fenced FROM fenced;
  END IF;

  -- (a) + rows fenced now (+ would-fence rows in a dry run): exact paths in the row's own folder
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'reason', CASE WHEN s.id = ANY (v_fenced) OR s.id = ANY (v_would) THEN 'stalled' ELSE 'abandoned' END,
           'paths', (SELECT coalesce(jsonb_agg(DISTINCT x.p), '[]'::jsonb) FROM (
                       SELECT a.storage_path AS p FROM public.submission_attachments a
                        WHERE a.submission_id = s.id
                          AND a.storage_path IS NOT NULL
                          AND split_part(a.storage_path, '/', 1) = s.organization_id::text
                          AND split_part(a.storage_path, '/', 2) = s.id::text
                       UNION
                       SELECT o.name FROM storage.objects o
                        WHERE o.bucket_id = 'submission-attachments'
                          AND split_part(o.name, '/', 1) = s.organization_id::text
                          AND split_part(o.name, '/', 2) = s.id::text
                     ) x)
         )), '[]'::jsonb)
    INTO v_subs
    FROM (
      SELECT t.id, t.organization_id FROM public.transaction_submissions t
       WHERE t.status::text = 'uploading'
         AND (
              (t.abandoned_at IS NOT NULL
               AND (t.abandoned_at < now() - p_abandoned_grace
                    OR coalesce(t.created_at, t.updated_at, 'infinity'::timestamptz) < now() - p_stalled
                    OR t.id = ANY (v_fenced)))
              OR t.id = ANY (v_would)
             )
       ORDER BY t.created_at LIMIT p_limit
    ) s;

  -- (c) orphans
  SELECT coalesce(jsonb_agg(z.name), '[]'::jsonb) INTO v_orphans FROM (
    SELECT o.name FROM storage.objects o
     WHERE o.bucket_id = 'submission-attachments'
       AND o.created_at < now() - p_orphan_age
       AND NOT EXISTS (SELECT 1 FROM public.submission_attachments a WHERE a.storage_path = o.name)
       AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions t WHERE t.id::text = split_part(o.name, '/', 2))
     ORDER BY o.created_at LIMIT p_orphan_limit) z;

  SELECT count(*) INTO v_live_unreferenced FROM storage.objects o
   WHERE o.bucket_id = 'submission-attachments'
     AND NOT EXISTS (SELECT 1 FROM public.submission_attachments a WHERE a.storage_path = o.name)
     AND EXISTS (SELECT 1 FROM public.transaction_submissions t
                  WHERE t.id::text = split_part(o.name, '/', 2) AND t.status::text <> 'uploading');

  SELECT count(*) INTO v_referenced FROM jsonb_array_elements(v_subs) e
   WHERE EXISTS (SELECT 1 FROM public.transaction_submissions c
                  WHERE c.parent_submission_id = (e->>'id')::uuid);

  RETURN jsonb_build_object(
    'run_id', v_run,
    'dry_run', p_dry_run,
    'fenced_now', cardinality(v_fenced),
    'would_fence', cardinality(v_would),
    'submissions', v_subs,
    'orphans', v_orphans,
    'unreferenced_in_live_submissions', v_live_unreferenced,
    'referenced_as_parent', v_referenced
  );
END;
$$;

-- 5. Finish: delete only rows still uploading, abandoned, with no object left in
--    their folder and not named as another row's parent (that FK is NO ACTION).
CREATE OR REPLACE FUNCTION public.submission_sweep_finish(
  p_run_id uuid,
  p_submission_ids uuid[],
  p_counts jsonb,
  p_outcome text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ids uuid[] := coalesce(p_submission_ids, '{}');
  v_deleted uuid[] := '{}';
  v_counts jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('ok', 'partial', 'failed') THEN
    RAISE EXCEPTION 'bad outcome' USING ERRCODE = '22023';
  END IF;

  WITH d AS (
    DELETE FROM public.transaction_submissions s
     WHERE s.id = ANY (v_ids)
       AND s.status::text = 'uploading'
       AND s.abandoned_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM storage.objects o
                        WHERE o.bucket_id = 'submission-attachments'
                          AND split_part(o.name, '/', 1) = s.organization_id::text
                          AND split_part(o.name, '/', 2) = s.id::text)
       AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions c
                        WHERE c.parent_submission_id = s.id)
    RETURNING s.id
  )
  SELECT coalesce(array_agg(id), '{}') INTO v_deleted FROM d;

  UPDATE public.submission_attempts
     SET outcome = 'abandoned', stage = 'server_sweep', reason_code = 'swept',
         ended_at = now(), updated_at = now()
   WHERE submission_id = ANY (v_deleted) AND outcome <> 'committed';

  -- counts only: keep snake_case keys with whole-number values
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) INTO v_counts
    FROM jsonb_each(coalesce(p_counts, '{}'::jsonb)) AS e(k, v)
   WHERE k ~ '^[a-z][a-z0-9_]{0,63}$' AND jsonb_typeof(v) = 'number';

  UPDATE public.submission_sweep_runs
     SET ended_at = now(),
         outcome = p_outcome,
         counts = v_counts || jsonb_build_object(
                    'rows_deleted', cardinality(v_deleted),
                    'rows_kept', cardinality(v_ids) - cardinality(v_deleted))
   WHERE id = p_run_id;

  RETURN jsonb_build_object('rows_deleted', cardinality(v_deleted),
                            'rows_kept', cardinality(v_ids) - cardinality(v_deleted));
END;
$$;

-- 6. Invoker for the cron job (runs as the job owner, postgres). pg_net is
--    asynchronous; the timeout is set to the Edge Function's wall-clock budget.
CREATE OR REPLACE FUNCTION public.submission_sweep_invoke()
RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'submission_sweep_url' LIMIT 1;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'submission_sweep_secret' LIMIT 1;
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE EXCEPTION 'submission sweep is not configured' USING ERRCODE = '55000';
  END IF;
  RETURN net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', v_secret),
    timeout_milliseconds := 150000
  );
END;
$$;

COMMENT ON FUNCTION public.submission_sweep_invoke() IS
  'BACKLOG-3726: posts to the submission-sweep Edge Function with x-webhook-secret. Called by the cron job.';

-- Grants: nothing for client roles; the sweep functions for service_role only;
-- the run table readable (not writable) by service_role.
REVOKE ALL ON TABLE public.submission_sweep_runs FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.submission_sweep_runs TO service_role;

REVOKE ALL ON FUNCTION public.submission_sweep_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submission_sweep_secret() TO service_role;

REVOKE ALL ON FUNCTION public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.submission_sweep_finish(uuid, uuid[], jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submission_sweep_finish(uuid, uuid[], jsonb, text) TO service_role;

REVOKE ALL ON FUNCTION public.submission_sweep_invoke() FROM PUBLIC, anon, authenticated, service_role;
