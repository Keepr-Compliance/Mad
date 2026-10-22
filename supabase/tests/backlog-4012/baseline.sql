DO $$
DECLARE o uuid := gen_random_uuid(); o0 uuid := gen_random_uuid(); u uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1,4)); r jsonb := '{}'; s text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT x, 'p4012b-' || left(x::text,8) || '@example.test', 'authenticated','authenticated','00000000-0000-0000-0000-000000000000','{}','{}',now(),now() FROM unnest(u) x;
  INSERT INTO public.users (id, email, oauth_provider, oauth_id) SELECT x, 'p4012b-' || left(x::text,8) || '@example.test','azure','p4012b-'||x FROM unnest(u) x ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.organizations (id,name,slug,max_seats,is_test) VALUES (o,'P4012B a','p4012b-'||left(o::text,8),10,true),(o0,'P4012B z','p4012b-'||left(o0::text,8),10,true);
  INSERT INTO public.organization_members (organization_id,user_id,role,license_status,joined_at) VALUES (o0,u[4],'admin','active',now());
  INSERT INTO public.org_deals (organization_id,stripe_mode,seats,status) VALUES (o,'test',5,'draft'),(o0,'test',5,'draft');
  INSERT INTO public.org_deal_lines (organization_id,item_key,quantity_rule,unit_price_cents,list_price_cents_at_save) VALUES (o,'brokerage_seat','seats',2499,2499),(o0,'brokerage_seat','seats',0,2499);
  BEGIN INSERT INTO public.organization_members (organization_id,user_id,role,license_status,joined_at,provisioned_by) VALUES (o,u[1],'agent','active',now(),'jit'); s:='OK'; EXCEPTION WHEN OTHERS THEN s:='ERR '||SQLERRM; END;
  r := r || jsonb_build_object('B1_jit_insert_paid_draft_today', s);
  BEGIN SET LOCAL ROLE service_role; INSERT INTO public.organization_members (organization_id,user_id,role,license_status,joined_at,provisioned_by) VALUES (o,u[2],'agent','active',now(),'scim'); RESET ROLE; s:='OK'; EXCEPTION WHEN OTHERS THEN s:='ERR '||SQLERRM; END;
  RESET ROLE;
  r := r || jsonb_build_object('B2_scim_insert_paid_draft_today', s);
  PERFORM set_config('request.jwt.claims', json_build_object('sub',u[4],'role','authenticated')::text, true);
  r := r || jsonb_build_object('B3_4007_helper_zero_dollar_today', public._billing_org_setup_pending(o0));
  r := r || jsonb_build_object('B4_authenticated_can_exec_jit_1arg', has_function_privilege('authenticated','public.jit_join_organization(text)','EXECUTE'),
                               'B5_jit_2arg_exists', to_regprocedure('public.jit_join_organization(text,text)') IS NOT NULL);
  RAISE EXCEPTION 'P4012_BASELINE %', r;
END $$;
