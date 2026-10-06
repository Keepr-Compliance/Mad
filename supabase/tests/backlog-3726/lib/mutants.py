#!/usr/bin/env python3
"""BACKLOG-3726 mutants of the sweep migration. Each mutant is an exact-string
replacement that must match exactly once (else this script fails: an
unapplied mutation is never counted). want=red: the named control(s) must turn
red. want=green: measured equivalent, kept so the claim stays checked."""
import os
import sys

draft, out = sys.argv[1], sys.argv[2]
src = open(draft).read()

M = [
    # (name, old, new, targets, want, description)
    ("MW", "  IF p_dry_run THEN\n    SELECT coalesce(array_agg(id), '{}') INTO v_would",
     "  IF true THEN\n    SELECT coalesce(array_agg(id), '{}') INTO v_would",
     "S01 S10", "red", "MOST LIKELY WRONG: list stalled rows with no lock and no fence (delete later)"),
    ("M01", "       FOR UPDATE SKIP LOCKED\n", "       FOR UPDATE\n",
     "", "green", "FOR UPDATE without SKIP LOCKED: waits instead of skipping (live R1 measures the wait)"),
    ("M02", "       AND s.status::text = 'uploading'\n       AND s.abandoned_at IS NOT NULL\n",
     "       AND s.abandoned_at IS NOT NULL\n",
     "S05", "red", "finish without status = uploading"),
    ("M03", "       AND s.status::text = 'uploading'\n       AND s.abandoned_at IS NOT NULL\n",
     "       AND s.status::text = 'uploading'\n",
     "S05", "red", "finish without abandoned_at IS NOT NULL"),
    ("M04", "       AND NOT EXISTS (SELECT 1 FROM storage.objects o\n                        WHERE o.bucket_id = 'submission-attachments'\n                          AND split_part(o.name, '/', 1) = s.organization_id::text\n                          AND split_part(o.name, '/', 2) = s.id::text)\n",
     "", "S04", "red", "finish deletes a row while an object remains"),
    ("M05", "       AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions c\n                        WHERE c.parent_submission_id = s.id)\n",
     "", "X2", "red", "finish without the referenced-parent term (SR condition 1)"),
    ("M06", "       AND o.created_at < now() - p_orphan_age\n", "",
     "S06", "red", "orphans without the age term (a 2.38 upload in flight)"),
    ("M07", "       AND NOT EXISTS (SELECT 1 FROM public.transaction_submissions t WHERE t.id::text = split_part(o.name, '/', 2))\n", "",
     "S06", "red", "orphans inside an existing submission's folder"),
    ("M08", "                    OR coalesce(t.created_at, t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n", "",
     "X4", "red", "abandoned arm without the created_at age term (SR condition 2)"),
    ("M09", "                          AND split_part(a.storage_path, '/', 1) = s.organization_id::text\n                          AND split_part(a.storage_path, '/', 2) = s.id::text\n", "",
     "X1", "red", "attachment-path arm without the own-folder terms (SR condition 3)"),
    ("M10", "  p_dry_run boolean DEFAULT true,", "  p_dry_run boolean DEFAULT false,",
     "X3", "red", "SQL default live (SR condition 4)"),
    ("M11", "     OR p_stalled IS NULL OR p_stalled < interval '2 hours'\n", "     OR p_stalled IS NULL\n",
     "S08", "red", "no stall floor"),
    ("M12", "OR p_stalled < interval '2 hours'", "OR p_stalled < interval '1 hour'",
     "S08", "red", "stall floor at 1 h (founder floor is 2 h)"),
    ("M13", "OR p_orphan_age < interval '3 days'", "OR p_orphan_age < interval '1 hour'",
     "S08", "red", "orphan floor too low"),
    ("M14", "  IF p_dry_run IS NULL\n     OR", "  IF",
     "S08", "red", "NULL dry_run accepted"),
    ("M15", "  IF auth.role() IS DISTINCT FROM 'service_role' THEN\n    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';\n  END IF;\n  IF p_dry_run IS NULL",
     "  IF p_dry_run IS NULL", "S09b", "red", "claim body guard removed (REVOKE kept)"),
    ("M16", "REVOKE ALL ON FUNCTION public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer) FROM PUBLIC, anon, authenticated;",
     "REVOKE ALL ON FUNCTION public.submission_sweep_claim(boolean, interval, interval, interval, integer, integer) FROM PUBLIC, anon;",
     "S09a", "red", "claim EXECUTE left to authenticated (guard kept)"),
    ("M17", "REVOKE ALL ON FUNCTION public.submission_sweep_invoke() FROM PUBLIC, anon, authenticated, service_role;",
     "REVOKE ALL ON FUNCTION public.submission_sweep_invoke() FROM PUBLIC, anon, authenticated;",
     "S09a", "red", "invoke EXECUTE left to service_role"),
    ("M18", "REVOKE ALL ON TABLE public.submission_sweep_runs FROM PUBLIC, anon, authenticated, service_role;",
     "REVOKE ALL ON TABLE public.submission_sweep_runs FROM PUBLIC, anon, authenticated;",
     "S13", "red", "service_role keeps write on the run table"),
    ("M19", "  DELETE FROM public.submission_sweep_runs WHERE started_at < now() - interval '30 days';\n", "",
     "S13", "red", "no run-row retention"),
    ("M20", "   WHERE k ~ '^[a-z][a-z0-9_]{0,63}$' AND jsonb_typeof(v) = 'number';", "   WHERE true;",
     "S14", "red", "run row stores any value (paths could land there)"),
    ("M21", "    timeout_milliseconds := 150000\n", "    timeout_milliseconds := 5000\n",
     "S15", "red", "pg_net default timeout (5 s)"),
    ('M22', "             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     "             ), t.updated_at, '-infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     'S12', "red", 'a row with no timestamps is fenced at once'),
    ("M23", "       WHERE t.status::text = 'uploading'\n         AND (\n", "       WHERE true\n         AND (\n",
     "S05", "red", "work list without status = uploading"),
    ("M24", "                          AND split_part(o.name, '/', 1) = s.organization_id::text\n                          AND split_part(o.name, '/', 2) = s.id::text\n                     ) x)",
     "                          AND split_part(o.name, '/', 2) = s.id::text\n                     ) x)",
     "S02", "red", "object arm without the org segment"),
    ("M25", "       WHERE t.id = cand.id AND t.status::text = 'uploading' AND t.abandoned_at IS NULL\n",
     "       WHERE t.id = cand.id\n",
     "", "green", "fence UPDATE without its re-check: equivalent (SKIP LOCKED re-evaluates the WHERE on the latest row version)"),
    ("M26", "'submission_sweep_url' LIMIT 1;\n  SELECT decrypted_secret INTO v_secret",
     "'submission_sweep_url' LIMIT 1;\n  v_url := 'https://nercleijfrxqcvfjskbc.supabase.co/functions/v1/submission-sweep';\n  SELECT decrypted_secret INTO v_secret",
     "S15", "red", "hard-coded production URL (SR condition 5)"),
    ('M30', "      SELECT t.id FROM public.transaction_submissions t\n       WHERE t.status::text = 'uploading' AND t.abandoned_at IS NULL\n         AND coalesce(greatest(\n               t.created_at,\n               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),\n               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     "      SELECT t.id FROM public.transaction_submissions t\n       WHERE t.status::text = 'uploading' AND t.abandoned_at IS NULL\n         AND coalesce(t.created_at, t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     'S17', "red", 'live fence reverts to created_at age (founder rule: no activity for 2 h)'),
    ('M31', "INTO v_would FROM (\n      SELECT t.id FROM public.transaction_submissions t\n       WHERE t.status::text = 'uploading' AND t.abandoned_at IS NULL\n         AND coalesce(greatest(\n               t.created_at,\n               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),\n               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n",
     "INTO v_would FROM (\n      SELECT t.id FROM public.transaction_submissions t\n       WHERE t.status::text = 'uploading' AND t.abandoned_at IS NULL\n         AND coalesce(t.created_at, t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n",
     'S17', "red", 'dry-run arm reverts to created_at age'),
    ('M32', "               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),\n               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     "               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now())\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     'S17 S18', "red", 'live fence ignores new objects (attachment rows only)'),
    ('M33', "                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     "                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     'S17', "red", "live fence counts an object in another org's folder as activity"),
    ('M34', "               (SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),\n               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     "               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     'S17', "red", 'live fence ignores new attachment rows'),
    ('M35', "(SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id AND a.created_at <= now()),\n               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     "(SELECT max(a.created_at) FROM public.submission_attachments a WHERE a.submission_id = t.id),\n               (SELECT max(o.created_at) FROM storage.objects o\n                 WHERE o.bucket_id = 'submission-attachments'\n                   AND split_part(o.name, '/', 1) = t.organization_id::text\n                   AND split_part(o.name, '/', 2) = t.id::text)\n             ), t.updated_at, 'infinity'::timestamptz) < now() - p_stalled\n       ORDER BY t.created_at LIMIT p_limit\n       FOR UPDATE",
     'S19', "red", "SR D1: live fence drops the <= now() guard, so a future-dated attachment row hides a stalled upload"),
    ("M27", "  v_counts jsonb;\nBEGIN\n  IF auth.role() IS DISTINCT FROM 'service_role' THEN\n    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';\n  END IF;\n",
     "  v_counts jsonb;\nBEGIN\n", "S09b", "red", "finish body guard removed"),
    ("M28", "STABLE\nSECURITY DEFINER\nSET search_path = ''\nAS $$\nBEGIN\n  IF auth.role() IS DISTINCT FROM 'service_role' THEN\n    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';\n  END IF;\n",
     "STABLE\nSECURITY DEFINER\nSET search_path = ''\nAS $$\nBEGIN\n", "S09b", "red", "secret body guard removed"),
]

n = 0
for name, old, new, targets, want, desc in M:
    c = src.count(old)
    if c != 1:
        sys.exit(f"{name}: pattern matched {c} times (must be 1) - MUTATION NOT APPLIED")
    open(os.path.join(out, f"{name}.sql"), "w").write(src.replace(old, new))
    open(os.path.join(out, f"{name}.targets"), "w").write(targets)
    open(os.path.join(out, f"{name}.want"), "w").write(want)
    open(os.path.join(out, f"{name}.desc"), "w").write(desc)
    n += 1
print(f"{n} mutants written", file=sys.stderr)
