/**
 * Feature-gate fixtures — BACKLOG-3087.
 *
 * PROVENANCE MATTERS HERE. A gate is only proven by inputs its producer can
 * actually emit; a hand-written payload proves the test, not the code. So the
 * two payloads that decide this item are transcribed from the live
 * broker_get_org_features, not composed:
 *
 *   NOT_AUTHENTICATED_PAYLOAD
 *     `select public.broker_get_org_features(<org>)` run over the Supabase MCP
 *     connection on 2026-09-03. That connection is the `postgres` role, so
 *     auth.uid() is NULL and the function takes its first early-return. Copied
 *     verbatim from the jsonb_pretty output, with the org id replaced.
 *
 *   ORG_WITHOUT_PLAN_FEATURES
 *     The same org's real feature map, reproduced on 2026-09-03 by running the
 *     function's own resolution logic as a read-only set query (organization_plans
 *     -> feature_overrides -> plan_features -> default_value) against prod.
 *     `has_plan` came back 0 — the brokerage this item was filed for has NO
 *     organization_plans row, so every one of these 21 keys resolves with
 *     source 'default'. scim_provisioning is ABSENT because the migration in
 *     this PR has not been applied — this is the state prod is in right now,
 *     and it is control (b) ("delete the scim_provisioning feature row") for
 *     free.
 *
 *     The live organization_id is NOT reproduced here. This repository is
 *     public and a committed id cannot be un-published (BACKLOG-2871); the
 *     payload's SHAPE is what these tests exercise, and the id is inert to
 *     every assertion in them.
 *
 * SCIM_ENABLED_FEATURES / SCIM_DISABLED_FEATURES are DERIVED, not transcribed:
 * they are what the function's jsonb_build_object emits once the feature row
 * exists. Marked as such so nobody later mistakes them for observed output.
 */

import type { OrgFeatures, OrgFeatureDetail } from '@/lib/feature-gate';

/** Stand-in org id. pii-allow-uuid: invented, not from any live row. */
export const TEST_ORG_ID = '00000000-3087-4000-8000-000000000001';

/** Verbatim apart from org_id: RPC output when auth.uid() is NULL. Note the
 *  200-with-error shape — an error reported as DATA, with HTTP 200. */
export const NOT_AUTHENTICATED_PAYLOAD = {
  error: 'not_authenticated',
  org_id: TEST_ORG_ID,
  features: {},
  plan_name: 'none',
  plan_tier: 'none',
};

const d = (
  name: string,
  enabled: boolean,
  value: string,
  value_type = 'boolean'
): OrgFeatureDetail => ({ name, value, source: 'default', enabled, value_type });

/** Verbatim: the 21 keys prod resolves for an org with no plan row. */
export const ORG_WITHOUT_PLAN_FEATURES: OrgFeatures = {
  org_id: TEST_ORG_ID,
  plan_name: 'none',
  plan_tier: 'none',
  features: {
    call_log: d('Call Log Access', false, 'false'),
    max_seats: d('Maximum Seats', false, 'false', 'integer'),
    sso_login: d('SSO Login', false, 'false'),
    email_sync: d('Email Sync', true, 'true'),
    multi_seat: d('Multi-Seat', false, 'false'),
    iphone_sync: d('iPhone Sync', true, 'true'),
    ai_detection: d('AI Detection', false, 'false'),
    team_management: d('Team Management', false, 'false'),
    broker_text_view: d('Broker Text View', true, 'true'),
    custom_retention: d('Custom Retention Period', false, 'false'),
    broker_email_view: d('Broker Email View', true, 'true'),
    broker_submission: d('Broker Submission', false, 'false'),
    desktop_text_export: d('Desktop Text Export', false, 'false'),
    voice_transcription: d('Voice Message Transcription', false, 'false'),
    broker_portal_access: d('Broker Portal Access', false, 'false'),
    desktop_email_export: d('Desktop Email Export', false, 'false'),
    max_transaction_size: d('Max Transaction Size', false, '10', 'integer'),
    broker_text_attachments: d('Broker Text Attachments', false, 'false'),
    broker_email_attachments: d('Broker Email Attachments', false, 'false'),
    desktop_text_attachments: d('Desktop Text Attachments', false, 'false'),
    desktop_email_attachments: d('Desktop Email Attachments', false, 'false'),
  },
};

/**
 * Pre-registered count. The fixture claims to be "the 21 keys prod resolves";
 * a silent edit that drops one would otherwise weaken every absence assertion
 * built on it without failing anything.
 */
export const ORG_WITHOUT_PLAN_KEY_COUNT = 21;

const SCIM_DETAIL = {
  name: 'SCIM Provisioning',
  value_type: 'boolean',
};

