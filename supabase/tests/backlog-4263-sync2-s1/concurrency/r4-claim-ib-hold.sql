-- R4 session 1: IB takes over (replace), then holds its transaction (settings FOR UPDATE) 4 s.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__CLAIM_FN__('__A__'::uuid, '__IB__'::uuid, true))::text, true);
SELECT set_config('p4263.t_hold', clock_timestamp()::text, true);
SELECT pg_sleep(4);
