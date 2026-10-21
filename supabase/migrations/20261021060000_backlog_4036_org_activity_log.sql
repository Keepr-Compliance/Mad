-- BACKLOG-4036: an organization activity log for support.
--
-- Plan pm_comments a43fde12; SR plan review 1abef023 + 855e184e (required changes 1-8).
--
--  1. billing_change_log gains txid (default txid_current()) and source. Existing rows keep NULL
--     (ADD COLUMN first, SET DEFAULT second), so they never dedupe against each other.
--  2. _activity_actor()          who made the write: auth.uid(), except under the service role,
--                                where the portal's x-keepr-actor request header names the staff
--                                or broker user who asked for it. The header is trusted ONLY when
--                                the JWT role is service_role (any caller can send it); a value
--                                that is not a uuid gives NULL and never fails the write.
--  3. _org_member_change_log()   AFTER INSERT / UPDATE / row removal on organization_members:
--                                member_invited, member_added, invite_accepted,
--                                member_role_changed, member_license_changed, invite_resent,
--                                invite_cancelled, member_removed. A write that changes none of
--                                role / license_status / user_id / invitation_token logs nothing.
--                                Personal organizations and organizations that no longer exist
--                                (an organization removal cascading to its members) log nothing.
--  4. _user_phone_change_log()   AFTER INSERT / UPDATE OF phone / row removal on user_phones:
--                                phone_changed {member_id, cleared}; never the number. A pending
--                                phone row going away (invite accepted by a user who already has a
--                                phone, or the invite-cancel cascade) logs nothing.
--  5. admin_get_org_activity(p_org, p_limit) the reader for the admin org page. organizations.view
--                                gates it; deal / seat / suspension rows need billing.view as well.
--                                Trigger rows are hidden when an explicit row of the same
--                                transaction names the same member (member_id or old_member_id).
--                                Detail is whitelisted for both sources; no price, no phone.
-- No existing function is changed.

ALTER TABLE public.billing_change_log ADD COLUMN IF NOT EXISTS txid bigint;
ALTER TABLE public.billing_change_log ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE public.billing_change_log ALTER COLUMN txid SET DEFAULT txid_current();

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._activity_actor()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_role text;
  v_hdr text;
BEGIN
  BEGIN
    v_role := coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RETURN auth.uid();
  END IF;
  BEGIN
    v_hdr := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-keepr-actor';
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF v_hdr ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN v_hdr::uuid;
  END IF;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public._activity_actor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._activity_actor() TO service_role;

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._org_member_change_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.organization_members;
  v_personal uuid;
  v_actor uuid;
  v_name text;
  v_email text;
  v_via text;
  v_base jsonb;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;

  -- One lookup: a personal organization logs nothing, and neither does an organization that is
  -- gone (its removal cascades here, and the log has no foreign key to it).
  SELECT o.personal_owner_user_id INTO v_personal FROM public.organizations o WHERE o.id = r.organization_id;
  IF NOT FOUND OR v_personal IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- A move between organizations is not a member change either side would recognise.
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), '')),
         lower(u.email)
    INTO v_name, v_email
    FROM public.users u WHERE u.id = r.user_id;
  v_name := coalesce(v_name, nullif(btrim(concat_ws(' ', r.invited_first_name, r.invited_last_name)), ''));
  v_email := coalesce(v_email, lower(r.invited_email));

  v_via := CASE
    WHEN TG_OP = 'UPDATE' AND NEW.scim_synced_at IS DISTINCT FROM OLD.scim_synced_at THEN 'directory'
    WHEN TG_OP = 'INSERT' AND NEW.provisioned_by IN ('scim', 'directory_sync') THEN 'directory'
    WHEN TG_OP = 'INSERT' AND NEW.provisioned_by = 'jit' THEN 'sign_in'
  END;

  v_actor := public._activity_actor();
  v_base := jsonb_strip_nulls(jsonb_build_object('member_id', r.id, 'name', v_name, 'email', v_email, 'via', v_via));

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
    VALUES (NEW.organization_id, v_actor,
            CASE WHEN NEW.user_id IS NULL THEN 'member_invited' ELSE 'member_added' END,
            v_base || jsonb_build_object('role', NEW.role, 'license_status', NEW.license_status), 'trigger');
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
    VALUES (OLD.organization_id, v_actor,
            CASE WHEN OLD.user_id IS NULL THEN 'invite_cancelled' ELSE 'member_removed' END,
            v_base || jsonb_build_object('role', OLD.role), 'trigger');
  ELSIF OLD.user_id IS NULL AND NEW.user_id IS NOT NULL THEN
    -- Accepting covers the role / licence flip and the token clear done in the same write.
    INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
    VALUES (NEW.organization_id, v_actor, 'invite_accepted', v_base || jsonb_build_object('role', NEW.role), 'trigger');
  ELSE
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
      VALUES (NEW.organization_id, v_actor, 'member_role_changed',
              v_base || jsonb_build_object('from', OLD.role, 'to', NEW.role), 'trigger');
    END IF;
    IF NEW.license_status IS DISTINCT FROM OLD.license_status THEN
      INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
      VALUES (NEW.organization_id, v_actor, 'member_license_changed',
              v_base || jsonb_build_object('from', OLD.license_status, 'to', NEW.license_status), 'trigger');
    END IF;
    IF NEW.user_id IS NULL AND NEW.invitation_token IS NOT NULL
       AND NEW.invitation_token IS DISTINCT FROM OLD.invitation_token THEN
      INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
      VALUES (NEW.organization_id, v_actor, 'invite_resent', v_base, 'trigger');
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public._org_member_change_log() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER org_member_change_log
  AFTER INSERT OR UPDATE OR DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public._org_member_change_log();

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._user_phone_change_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.user_phones;
  v_actor uuid;
  v_cleared boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NULL;
  END IF;
  -- A pending phone only goes away when its invite is accepted by a user who already has a
  -- phone, or when the invite is cancelled (cascade). Neither changes anyone's phone.
  IF TG_OP = 'DELETE' AND OLD.pending_member_id IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.phone IS NULL THEN
    RETURN NULL;
  END IF;

  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  v_cleared := TG_OP = 'DELETE' OR NEW.phone IS NULL OR btrim(NEW.phone) = '';
  v_actor := public._activity_actor();

  -- One row per non-personal organization the phone belongs to; none when no organization
  -- resolves (never raises, so the write never fails because of the log).
  INSERT INTO public.billing_change_log (organization_id, actor_id, action, detail, source)
  SELECT m.organization_id, v_actor, 'phone_changed',
         jsonb_build_object('member_id', m.id, 'cleared', v_cleared), 'trigger'
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id AND o.personal_owner_user_id IS NULL
   WHERE (r.pending_member_id IS NOT NULL AND m.id = r.pending_member_id)
      OR (r.pending_member_id IS NULL AND r.user_id IS NOT NULL AND m.user_id = r.user_id);
  RETURN NULL;
