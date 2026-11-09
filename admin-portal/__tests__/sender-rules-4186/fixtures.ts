/**
 * BACKLOG-4186 PR B fixtures, TRANSCRIBED from the real producers, not invented.
 *
 * Source: supabase/tests/backlog-4186/capture-pr-b.py (capture-pr-b.sql), run with kt-sql on
 * keepr-test 2026-11-09 against the PR A migration
 * (supabase/migrations/20261109210000_backlog_4186_sender_rule_set_reads.sql) and the 4175 write
 * RPCs, as a Super Admin (report owner), in one transaction ending in RAISE (nothing persisted).
 *
 * Changed from the captured output, nothing else: the org ids (pg_temp.fx ids) are replaced by fid(),
 * the org names by "Test Org A/B". Errors are PostgREST's shape {code, message, details, hint}:
 * code = SQLSTATE, details = DETAIL, captured with GET STACKED DIAGNOSTICS.
 *
 * Captured sequence: STATE_INITIAL (keepr-test: only the bundled v1) -> the release of
 * GUARDED_CONTENT is refused (ERRORS.release_refused, one block of each kind) -> the same content is
 * published as a canary for org A (returned 2) and org B is pinned to v2 -> STATE_CANARY ->
 * the same release then succeeds (returned 3) -> STATE_RELEASED (the release ended both tests).
 */

import type { SenderRuleSet } from '@/lib/sender-rules/types';

/** An invented id: the nil UUID with n in its last group (no literal UUID in this file). */
export function fid(n: number): string {
  return '00000000-0000-0000-0000-' + n.toString(16).padStart(12, '0');
}

export const ORG_A = fid(0xa1);
export const ORG_B = fid(0xb1);

/** `state_initial` */
export const STATE_INITIAL = { pins: [], released_version: 1, truncated: false, versions: [
    { bundled: true, canary_org: null, canary_org_name: null, published_at: '2026-11-07T19:36:39.82752+00:00', released: true, version: 1 },
  ] };

/** `state_canary` */
export const STATE_CANARY = { pins: [
    { org_id: ORG_A, org_name: 'Test Org A', pinned_at: '2026-11-09T20:19:01.144745+00:00', version: 2 },
    { org_id: ORG_B, org_name: 'Test Org B', pinned_at: '2026-11-09T20:19:01.144745+00:00', version: 2 },
  ], released_version: 1, truncated: false, versions: [
    { bundled: false, canary_org: ORG_A, canary_org_name: 'Test Org A', published_at: '2026-11-09T20:19:01.144745+00:00', released: false, version: 2 },
    { bundled: true, canary_org: null, canary_org_name: null, published_at: '2026-11-07T19:36:39.82752+00:00', released: true, version: 1 },
  ] };

/** `state_released` */
export const STATE_RELEASED = { pins: [], released_version: 3, truncated: false, versions: [
    { bundled: false, canary_org: null, canary_org_name: null, published_at: '2026-11-09T20:19:01.144745+00:00', released: true, version: 3 },
    { bundled: false, canary_org: ORG_A, canary_org_name: 'Test Org A', published_at: '2026-11-09T20:19:01.144745+00:00', released: false, version: 2 },
    { bundled: true, canary_org: null, canary_org_name: null, published_at: '2026-11-07T19:36:39.82752+00:00', released: true, version: 1 },
  ] };

/** The 4175 RPC refusals, as supabase-js hands them over (`error`). */
export const ERRORS = {
  release_refused: { code: '22023', details: '[{"kind": "mode", "signal": "bulkHeaders", "surface": "learnQuestions"}, {"item": "promo.example.com", "kind": "add", "list": "suppress.hosts"}, {"item": "showingtime.net", "kind": "remove", "list": "keep.platformHosts"}, {"kind": "flag", "list": "suppress.bulkHeaders.autoSubmittedCounts"}]', hint: null, message: 'Publish to one test organization first (p_pin_org): 4 change(s) would reach every organization untested' },
  invalid: { code: '22023', details: null, hint: null, message: 'Invalid rule set: thresholds.minCensusLinkedEmails: not an integer >= 0' },
  org_not_found: { code: '22023', details: null, hint: null, message: 'Organization not found' },
  pin_below_released: { code: '22023', details: null, hint: null, message: 'Cannot pin below the latest released version; roll back by publishing the old content as a new version' },
};

/** sender_rule_set_admin_content(999999): no such version. */
export const CONTENT_MISSING = null;
/** sender_rule_set_publish(...) for the canary / the release: the new version. */
export const PUBLISH_CANARY_RESULT = 2;
export const PUBLISH_RELEASE_RESULT = 3;

/**
 * sender_rule_set_admin_content(2): the canary's stored content (the bundled v1 rules plus
 * bulkHeaders Live in Learn questions, promo.example.com hidden, showingtime.net no longer kept,
 * auto-submitted mail counted), with `version` overwritten to 2 by the server.
 */
export const CONTENT_V2: SenderRuleSet = {
  "freeMailDomains": [
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "yahoo.com",
    "ymail.com",
    "rocketmail.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "pm.me",
    "gmx.com",
    "gmx.net",
    "mail.com",
    "zoho.com",
    "yandex.com",
    "fastmail.com",
    "comcast.net",
    "verizon.net",
    "att.net",
    "sbcglobal.net",
    "bellsouth.net",
    "cox.net",
    "charter.net",
    "earthlink.net"
  ],
  "keep": {
    "platformAddresses": [],
    "platformHosts": [
      "docusign.net",
      "docusign.com",
      "springcm.net",
      "showingtime.com"
    ]
  },
  "modes": {
    "approvedHost": {
      "addressPass": "live",
      "detector": "live",
      "learnQuestions": "live"
    },
    "bulkHeaders": {
      "addressPass": "off",
      "detector": "measure",
      "learnQuestions": "live"
    },
    "gmailPromotions": {
      "addressPass": "off",
      "detector": "measure",
      "learnQuestions": "measure"
    },
    "gmailSocial": {
      "addressPass": "off",
      "detector": "measure",
      "learnQuestions": "measure"
    },
    "gmailUpdates": {
      "addressPass": "off",
      "detector": "measure",
      "learnQuestions": "measure"
    },
    "localPart": {
      "addressPass": "off",
      "detector": "measure",
      "learnQuestions": "measure"
    },
    "seedAddress": {
      "addressPass": "live",
      "detector": "live",
      "learnQuestions": "live"
    }
  },
  "schema": 1,
  "suppress": {
    "bulkHeaders": {
      "anyKeyPresent": [
        "list_unsubscribe",
        "list_unsubscribe_post"
      ],
      "autoSubmittedCounts": true,
      "precedenceValues": [
        "bulk",
        "list",
        "junk"
      ]
    },
    "exactAddresses": [
      "my-saved-home@mail.zillow.com",
      "recommendations@mail.zillow.com"
    ],
    "hosts": [
      "promo.example.com"
    ],
    "localParts": []
  },
  "thresholds": {
    "minCensusLinkedEmails": 20,
    "reportMaxRows": 500,
    "reportSendIntervalHours": 24
  },
  "version": 2
};
