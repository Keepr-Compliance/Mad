-- Real 3725 rules after the sweep's fence: finalize refuses 'abandoned', a 2.38-shaped flip matches 0 rows.
DO $$ DECLARE b uuid; r jsonb; fin jsonb; n integer;
BEGIN
  b := pg_temp.sub('uploading', '3 hours');
  r := pg_temp.claim(false);
  PERFORM pg_temp.as_role('authenticated', pg_temp.agent()); SET LOCAL ROLE authenticated;
  fin := public.finalize_submission(b, '{"message_ids": [], "attachments": [], "checklists": null}'::jsonb);
  UPDATE public.transaction_submissions SET status = 'submitted' WHERE id = b; GET DIAGNOSTICS n = ROW_COUNT;
  RESET ROLE;
  PERFORM pg_temp.ok(fin->>'code' = 'abandoned', 'S10 finalize after the fence -> abandoned');
  PERFORM pg_temp.ok(n = 0, 'S10 2.38 flip after the fence -> 0 rows');
  PERFORM pg_temp.ok((SELECT status = 'uploading' AND abandoned_at IS NOT NULL FROM transaction_submissions WHERE id = b), 'S10 row still uploading and fenced');
END $$;
