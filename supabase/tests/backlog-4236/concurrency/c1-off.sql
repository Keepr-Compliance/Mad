-- C1: turn Cloud off (started while the other session holds its write).
SELECT public.set_my_cloud_autosave('__A__'::uuid, false) AS r;
