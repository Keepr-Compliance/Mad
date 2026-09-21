-- C25a (Addendum B section 12 (c), K7, K9): writing an ON override above the
-- plan's tier is refused at write time.
--   owner adds sso_login ON to personal org I (individual)
--     : 23514 'feature_override_above_tier: sso_login requires enterprise ...'
--   owner sets T1's (team) sso_login entry to {} -- no `enabled` key, which the
--   three read functions treat as ON
--     : 23514 'feature_override_above_tier: sso_login requires enterprise ...'
--   owner-side: _override_above_tier('sso_login', 'enterprise', 'team', '{}')
--     : true
-- Mutants: m44 (the trigger dropped -> rows:1), mx01 (the helper treats a
-- missing `enabled` as OFF -> rows:1, and the owner-side call is false).

SELECT pg_temp.act_owner();
DO $c25a$
BEGIN
  PERFORM pg_temp.expect('C25a I adds sso_login ON',
    format($q$UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"sso_login": {"enabled": true}}'::jsonb
               WHERE organization_id = %L$q$, pg_temp.id('o_i')),
    '~^23514:feature_override_above_tier: sso_login requires enterprise; plan tier is individual$');
  PERFORM pg_temp.expect('C25a T1 sets sso_login to an entry with no enabled key',
    format($q$UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"sso_login": {}}'::jsonb
               WHERE organization_id = %L$q$, pg_temp.id('o_t1')),
    '~^23514:feature_override_above_tier: sso_login requires enterprise; plan tier is team$');
  PERFORM pg_temp.check(public._override_above_tier('sso_login', 'enterprise', 'team', '{}'::jsonb) IS TRUE,
                        'C25a helper: an entry with no enabled key counts as ON');
END
$c25a$;
