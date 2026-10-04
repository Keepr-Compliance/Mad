-- (b) "no new activity for 2 h" (founder 2026-10-04): every row below was created 3 h ago.
--   P1 progressing: an object in its own folder written 30 min ago            -> NOT claimed
--   P2 progressing: an attachment row written 30 min ago (no object yet)       -> NOT claimed
--   ST stalled:     its row and object are 2 h 10 min old                      -> claimed
--   SF stalled:     a 30-min-old object with its id but in ANOTHER org folder  -> still claimed
-- Dry run first (would_fence), then live (fenced).
DO $$ DECLARE p1 uuid; p2 uuid; st uuid; sf uuid; rd jsonb; rl jsonb; wanted text[];
BEGIN
  p1 := pg_temp.sub('uploading', '3 hours'); PERFORM pg_temp.att(p1, 'a.pdf', '3 hours');
  PERFORM pg_temp.obj(pg_temp.org1() || '/' || p1 || '/loc2/b.pdf', '30 minutes');
  p2 := pg_temp.sub('uploading', '3 hours');
  INSERT INTO submission_attachments (submission_id, filename, storage_path, created_at)
  VALUES (p2, 'c.pdf', pg_temp.org1() || '/' || p2 || '/loc/c.pdf', now() - interval '30 minutes');
  st := pg_temp.sub('uploading', '3 hours'); PERFORM pg_temp.att(st, 'd.pdf', '2 hours 10 minutes');
  UPDATE submission_attachments SET created_at = now() - interval '2 hours 10 minutes' WHERE submission_id = st;
  sf := pg_temp.sub('uploading', '3 hours');
  PERFORM pg_temp.obj(pg_temp.org2() || '/' || sf || '/loc/e.pdf', '30 minutes');
  wanted := (SELECT array_agg(v ORDER BY v) FROM unnest(ARRAY[st::text, sf::text]) v);
  rd := pg_temp.claim(true);
  PERFORM pg_temp.ok((rd->>'would_fence')::int = 2 AND pg_temp.ids(rd) = wanted, 'S17 dry run: only the two stalled rows would be fenced');
  rl := pg_temp.claim(false);
  PERFORM pg_temp.ok((rl->>'fenced_now')::int = 2 AND pg_temp.ids(rl) = wanted, 'S17 live: only the two stalled rows fenced and listed');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = p1), 'S17 upload with a new file is not fenced');
  PERFORM pg_temp.ok((SELECT abandoned_at IS NULL FROM transaction_submissions WHERE id = p2), 'S17 upload with a new attachment row is not fenced');
END $$;
