DROP POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements;
CREATE POLICY agent_commission_agreements_insert_writer ON public.agent_commission_agreements
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_commission_agreements(agent_commission_agreements.organization_id)
              AND EXISTS (SELECT 1 FROM public.organization_members m
                           WHERE m.organization_id = organization_id
                             AND m.user_id = agent_commission_agreements.agent_user_id));
SELECT 'MUTATION APPLIED: the EXISTS clause uses an UNQUALIFIED organization_id (binds to m.organization_id -- vacuously true)';
