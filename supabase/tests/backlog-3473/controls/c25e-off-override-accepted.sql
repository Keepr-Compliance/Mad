-- C25e (K7): an override that turns a feature OFF is never refused, even
-- above tier.
--   scope all:    owner adds sso_login OFF to personal org I          : rows:1
--   scope narrow: owner changes I's transaction_checklists entry to OFF : rows:1
-- Mutant: m31 (the helper's `enabled` conjunct dropped -> raises; the same
-- mutant reds C15 case 15.10).

SELECT pg_temp.act_owner();
DO $c25e$
BEGIN
  IF current_setting('t3473.scope') = 'all' THEN
    PERFORM pg_temp.expect('C25e sso_login OFF on I',
      format($q$UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"sso_login": {"enabled": false}}'::jsonb
                 WHERE organization_id = %L$q$, pg_temp.id('o_i')),
      'rows:1');
  ELSE
    PERFORM pg_temp.expect('C25e transaction_checklists OFF on I',
      format($q$UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"transaction_checklists": {"enabled": false}}'::jsonb
                 WHERE organization_id = %L$q$, pg_temp.id('o_i')),
      'rows:1');
  END IF;
END
$c25e$;
