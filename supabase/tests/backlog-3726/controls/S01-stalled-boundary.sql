-- (b) at 2 h: 1 h 50 m untouched, 2 h 10 m fenced; a submitted row untouched;
-- (a) abandoned 70 min ago listed; abandoned 30 min ago on a 1 h old row not listed.
DO $$ DECLARE a uuid; b uuid; c uuid; d uuid; e uuid; r jsonb;
BEGIN
  a := pg_temp.sub('uploading', '1 hour 50 minutes'); b := pg_temp.sub('uploading', '2 hours 10 minutes');
  c := pg_temp.sub('submitted', '30 hours'); d := pg_temp.sub('uploading', '90 minutes', '70 minutes');
  e := pg_temp.sub('uploading', '1 hour', '30 minutes');
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok((r->>'fenced_now')::int = 1, 'S01 exactly one row fenced');
  PERFORM pg_temp.ok(pg_temp.ids(r) = (SELECT array_agg(v ORDER BY v) FROM unnest(ARRAY[b::text, d::text]) v), 'S01 list = {2h10m stalled, abandoned 70 min}');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = a), 'S01 1h50m row untouched');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NOT NULL FROM transaction_submissions WHERE id = b), 'S01 2h10m row fenced');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NULL AND status = 'submitted' FROM transaction_submissions WHERE id = c), 'S01 submitted row untouched');
END $$;
