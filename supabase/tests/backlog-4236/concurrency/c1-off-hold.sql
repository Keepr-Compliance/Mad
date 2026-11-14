-- C1b: turn Cloud off and hold the transaction 4 s (settings row held FOR UPDATE).
SELECT public.set_my_cloud_autosave('__A__'::uuid, false) AS r, pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
