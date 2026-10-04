DO $$ DECLARE b uuid; r jsonb;
BEGIN
  b := pg_temp.sub('uploading', '3 hours'); PERFORM pg_temp.att(b, 'a.pdf');
  r := pg_temp.claim(true);
  PERFORM pg_temp.ok((r->>'would_fence')::int = 1 AND (r->>'fenced_now')::int = 0, 'S07 dry run counts, fences nothing');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = b), 'S07 abandoned_at still null');
  PERFORM pg_temp.ok(jsonb_array_length(r->'submissions') = 1, 'S07 dry run still reports the candidate');
  PERFORM pg_temp.ok((SELECT mode = 'dry_run' FROM submission_sweep_runs WHERE id = (r->>'run_id')::uuid), 'S07 run row says dry_run');
END $$;
