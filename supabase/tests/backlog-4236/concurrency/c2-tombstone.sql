-- C2: tombstone the message while the other session holds the deal row.
SELECT public.cloud_tombstone('__I__'::uuid, 'message', ARRAY['__MSG__'::uuid]) AS r;
