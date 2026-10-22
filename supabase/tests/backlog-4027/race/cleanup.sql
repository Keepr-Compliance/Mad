DO $c$
DECLARE o uuid; us uuid[];
BEGIN
  SELECT id INTO o FROM public.organizations WHERE slug = 'p4027-race';
  IF o IS NULL THEN RETURN; END IF;
  SELECT array_agg(user_id) INTO us FROM public.organization_members WHERE organization_id = o;
  DELETE FROM public.organization_members WHERE organization_id = o;
  DELETE FROM public.billing_change_log WHERE organization_id = o;
  DELETE FROM public.organizations WHERE id = o;
  DELETE FROM public.users WHERE id = ANY(us);
  DELETE FROM auth.users WHERE id = ANY(us);
END $c$;
