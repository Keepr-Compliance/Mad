-- R5 session 2: IB claims with replace while the turn-off holds.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__CLAIM_FN__('__A__'::uuid, '__IB__'::uuid, true))::text, true);
