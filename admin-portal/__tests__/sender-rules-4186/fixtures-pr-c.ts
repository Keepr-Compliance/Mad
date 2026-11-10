/**
 * BACKLOG-4186 PR C fixtures, TRANSCRIBED from the real producers, not invented.
 *
 * Source: supabase/tests/backlog-4186/capture-pr-c.py (capture-pr-c.sql), run with kt-sql on
 * keepr-test 2026-11-10, one transaction ending in RAISE (nothing persisted). Changed from the
 * captured output, nothing else: the two fixture org ids are replaced by ORG_A / ORG_B (fixtures.ts)
 * and their names by "Test Org A/B". Errors are PostgREST's shape {code, message, details, hint}
 * (GET STACKED DIAGNOSTICS, re-keyed as in fixtures.ts).
 *
 * Captured sequence (owner): canary v2 to A -> release v3 (ends the test) -> pin B AT v3 -> canary
 * v4 to A -> STATE_MIXED -> revert_all (v5) -> STATE_REVERTED.
 */

import type { SenderRuleSet } from '@/lib/sender-rules/types';

import { ORG_A, ORG_B } from './fixtures';

/** report_my_access('sender-rules') per fixture user (owner, viewer grant, editor grant, no grant). */
export const ACCESS = {
 "editor": "editor",
 "none": null,
 "owner": "owner",
 "viewer": "viewer"
};

/** sender_rule_set_admin_state() as an analytics user with NO grant: the read refusal. */
export const READ_REFUSED = {
 "code": "42501",
 "details": null,
 "hint": null,
 "message": "Not allowed"
};

/** sender_rule_set_publish(...) as the viewer (and revert_all as the editor: identical). */
export const WRITE_REFUSED = {
 "code": "42501",
 "details": null,
 "hint": null,
 "message": "Not allowed"
};

/** sender_rule_set_admin_state() as the viewer (the editor read the same). */
export const STATE_READ_BY_VIEWER = {
 "pins": [],
 "released_version": 1,
 "truncated": false,
 "versions": [
  {
   "bundled": true,
   "canary_org": null,
   "canary_org_name": null,
   "published_at": "2026-11-07T19:36:39.82752+00:00",
   "released": true,
   "version": 1
  }
 ]
};

/** Org A tests canary v4 (newer than released v3); org B is pinned AT released v3. */
export const STATE_MIXED = {
 "pins": [
  {
   "org_id": ORG_A,
   "org_name": "Test Org A",
   "pinned_at": "2026-11-10T03:19:38.67697+00:00",
   "version": 4
  },
  {
   "org_id": ORG_B,
   "org_name": "Test Org B",
   "pinned_at": "2026-11-10T03:19:38.67697+00:00",
   "version": 3
  }
 ],
 "released_version": 3,
 "truncated": false,
 "versions": [
  {
   "bundled": false,
   "canary_org": ORG_A,
   "canary_org_name": "Test Org A",
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": false,
   "version": 4
  },
  {
   "bundled": false,
   "canary_org": null,
   "canary_org_name": null,
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": true,
   "version": 3
  },
  {
   "bundled": false,
   "canary_org": ORG_A,
   "canary_org_name": "Test Org A",
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": false,
   "version": 2
  },
  {
   "bundled": true,
   "canary_org": null,
   "canary_org_name": null,
   "published_at": "2026-11-07T19:36:39.82752+00:00",
   "released": true,
   "version": 1
  }
 ]
};

/** sender_rule_set_admin_content(3): the released content in STATE_MIXED. */
export const CONTENT_V3: SenderRuleSet = {
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
   "showingtime.com",
   "showingtime.net"
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
   "learnQuestions": "measure"
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
   "autoSubmittedCounts": false,
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
 "version": 3
};

/** sender_rule_set_admin_content(4): canary v4. */
export const CONTENT_V4: SenderRuleSet = {
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
   "showingtime.com",
   "showingtime.net"
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
   "learnQuestions": "measure"
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
   "autoSubmittedCounts": false,
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
   "promo.example.com",
   "news.example.com"
  ],
  "localParts": []
 },
 "thresholds": {
  "minCensusLinkedEmails": 20,
  "reportMaxRows": 500,
  "reportSendIntervalHours": 24
 },
 "version": 4
};

/** admin_list_organizations() as the owner, the two fixture orgs only (B is a test org). */
export const ORG_LIST = {
 "organizations": [
  {
   "created_at": "2026-11-10T03:19:38.67697+00:00",
   "id": ORG_A,
   "is_personal": false,
   "is_test": false,
   "max_seats": 5,
   "member_count": 0,
   "name": "Test Org A",
   "plan_name": null,
   "plan_tier": null,
   "slug": "p4186c-a"
  },
  {
   "created_at": "2026-11-10T03:19:38.67697+00:00",
   "id": ORG_B,
   "is_personal": false,
   "is_test": true,
   "max_seats": 5,
   "member_count": 0,
   "name": "Test Org B",
   "plan_name": null,
   "plan_tier": null,
   "slug": "p4186c-b"
  }
 ],
 "success": true
};

/** sender_rule_set_revert_all() as the owner: the new version. */
export const REVERT_RESULT = 5;

/** sender_rule_set_admin_state() after revert_all. */
export const STATE_REVERTED = {
 "pins": [],
 "released_version": 5,
 "truncated": false,
 "versions": [
  {
   "bundled": false,
   "canary_org": null,
   "canary_org_name": null,
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": true,
   "version": 5
  },
  {
   "bundled": false,
   "canary_org": ORG_A,
   "canary_org_name": "Test Org A",
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": false,
   "version": 4
  },
  {
   "bundled": false,
   "canary_org": null,
   "canary_org_name": null,
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": true,
   "version": 3
  },
  {
   "bundled": false,
   "canary_org": ORG_A,
   "canary_org_name": "Test Org A",
   "published_at": "2026-11-10T03:19:38.67697+00:00",
   "released": false,
   "version": 2
  },
  {
   "bundled": true,
   "canary_org": null,
   "canary_org_name": null,
   "published_at": "2026-11-07T19:36:39.82752+00:00",
   "released": true,
   "version": 1
  }
 ]
};

/** sender_rule_set_publish / pin answers in the sequence. */
export const PUBLISH_RESULTS = {
 "canary_1": 2,
 "canary_2": 4,
 "pin_b_at_released": "",
 "release_1": 3
};
