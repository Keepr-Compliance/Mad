-- R2 session 1: IA confirms its blob (object missing), then holds its transaction (settings FOR SHARE) 4 s.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__CONFIRM_FN__('__A__'::uuid, '__IA__'::uuid, '__BLOB__'::uuid))::text, true);
SELECT set_config('p4263.t_hold', clock_timestamp()::text, true);
SELECT pg_sleep(4);
