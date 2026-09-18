-- S-c: an unclaimed invite that has not expired stops ensure (the invite decides).
-- A NULL expiry counts as not expired, and the email match ignores case and
-- surrounding spaces -- both as public.claim_pending_invite does. An expired
-- invite does not stop ensure.

DO $control$
DECLARE
  k_live uuid := current_setting('t3364.u_invite_live')::uuid;
  k_null uuid := current_setting('t3364.u_invite_null')::uuid;
  k_old  uuid := current_setting('t3364.u_invite_old')::uuid;
  v jsonb;
BEGIN
  v := public._ensure_personal_organization_for(k_live);
  PERFORM pg_temp.check(v->>'status' = 'pending_invite', format('unexpired invite returns pending_invite, got %s', v));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_live), 'no organization while an unexpired invite waits');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = k_live), 'no membership while an unexpired invite waits');

  v := public._ensure_personal_organization_for(k_null);
  PERFORM pg_temp.check(v->>'status' = 'pending_invite', format('invite with NULL expiry, stored in other case with a trailing space, returns pending_invite, got %s', v));
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM public.organizations WHERE personal_owner_user_id = k_null), 'no organization while a NULL-expiry invite waits');

  v := public._ensure_personal_organization_for(k_old);
  PERFORM pg_temp.check(v->>'status' = 'created', format('expired invite does not block: created, got %s', v));
  PERFORM pg_temp.check(EXISTS (
    SELECT 1 FROM public.organization_members m JOIN public.organizations o ON o.id = m.organization_id
    WHERE m.user_id = k_old AND o.personal_owner_user_id = k_old
  ), 'expired-invite user holds a personal membership');
END
$control$;
