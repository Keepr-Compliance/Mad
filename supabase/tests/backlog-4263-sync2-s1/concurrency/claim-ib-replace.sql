-- session 2: IB claims with replace, started while session 1 holds; records how long the call waited.
SELECT now() AS t_start, public.cloud_claim_install('__A__'::uuid, '__IB__'::uuid, true) AS r, clock_timestamp() AS t_end,
       extract(epoch FROM clock_timestamp() - now()) AS waited_s;
