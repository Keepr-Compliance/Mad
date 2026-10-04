-- SR X2: parent_submission_id is NO ACTION. A row named as parent is kept; the batch still deletes the other.
DO $$ DECLARE a uuid; b uuid; k uuid; r jsonb; f jsonb;
BEGIN
  PERFORM pg_temp.ok((SELECT confdeltype = 'a' FROM pg_constraint WHERE conname = 'transaction_submissions_parent_submission_id_fkey'), 'X2 venue has the production NO ACTION FK');
  a := pg_temp.sub('uploading', '3 hours', '2 hours'); b := pg_temp.sub('uploading', '3 hours', '2 hours');
  k := pg_temp.sub('needs_changes', '1 hour'); UPDATE transaction_submissions SET parent_submission_id = a WHERE id = k;
  r := pg_temp.claim(false);
  PERFORM pg_temp.ok((r->>'referenced_as_parent')::int = 1, 'X2 referenced row counted');
  f := pg_temp.finish(r, ARRAY[a, b]);
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM transaction_submissions WHERE id = b), 'X2 the unreferenced row is deleted');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM transaction_submissions WHERE id = a) AND (f->>'rows_kept')::int = 1, 'X2 the referenced row is kept');
END $$;
