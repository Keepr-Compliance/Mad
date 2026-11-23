-- R3 session 1: IA claims (no active computer), then holds 4 s.
SELECT public.cloud_claim_install('__A__'::uuid, '__IA__'::uuid, false) AS r, pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
