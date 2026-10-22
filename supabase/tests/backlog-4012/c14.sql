-- BACKLOG-4012 C14 in a fresh transaction: the first trigger call in this transaction is made by
-- a client session, so the EXECUTE check on _billing_org_join_blocked is not cached away.
-- Run against the applied migration. Ends in RAISE: nothing persists.
DO $$
DECLARE o uuid := gen_random_uuid(); x uuid := gen_random_uuid(); s text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (x, 'p4012c-' || left(x::text, 8) || '@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{}', '{}', now(), now());
  INSERT INTO public.organizations (id, name, slug, max_seats, is_test) VALUES (o, 'P4012C', 'p4012c-' || left(o::text, 8), 10, true);
  INSERT INTO public.org_deals (organization_id, stripe_mode, seats, status) VALUES (o, 'test', 5, 'draft');
  INSERT INTO public.org_deal_lines (organization_id, item_key, quantity_rule, unit_price_cents, list_price_cents_at_save) VALUES (o, 'brokerage_seat', 'seats', 2499, 2499);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.organization_members (organization_id, user_id, role, license_status, joined_at, provisioned_by) VALUES (o, x, 'agent', 'active', now(), 'jit');
    s := 'OK inserted';
  EXCEPTION WHEN OTHERS THEN s := 'ERR ' || SQLSTATE || ' ' || left(SQLERRM, 80);
  END;
  RESET ROLE;
  RAISE EXCEPTION 'P4012_C14 %', s;
END $$;
