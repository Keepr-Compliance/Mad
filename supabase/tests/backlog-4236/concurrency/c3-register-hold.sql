-- C3a: register a blob and hold the transaction 8 s, then (as the table owner, still in the same
-- transaction) count the sessions blocked on a lock in the C3b statement: 1 = the two registrations overlapped.
SELECT set_config('p4236.c3r', public.cloud_register_blob(encode(sha256('cc-blob-__RUN__'::bytea), 'hex'), 10, NULL)::text, true),
       pg_sleep(8) /*p_hold:__RUN__*/;
RESET ROLE;
SELECT current_setting('p4236.c3r')::jsonb AS r,
       (SELECT count(*) FROM pg_catalog.pg_stat_activity
         WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
           AND query LIKE '%c3_wait:' || '__RUN__' || '*/%') AS waiters;
