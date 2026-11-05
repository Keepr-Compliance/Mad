/**
 * BACKLOG-3951 fixtures. UNASSIGNED_MEMBER_ROW is copied verbatim from the
 * transcribed keepr-test row in
 * broker-portal/__tests__/app/api/payments/payments.test.ts (PR-A, R3):
 * set_member_license(member, 'unassign') read back inside a rolled-back
 * transaction on 2026-11-05; ids nil, name and slug replaced, timestamps kept.
 * Only `user_id` differs (the emulator's fixture user). The jest projects do
 * not share modules, so it is copied, not imported.
 */

import { FIXTURE_USER_ID, type Row } from "./postgrestEmulator";

export const NIL = "00000000-0000-0000-0000-000000000000";

export const UNASSIGNED_MEMBER_ROW: Row = {
  id: NIL,
  organization_id: NIL,
  user_id: FIXTURE_USER_ID,
  role: "agent",
  license_status: "unassigned",
  provisioned_by: "scim",
  provisioned_at: "2026-10-16T20:29:44.317+00:00",
  provisioning_metadata: null,
  scim_synced_at: "2026-10-16T20:29:44.317+00:00",
  joined_at: "2026-10-16T20:29:44.317+00:00",
  invited_at: "2026-10-16T20:29:44.384209+00:00",
  invited_by: null,
  invited_email: null,
  invited_first_name: null,
  invited_last_name: null,
  invitation_token: null,
  invitation_expires_at: null,
  last_invited_at: null,
  idp_groups: null,
  group_sync_enabled: false,
  license_assigned_at: null,
  deactivated_at: null,
  created_at: "2026-10-16T20:29:44.384209+00:00",
  updated_at: "2026-11-05T06:25:49.566556+00:00",
  organizations: {
    id: NIL,
    name: "Fixture Brokerage",
    slug: "fixture-brokerage",
    plan: "trial",
    is_test: true,
    settings: {},
    max_seats: 3,
    retention_years: 7,
    default_member_role: "agent",
    personal_owner_user_id: null,
    sso_enabled: false,
    sso_required: false,
    sso_domain_restriction: null,
    scim_enabled: true,
    jit_provisioning_enabled: false,
    directory_sync_enabled: false,
    directory_sync_last_at: null,
    google_domain: null,
    microsoft_tenant_id: null,
    graph_admin_consent_at: null,
    graph_admin_consent_granted: false,
    created_at: "2026-10-16T20:29:44.384209+00:00",
    updated_at: "2026-10-16T20:29:44.384209+00:00",
  },
};

/** Billing-only login (20261020180000): unassigned with provisioning_metadata.billing_only. */
export const BILLING_ONLY_ROW: Row = {
  ...UNASSIGNED_MEMBER_ROW,
  provisioned_by: "invite",
  provisioning_metadata: { billing_only: true },
  scim_synced_at: null,
};

