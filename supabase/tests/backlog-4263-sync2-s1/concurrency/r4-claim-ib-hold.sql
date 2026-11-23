-- R4 session 1: IB takes over (replace), then holds its transaction (settings FOR UPDATE) 4 s.
SELECT public.cloud_claim_install('__A__'::uuid, '__IB__'::uuid, true) AS r, pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