END
$function$;

REVOKE ALL ON FUNCTION public._user_phone_change_log() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER user_phone_change_log
  AFTER INSERT OR UPDATE OF phone OR DELETE ON public.user_phones
  FOR EACH ROW EXECUTE FUNCTION public._user_phone_change_log();

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_org_activity(p_org uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_billing boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_permission(v_uid, 'organizations.view') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  v_billing := public.has_permission(v_uid, 'billing.view');

  WITH org_rows AS (
    SELECT c.created_at, c.action, c.actor_id, c.detail
      FROM public.billing_change_log c
     WHERE c.organization_id = p_org
       AND (v_billing OR c.action NOT IN ('deal_saved', 'seats_changed', 'suspended', 'reinstated',
                                          'auto_renew_on', 'auto_renew_off', 'deal_ended', 'setup_completed'))
       -- a trigger row is hidden when an explicit row of the same transaction names the member
       AND NOT (c.source IS NOT DISTINCT FROM 'trigger' AND EXISTS (
             SELECT 1 FROM public.billing_change_log e
              WHERE e.organization_id = c.organization_id
                AND e.txid = c.txid
                AND e.source IS DISTINCT FROM 'trigger'
                AND c.detail ->> 'member_id' IN (e.detail ->> 'member_id', e.detail ->> 'old_member_id')))
  ),
  staff_rows AS (
    SELECT a.created_at, a.action, a.actor_id,
           jsonb_strip_nulls(jsonb_build_object('plan', pl.name)) AS detail
      FROM public.admin_audit_logs a
      LEFT JOIN public.plans pl ON a.action = 'org_plan.assigned' AND pl.id::text = a.metadata ->> 'plan_id'
     WHERE a.target_type = 'organization'
       AND coalesce(a.metadata ->> 'organization_id', a.target_id) = p_org::text
       AND a.action IN ('organization.created', 'org_plan.assigned')
  ),
  merged AS (
    SELECT * FROM org_rows
    UNION ALL
    SELECT * FROM staff_rows
    ORDER BY 1 DESC
    LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'created_at', x.created_at,
           'action', x.action,
           'actor_name', coalesce(nullif(btrim(au.display_name), ''), au.email,
                                  CASE WHEN x.actor_id IS NOT NULL THEN NULL
                                       WHEN x.detail ->> 'via' = 'directory' THEN 'Directory sync'
                                       ELSE 'Keepr' END),
           'actor_is_staff', x.actor_id IS NOT NULL
                             AND EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = x.actor_id),
           'actor_is_subject', coalesce(x.actor_id = sm.user_id, false),
           'subject_name', coalesce(public._member_person(sm.id) ->> 'name', x.detail ->> 'name', x.detail ->> 'email'),
           'detail', (SELECT coalesce(jsonb_object_agg(k.key, k.value), '{}'::jsonb)
                        FROM jsonb_each(x.detail) k
                       WHERE k.key IN ('from', 'to', 'role', 'via', 'cleared', 'seats', 'reason', 'note', 'ends_on', 'plan')))
           ORDER BY x.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM merged x
    LEFT JOIN public.users au ON au.id = x.actor_id
    LEFT JOIN public.organization_members sm
      ON sm.organization_id = p_org
     AND sm.id::text = x.detail ->> 'member_id';
  RETURN v_out;
END
$function$;

REVOKE ALL ON FUNCTION public.admin_get_org_activity(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_org_activity(uuid, integer) TO authenticated, service_role;
