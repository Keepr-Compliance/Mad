-- R3 session 2: IB claims without replace while session 1 holds.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__CLAIM_FN__('__A__'::uuid, '__IB__'::uuid, false))::text, true);
