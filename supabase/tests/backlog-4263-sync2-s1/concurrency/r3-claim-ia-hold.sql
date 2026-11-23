-- R3 session 1: IA claims (no active computer), then holds 4 s.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__CLAIM_FN__('__A__'::uuid, '__IA__'::uuid, false))::text, true);
SELECT set_config('p4263.t_hold', clock_timestamp()::text, true);
SELECT pg_sleep(4);
