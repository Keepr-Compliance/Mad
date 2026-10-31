-- BACKLOG-4086: Support SLA targets and business window (pausing business-hours clock).
-- One row (id = 1), typed columns, validated by CHECKs. Read by any internal role (the Support SLA
-- report); edited by holders of support.admin. Idempotent: safe to apply twice.
-- Rollback: supabase/tests/backlog-4086/rollback-4086.sql.

CREATE TABLE IF NOT EXISTS public.support_sla_settings (
  id                              smallint PRIMARY KEY DEFAULT 1
                                    CONSTRAINT support_sla_settings_single_row CHECK (id = 1),
  first_response_target_minutes   integer NOT NULL DEFAULT 480
                                    CHECK (first_response_target_minutes > 0),
  resolution_target_business_days integer NOT NULL DEFAULT 3
                                    CHECK (resolution_target_business_days > 0),
  business_day_start_minute       integer NOT NULL DEFAULT 540
                                    CHECK (business_day_start_minute BETWEEN 0 AND 1439),
  business_day_end_minute         integer NOT NULL DEFAULT 1020
                                    CHECK (business_day_end_minute BETWEEN 1 AND 1440),
  business_days                   smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'
                                    CHECK (cardinality(business_days) BETWEEN 1 AND 7
                                           AND business_days <@ '{0,1,2,3,4,5,6}'::smallint[]),
  time_zone                       text NOT NULL DEFAULT 'America/Los_Angeles'
                                    CHECK (length(time_zone) BETWEEN 1 AND 64),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  updated_by                      uuid,
  CONSTRAINT support_sla_settings_window_ck CHECK (business_day_end_minute > business_day_start_minute)
);

ALTER TABLE public.support_sla_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.support_sla_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON public.support_sla_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_sla_settings TO service_role;

DROP POLICY IF EXISTS support_sla_settings_select_internal ON public.support_sla_settings;
CREATE POLICY support_sla_settings_select_internal ON public.support_sla_settings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.internal_roles ir WHERE ir.user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS support_sla_settings_update_admin ON public.support_sla_settings;
CREATE POLICY support_sla_settings_update_admin ON public.support_sla_settings
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.internal_roles ir
    JOIN public.admin_role_permissions arp ON arp.role_id = ir.role_id
    JOIN public.admin_permissions ap ON ap.id = arp.permission_id
    WHERE ir.user_id = (SELECT auth.uid()) AND ap.key = 'support.admin'
  ))
  WITH CHECK (EXISTS (
    SELECT 1
    FROM public.internal_roles ir
    JOIN public.admin_role_permissions arp ON arp.role_id = ir.role_id
    JOIN public.admin_permissions ap ON ap.id = arp.permission_id
    WHERE ir.user_id = (SELECT auth.uid()) AND ap.key = 'support.admin'
  ));

-- updated_at / updated_by are maintained here, never by the client.
CREATE OR REPLACE FUNCTION public.support_sla_settings_touch()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = ''
AS $fn$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := (SELECT auth.uid());
  RETURN NEW;
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.support_sla_settings_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS support_sla_settings_touch ON public.support_sla_settings;
CREATE TRIGGER support_sla_settings_touch
  BEFORE UPDATE ON public.support_sla_settings
  FOR EACH ROW EXECUTE FUNCTION public.support_sla_settings_touch();

INSERT INTO public.support_sla_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.support_sla_settings IS
  'BACKLOG-4086: Support SLA targets and business window (pausing clock). One row. Read by internal roles; edited by support.admin.';
