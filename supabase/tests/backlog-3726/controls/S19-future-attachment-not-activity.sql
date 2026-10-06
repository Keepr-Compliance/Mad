-- SR D1: a future-dated submission_attachments.created_at must not count as activity,
-- or the submitter (who can insert their own attachment row) makes their own stalled
-- upload unsweepable forever.
DO $$ DECLARE b uuid; r jsonb;
BEGIN
  b := pg_temp.sub('uploading', '3 hours');
  INSERT INTO submission_attachments (submission_id, filename, storage_path, created_at)
  VALUES (b, 'f.pdf', pg_temp.org1() || '/' || b || '/loc/f.pdf', now() + interval '100 years');
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok(b::text = ANY (pg_temp.ids(r)), 'S19 future attachment row does not hide a stalled row (listed)');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NOT NULL FROM transaction_submissions WHERE id = b), 'S19 future attachment row does not hide a stalled row (fenced)');
END $$;
