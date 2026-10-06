DO $$ DECLARE b uuid; r jsonb;
BEGIN
  b := pg_temp.sub('uploading', '3 hours');
  PERFORM pg_temp.as_role('service_role'); SET LOCAL ROLE service_role; r := public.submission_sweep_claim(); RESET ROLE;
  PERFORM pg_temp.ok((SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = b), 'X3 no-arg claim fences nothing');
  PERFORM pg_temp.ok((r->>'dry_run')::boolean, 'X3 no-arg claim reports dry_run');
END $$;
