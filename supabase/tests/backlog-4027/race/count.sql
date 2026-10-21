SELECT count(*) FILTER (WHERE m.role = 'admin' AND m.license_status = 'active') AS active_admins
  FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id WHERE o.slug = 'p4027-race';
