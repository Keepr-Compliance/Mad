-- R4 session 2: IA's owed turn-off, sent with IA's install, started while the claim holds.
SELECT set_config('p4263.t_start', clock_timestamp()::text, true);
SELECT set_config('p4263.r', (public.__OFF_FN__('__A__'::uuid, false, 1, '__IA__'::uuid))::text, true);
