-- R2 session 1: IA confirms its blob (object missing), then holds its transaction (settings FOR SHARE) 4 s.
SELECT public.__CONFIRM_FN__('__A__'::uuid, '__IA__'::uuid, '__BLOB__'::uuid) AS r,
       clock_timestamp() AS t_write, pg_sleep(4) /*p_hold:__RUN__*/ AS hold;
