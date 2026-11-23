-- session 2: IB claims with replace, started while session 1 holds; t_end is read from the server clock after the claim.
SELECT public.cloud_claim_install('__A__'::uuid, '__IB__'::uuid, true) AS r, clock_timestamp() AS t_end;
