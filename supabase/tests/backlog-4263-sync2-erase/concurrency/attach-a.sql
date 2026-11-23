/*p_hold:__RUN__*/
-- session A: the hold marker above is FIRST in the call (pg_stat_activity.query keeps the first 1 kB only).
-- attach A: locks blob X FOR UPDATE as cloud_upsert_files does (/*FILE:lockblobs*/), inserts a file row with X, holds
-- 4 s and COMMITS (the row goes with the user). Answers its times and 'one' only when every statement ran in one
-- transaction (the hold is meaningless otherwise).
SET LOCAL lock_timeout = '3s';
SELECT set_config('p4263.txn', 'one', true), set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT 1 FROM public.cloud_blobs b WHERE b.id = '__X__' AND b.owner_user_id = '__U__' AND b.purge_requested_at IS NULL ORDER BY b.id FOR UPDATE;
INSERT INTO public.cloud_deal_files (owner_user_id, cloud_deal_id, local_attachment_id, blob_id, filename, content_hash)
VALUES ('__U__', '__D1__', 'att-__RUN__', '__X__', 'a.pdf', encode(sha256('f-__RUN__'::bytea), 'hex'));
SELECT set_config('p4263.t_hold', clock_timestamp()::text, true);
SELECT pg_sleep(4);
SELECT current_setting('p4263.txn', true) AS txn, current_setting('p4263.t_start', true) AS t_start,
       current_setting('p4263.t_hold', true) AS t_hold, clock_timestamp() AS t_end;
