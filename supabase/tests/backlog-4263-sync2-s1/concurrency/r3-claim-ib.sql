-- R3 session 2: IB claims without replace while session 1 holds.
SELECT public.cloud_claim_install('__A__'::uuid, '__IB__'::uuid, false) AS r;
