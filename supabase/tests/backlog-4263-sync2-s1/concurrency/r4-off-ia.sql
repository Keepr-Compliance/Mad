-- R4 session 2: IA's owed turn-off, sent with IA's install, started while the claim holds.
SELECT public.__OFF_FN__('__A__'::uuid, false, 1, '__IA__'::uuid) AS r;
