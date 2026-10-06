-- An uploading row with neither timestamp is never fenced (unknown age = not stalled).
DO $$ DECLARE n uuid := gen_random_uuid(); r jsonb;
BEGIN
  INSERT INTO public.transaction_submissions (id, organization_id, submitted_by, local_transaction_id, property_address, status, version, created_at, updated_at)
  VALUES (n, pg_temp.org1(), pg_temp.agent(), 't-' || n, 'Fixture Street', 'uploading', 1, NULL, NULL);
  PERFORM pg_temp.ok((SELECT created_at IS NULL AND updated_at IS NULL FROM transaction_submissions WHERE id = n), 'S12 fixture really has no timestamps');
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok((r->>'fenced_now')::int = 0 AND (SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = n), 'S12 row with no timestamps never fenced');
END $$;
