-- C1: turn Cloud off (started while the other session holds its write).
SELECT public.set_my_cloud_autosave(false) AS r;