/** DERIVED (not transcribed): post-migration state, feature seeded and off. */
export const SCIM_DISABLED_FEATURES: OrgFeatures = {
  ...ORG_WITHOUT_PLAN_FEATURES,
  features: {
    ...ORG_WITHOUT_PLAN_FEATURES.features,
    scim_provisioning: { ...SCIM_DETAIL, enabled: false, value: 'false', source: 'default' },
  },
};

/** DERIVED (not transcribed): an org switched on via feature_overrides. */
export const SCIM_ENABLED_FEATURES: OrgFeatures = {
  ...ORG_WITHOUT_PLAN_FEATURES,
  plan_name: 'Enterprise',
  plan_tier: 'enterprise',
  features: {
    ...ORG_WITHOUT_PLAN_FEATURES.features,
    scim_provisioning: { ...SCIM_DETAIL, enabled: true, value: 'true', source: 'override' },
  },
};

/** pii-allow-uuid: invented, not from any live row. */
export const TEST_USER_ID = '00000000-3087-4000-8000-000000000002';

/**
 * DERIVED (not transcribed) — BACKLOG-3078.
 *
 * Set one key to a known state on top of the transcribed base. Used for the
 * gray-vs-hide rule, which needs three different orgs: a plan without
 * custom_retention (grayed), a plan with it (enabled), and the unbuilt keys in
 * both states.
 *
 * Writes the SAME shape jsonb_build_object emits — name/value/source/enabled/
 * value_type — so a gate reading any of those fields sees a producible row.
 */
export function withFeature(
  base: OrgFeatures,
  key: string,
  enabled: boolean,
  name = key
): OrgFeatures {
  return {
    ...base,
    features: {
      ...base.features,
      [key]: {
        name,
        value: enabled ? 'true' : 'false',
        source: 'default',
        enabled,
        value_type: 'boolean',
      },
    },
  };
}

/** DERIVED: a team-plan org — custom_retention off, both unbuilt keys seeded off. */
export const TEAM_PLAN_FEATURES: OrgFeatures = withFeature(
  withFeature(
    withFeature(ORG_WITHOUT_PLAN_FEATURES, 'custom_retention', false, 'Custom Retention Period'),
    'scim_provisioning',
    false,
    'SCIM Provisioning'
  ),
  'jit_provisioning',
  false,
  'Just-in-Time Provisioning'
);

/** DERIVED: an enterprise org — custom_retention on, unbuilt keys still off. */
export const ENTERPRISE_PLAN_FEATURES: OrgFeatures = {
  ...withFeature(TEAM_PLAN_FEATURES, 'custom_retention', true, 'Custom Retention Period'),
  plan_name: 'Enterprise',
  plan_tier: 'enterprise',
};

// ---------------------------------------------------------------------------
// A Supabase server-client stand-in.
// ---------------------------------------------------------------------------
// Chainable, thenable query object: every builder method returns itself, and
// awaiting it (or calling .single()) resolves the result configured for that
// table. Mirrors how the real client is used in lib/actions/scim.ts.

export interface TableResult {
  data?: unknown;
  error?: unknown;
}

export function makeQuery(result: TableResult) {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  for (const m of [
    'select', 'eq', 'in', 'neq', 'order', 'limit', 'update', 'insert', 'delete',
  ]) {
    q[m] = jest.fn(chain);
  }
  q.single = jest.fn(async () => result);
  q.maybeSingle = jest.fn(async () => result);
  // Thenable so `await client.from(t).update(...).eq(...)` resolves.
  q.then = (res: (v: TableResult) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return q;
}

export interface StubOptions {
  /** null => unauthenticated */
  user?: { id: string } | null;
  /** null => no membership row matched (wrong role, or not a member) */
  membership?: { organization_id: string; role?: string } | null;
  /** What supabase.rpc() resolves to. */
  rpc?: { data?: unknown; error?: unknown };
  /** Per-table terminal results for anything other than organization_members. */
  tables?: Record<string, TableResult>;
}

export function makeSupabaseStub(opts: StubOptions = {}) {
  const rpc = jest.fn(async () => opts.rpc ?? { data: null, error: null });
  const from = jest.fn((table: string) => {
    if (table === 'organization_members') {
      return makeQuery({ data: opts.membership ?? null, error: null });
    }
    return makeQuery(opts.tables?.[table] ?? { data: [], error: null });
  });
  return {
    client: {
      auth: {
        getUser: jest.fn(async () => ({
          data: { user: opts.user === undefined ? { id: TEST_USER_ID } : opts.user },
        })),
      },
      from,
      rpc,
    },
    rpc,
    from,
  };
}
