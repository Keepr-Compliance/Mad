-- C2 (as the table owner, before as-user.sql): take the deal row lock first, hold 8 s, then upsert the
-- message as the user in the same transaction (the order the upsert itself uses: deal, then rows).
SELECT 1 FROM public.cloud_deals WHERE id = '__DEAL__'::uuid FOR NO KEY UPDATE;
SELECT pg_sleep(8) /*p_hold:__RUN__*/;
