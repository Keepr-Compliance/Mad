-- C25a (Addendum B section 12 (c), K7): writing an ON override above the
-- plan's tier is refused at write time.
--   scope all:    owner adds sso_login ON to personal org I (individual)
--                 : 23514 'feature_override_above_tier: sso_login ...'
--   scope narrow: u_p signs in (personal org, individual); owner adds a NEW
--                 transaction_checklists ON entry to it
--                 : 23514 'feature_override_above_tier: transaction_checklists ...'
-- Mutant: m44 (the trigger dropped -> rows:1).

SELECT pg_temp.act_owner();
DO $c25a$
DECLARE
  v_org uuid;
BEGIN
  IF current_setting('t3473.scope') = 'all' THEN
    PERFORM pg_temp.expect('C25a I adds sso_login ON',
      format($q$UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"sso_login": {"enabled": true}}'::jsonb
                 WHERE organization_id = %L$q$, pg_temp.id('o_i')),
      '~^23514:feature_override_above_tier: sso_login requires enterprise; plan tier is individual$');
  ELSE
    v_org := (public._ensure_personal_organization_for(pg_temp.id('u_p')) ->> 'organization_id')::uuid;
    PERFORM pg_temp.check(v_org IS NOT NULL, 'u_p''s personal org created');
    PERFORM pg_temp.expect('C25a new personal org adds transaction_checklists ON',
      format($q$UPDATE public.organization_plans SET feature_overrides = '{"transaction_checklists": {"enabled": true}}'::jsonb
                 WHERE organization_id = %L$q$, v_org),
      '~^23514:feature_override_above_tier: transaction_checklists requires team; plan tier is individual$');
  END IF;
END
$c25a$;
