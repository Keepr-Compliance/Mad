-- S-g: row-level security on storage.objects INSERT in bucket
-- submission-attachments, exercised as the signed-in user. The object path is
-- <organization id>/<submission id>/<file>, as the desktop uploads it.
--   personal agent, personal organization prefix : DENIED
--   brokerage agent, brokerage prefix            : ALLOWED (1 row)

DO $setup$
DECLARE
  v jsonb;
BEGIN
  v := public._ensure_personal_organization_for(current_setting('t3364.u_personal_f')::uuid);
  PERFORM pg_temp.check(v->>'status' = 'created', format('personal organization created, got %s', v));
  PERFORM set_config('t3364.pg_org', v->>'organization_id', true);
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'submission-attachments'),
                        'venue holds the submission-attachments bucket (lib/seed-storage.sql)');
END
$setup$;

SELECT pg_temp.act_as(current_setting('t3364.u_personal_f')::uuid);
DO $as_personal$
BEGIN
  BEGIN
    INSERT INTO storage.objects (bucket_id, name)
    VALUES ('submission-attachments', current_setting('t3364.pg_org') || '/fixture-3364-submission/file.pdf');
    PERFORM set_config('t3364.sg_personal', 'allowed', true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.sg_personal', 'denied:' || SQLERRM, true);
  END;
END
$as_personal$;
RESET ROLE;

SELECT pg_temp.act_as(current_setting('t3364.u_broker_agent')::uuid);
DO $as_broker$
DECLARE
  n integer;
BEGIN
  BEGIN
    INSERT INTO storage.objects (bucket_id, name)
    VALUES ('submission-attachments', current_setting('t3364.o_brk_a') || '/fixture-3364-submission/file.pdf');
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('t3364.sg_broker', 'allowed:' || n, true);
  EXCEPTION WHEN insufficient_privilege THEN
    PERFORM set_config('t3364.sg_broker', 'denied:' || SQLERRM, true);
  END;
END
$as_broker$;
RESET ROLE;

DO $assert$
BEGIN
  PERFORM pg_temp.check(current_setting('t3364.sg_personal') LIKE 'denied:%row-level security%',
                        format('upload under the personal organization prefix is denied by RLS, got %s', current_setting('t3364.sg_personal')));
  PERFORM pg_temp.check(current_setting('t3364.sg_broker') = 'allowed:1',
                        format('upload under the brokerage prefix is allowed, got %s', current_setting('t3364.sg_broker')));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'submission-attachments'
                                    AND name = current_setting('t3364.pg_org') || '/fixture-3364-submission/file.pdf'),
                        'no object stored under the personal organization prefix');
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'submission-attachments'
                                AND name = current_setting('t3364.o_brk_a') || '/fixture-3364-submission/file.pdf'),
                        'brokerage object stored');
END
$assert$;
