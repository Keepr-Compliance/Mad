-- R3 session 2: IB claims without replace while session 1 holds.
SELECT public.__CLAIM_FN__('__A__'::uuid, '__IB__'::uuid, false) AS r;
