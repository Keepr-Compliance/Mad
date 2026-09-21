-- C25b: only the entries a write adds or changes are validated, so an
-- existing above-tier entry never blocks an unrelated edit.
-- Personal org I still holds its above-tier call_log ON (scope all) and
-- transaction_checklists ON (both scopes) entries, written before migration 1.
--   owner adds desktop_text_export ON (min_tier NULL) to I          : rows:1
-- Mutant: m45 (validate every entry -> raises on call_log / transaction_checklists).

SELECT pg_temp.act_owner();
SELECT pg_temp.expect('C25b unrelated entry added beside above-tier ones',
  format($q$UPDATE public.organization_plans SET feature_overrides = feature_overrides || '{"desktop_text_export": {"enabled": true}}'::jsonb
             WHERE organization_id = %L$q$, pg_temp.id('o_i')),
  'rows:1');
DO $post$
BEGIN
  PERFORM pg_temp.check(
    (SELECT feature_overrides ? 'transaction_checklists' AND feature_overrides ? 'call_log' AND feature_overrides ? 'desktop_text_export'
       FROM public.organization_plans WHERE organization_id = pg_temp.id('o_i')),
    'the old entries stay in the JSON beside the new one');
END
$post$;
