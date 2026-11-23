-- R5 session 1: IA (active) turns off, then holds 4 s.
SELECT public.__OFF_FN__('__A__'::uuid, false, 1, '__IA__'::uuid) AS r, pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
