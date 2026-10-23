-- as the database owner (passes the guard)
UPDATE public.organization_members m SET role = 'admin' FROM public.organizations o WHERE o.id = m.organization_id AND o.slug = 'p4027-race';
