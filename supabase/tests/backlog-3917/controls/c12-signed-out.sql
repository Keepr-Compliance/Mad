-- C12: a signed-out (anon) request evaluates the TO public policies, which now
-- call the helper: reads return nothing and raise no permission error; writes
-- are refused.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.organizations where id='{org1}')$q$);
  PERFORM pg_temp.check('c12 anon organizations read: no error', m LIKE 'OK %', m);
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.users)$q$);
  PERFORM pg_temp.check('c12 anon users read: 0 rows, no error', m = 'OK 0', m);
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.submission_comments)$q$);
  PERFORM pg_temp.check('c12 anon comments read: 0 rows, no error', m = 'OK 0', m);
  m := pg_temp.as_role('anon', NULL, $q$update public.organizations set retention_years = 3 where id='{org1}'$q$);
  PERFORM pg_temp.check('c12 anon org write refused', pg_temp.refused(m), m);
  m := pg_temp.as_role('anon', NULL, $q$insert into storage.objects(bucket_id,name) values ('submission-attachments','{org1}/{new_sub}/anon.pdf')$q$);
  PERFORM pg_temp.check('c12 anon upload refused', pg_temp.refused(m), m);
END $$;
