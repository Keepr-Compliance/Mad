-- The holding statement (pg_sleep below) starts with the marker: a transport that submits statement by statement
-- shows only the current statement in pg_stat_activity.query. hold-marker.sql, first in the call, serves one that
-- submits the whole call as one text (the activity view keeps its first 1 kB).
-- attach A: locks blob X FOR UPDATE as cloud_upsert_files does (/*FILE:lockblobs*/), inserts a file row with X, holds
-- 4 s and COMMITS (the row goes with the user). Answers its times and 'one' only when every statement ran in one
-- transaction (the hold is meaningless otherwise).
SET LOCAL lock_timeout = '3s';
SELECT set_config('p4263.txn', 'one', true), set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT 1 FROM public.cloud_blobs b WHERE b.id = '__X__' AND b.owner_user_id = '__U__' AND b.purge_requested_at IS NULL ORDER BY b.id FOR UPDATE;
INSERT INTO public.cloud_deal_files (owner_user_id, cloud_deal_id, local_attachment_id, blob_id, filename, content_hash)
VALUES ('__U__', '__D1__', 'att-__RUN__', '__X__', 'a.pdf', encode(sha256('f-__RUN__'::bytea), 'hex'));
SELECT set_config('p4263.t_hold', clock_timestamp()::text, true);
/*p_hold:__RUN__*/ SELECT pg_sleep(4);
SELECT json_build_object('tag', 'attach_a', 'txn', current_setting('p4263.txn', true), 't_start', current_setting('p4263.t_start', true),
       't_hold', current_setting('p4263.t_hold', true), 't_end', clock_timestamp()) AS a;
