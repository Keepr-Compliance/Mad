-- SR X4: a 30-day-old uploading row with abandoned_at far in the future is still swept.
DO $$ DECLARE b uuid; r jsonb;
BEGIN
  b := pg_temp.sub('uploading', '30 days');
  UPDATE transaction_submissions SET abandoned_at = now() + interval '100 years' WHERE id = b;
  PERFORM pg_temp.att(b, 'a.pdf');
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok(b::text = ANY (pg_temp.ids(r)), 'X4 future abandoned_at does not hide an old row');
END $$;
