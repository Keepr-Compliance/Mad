-- BACKLOG-3878 fixtures, after the 3845 + 3846 fixtures and the 3846 migration.
-- Synthetic ids (derived from names) and Stripe ids only.
--   u_test: the 3845 is_test user (active licence, personal org) with the 3846
--           open test-mode subscription mirror row; given a TEST stripe_customers
--           row here (shape: stripe_customers per 20261011230913, PK user_id+mode).
--   u_live: the 3845 user with a live stripe_customers row (from the 3845 fixtures).
--   u_susp: the 3845 user whose licence is already suspended; no customer row.
INSERT INTO public.stripe_customers (user_id, stripe_customer_id, stripe_mode)
VALUES (pg_temp.id('u_test'), 'cus_FX3878t', 'test');

CREATE FUNCTION pg_temp.ob(p_name text, p_kind text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM public.billing_outbox WHERE user_id = pg_temp.id(p_name) AND kind = p_kind $f$;
CREATE FUNCTION pg_temp.ob_all(p_name text) RETURNS text LANGUAGE sql AS $f$
  SELECT coalesce(string_agg(kind || '/' || stripe_mode || '/' || (payload ->> 'from') || '->' || (payload ->> 'to'), ', ' ORDER BY created_at, kind), '<none>')
    FROM public.billing_outbox WHERE user_id = pg_temp.id(p_name) $f$;
-- An internal user's call, as the admin portal makes it (role authenticated + JWT).
CREATE FUNCTION pg_temp.admin_ok(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE r text;
BEGIN
  r := pg_temp.admin(p_sql);
  PERFORM pg_temp.check('setup call ok: ' || left(p_sql, 60), r LIKE 'OK %', r);
  RETURN r;
END $f$;

SELECT pg_temp.check('pre: u_test licence active, one test customer row, no outbox rows',
  pg_temp.lic_status('u_test') = 'active'
  AND (SELECT count(*) = 1 FROM public.stripe_customers WHERE user_id = pg_temp.id('u_test'))
  AND NOT EXISTS (SELECT 1 FROM public.billing_outbox));
