-- BACKLOG-3726 pre-live identity check (READ-ONLY; run on production before GO-4).
-- Selects stray objects with exactly the predicate of submission_sweep_claim's
-- orphan arm (case c, 7 days) and prints a count, an md5 of the sorted names and
-- the age range. NEVER prints a name. Compare n, names_md5, oldest and newest with
-- the values recorded in the apply plan on the backlog item (pm_comments); any
-- difference = stop before going live.
-- Also prints the other numbers the first live run should match.
WITH sel AS (
  SELECT o.name, o.created_at FROM storage.objects o
   WHERE o.bucket_id = 'submission-attachments'
     AND o.created_at < now() - interval '7 days'
     AND NOT EXISTS (SELECT 1 FROM public.submission_attachments a WHERE a.storage_path = o.name)
     AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions t WHERE t.id::text = split_part(o.name, '/', 2))
)
SELECT count(*) AS n,
       md5(string_agg(name, E'\n' ORDER BY name)) AS names_md5,
       min(created_at) AS oldest,
       max(created_at) AS newest,
       (SELECT count(*) FROM storage.objects WHERE bucket_id = 'submission-attachments') AS objects_in_bucket,
       (SELECT count(*) FROM public.transaction_submissions
         WHERE status = 'uploading' AND abandoned_at IS NULL
           AND coalesce(created_at, updated_at, 'infinity'::timestamptz) < now() - interval '2 hours') AS would_fence,
       (SELECT count(*) FROM public.transaction_submissions
         WHERE status = 'uploading' AND abandoned_at IS NOT NULL) AS abandoned_uploading,
       (SELECT count(*) FROM storage.objects o
         WHERE o.bucket_id = 'submission-attachments'
           AND NOT EXISTS (SELECT 1 FROM public.submission_attachments a WHERE a.storage_path = o.name)
           AND EXISTS (SELECT 1 FROM public.transaction_submissions t
                        WHERE t.id::text = split_part(o.name, '/', 2) AND t.status <> 'uploading')) AS unreferenced_in_live_submissions
  FROM sel;
