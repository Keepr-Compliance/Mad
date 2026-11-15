/**
 * BACKLOG-4219 PR3 fixtures, TRANSCRIBED (not invented).
 *
 * ADMIN_LIST: a real learn_pilot_report_admin_list() answer on keepr-test, recaptured after #3502
 * (user_id + user_name): supabase/tests/backlog-4219/capture-pr3.py runs the PR1 harness
 * controls.sql in one rolled-back transaction with one inserted line that records owner u1's list
 * before S11, filtered to the harness's fixture users. 6 rows, field values verbatim, except one:
 * the v2 row's version_canary_org is a real keepr-test org, replaced here by ORG_OTHER (public
 * repo). Every other id is a harness fixture id (00000000-0000-4219-8000-...). Re-run on
 * 2026-11-11: same answer apart from timestamps and that id. The six captured reports differ only
 * in the fields each row overrides, so the shared part is stored once as CAPTURED_REPORT (the
 * v4 row's report) and each row restates the fields where its own report differs.
 *
 * PR2_REPORT: the desktop builder's real output, electron/services/learn/__tests__/fixtures/
 * pilotReport-real-4219.json `.report` (written by the PR2 test), read from disk.
 */

import { readFileSync } from 'fs';
import path from 'path';

/**
 * Fixture ids, named. Every row below refers to these. All are invented harness ids (the PR1
 * harness supabase/tests/backlog-4219/controls.sql seeds them); ORG_OTHER stands in for a real
 * keepr-test org id the capture contained.
 */
export const ORG_X = '00000000-0000-4219-8000-000000000031'; // pii-allow-uuid: invented harness fixture id
export const ORG_Z = '00000000-0000-4219-8000-000000000034'; // pii-allow-uuid: invented harness fixture id
export const ORG_OTHER = '00000000-0000-4219-8000-000000000099'; // pii-allow-uuid: invented harness fixture id
export const USER_6 = '00000000-0000-4219-8000-000000000006'; // pii-allow-uuid: invented harness fixture id
export const USER_10 = '00000000-0000-4219-8000-000000000010'; // pii-allow-uuid: invented harness fixture id
export const USER_13 = '00000000-0000-4219-8000-000000000013'; // pii-allow-uuid: invented harness fixture id

export const CAPTURED_REPORT: Record<string, unknown> = {
  "answers_by_rule_version": [
    {
      "bulk": 10,
      "deal": 1,
      "rule_version": 3
    }
  ],
  "app_version": "2.47.0",
  "bulk": {
    "answered": 10,
    "newsletter_flagged": {
      "k": 1,
      "n": 5
    },
    "newsletter_spam": 5,
    "not_cached": 0,
    "real_estate": 4,
    "real_estate_flagged": {
      "k": 4,
      "n": 4
    },
    "skip": 1
  },
  "census": {
    "detector": {
      "bulk_caught": {
        "k": 3,
        "n": 10
      },
      "cleanup_yes_lost": {
        "full": 0,
        "minus": 0
      },
      "coverage": {
        "gmail": {
          "headers": 48,
          "labels": 50,
          "rows": 50
        },
        "outlook": {
          "headers": 0,
          "labels": 0,
          "rows": 0
        },
        "unknown": {
          "headers": 0,
          "labels": 0,
          "rows": 0
        }
      },
      "found_deals_lost": {
        "full": 0,
        "minus": 0
      },
      "keep_conflicts": 0,
      "kept_by": {
        "K1": 2,
        "K2": 1,
        "K3": 0
      },
      "mailboxes": [
        {
          "address_pass_ready": true,
          "detector_ready": false,
          "full": {
            "by_signal": {
              "approvedHost": 0,
              "bulkHeaders": 0,
              "gmailPromotions": 0,
              "gmailSocial": 0,
              "gmailUpdates": 0,
              "localPart": 0,
              "seedAddress": 0
            },
            "k": 0
          },
          "minus_contact_keeps": {
            "by_signal": {
              "approvedHost": 0,
              "bulkHeaders": 0,
              "gmailPromotions": 0,
              "gmailSocial": 0,
              "gmailUpdates": 0,
              "localPart": 0,
              "seedAddress": 0
            },
            "k": 0
          },
          "n": 40,
          "ordinal": 1,
          "provider": "gmail"
        }
      ],
      "min_linked_emails": 200,
      "real_estate_suppressed": {
        "k": 0,
        "n": 10
      }
    },
    "learn_questions": {
      "bulk_caught": {
        "k": 3,
        "n": 10
      },
      "cleanup_yes_lost": {
        "full": 0,
        "minus": 0
      },
      "coverage": {
        "gmail": {
          "headers": 48,
          "labels": 50,
          "rows": 50
        },
        "outlook": {
          "headers": 0,
          "labels": 0,
          "rows": 0
        },
        "unknown": {
          "headers": 0,
          "labels": 0,
          "rows": 0
        }
      },
      "found_deals_lost": {
        "full": 0,
        "minus": 0
      },
      "keep_conflicts": 0,
      "kept_by": {
        "K1": 2,
        "K2": 1,
        "K3": 0
      },
      "mailboxes": [
        {
          "address_pass_ready": false,
          "detector_ready": false,
          "full": {
            "by_signal": {
              "approvedHost": 0,
              "bulkHeaders": 1,
              "gmailPromotions": 0,
              "gmailSocial": 0,
              "gmailUpdates": 0,
              "localPart": 0,
              "seedAddress": 0
            },
            "k": 1
          },
          "minus_contact_keeps": {
            "by_signal": {
              "approvedHost": 0,
              "bulkHeaders": 1,
              "gmailPromotions": 0,
              "gmailSocial": 0,
              "gmailUpdates": 0,
              "localPart": 0,
              "seedAddress": 0
            },
            "k": 1
          },
          "n": 40,
          "ordinal": 1,
          "provider": "gmail"
        }
      ],
      "min_linked_emails": 200,
      "real_estate_suppressed": {
        "k": 0,
        "n": 10
      }
    }
  },
  "cleanup": {
    "no": 0,
    "unanswered": 0,
    "yes": 1
  },
  "deals_in_key": {
    "auto": 1,
    "hybrid": 0,
    "manual": 3,
    "rejected": 1
  },
  "detections": 4,
  "found": 2,
  "hidden_by_seed": {
    "detections": 0,
    "emails": 0,
    "keys": 0
  },
  "known_wrong": 0,
  "labels_without_local_mail": 0,
  "learn_rules_version": 3,
  "legacy_manual_positives": 1,
  "matched_neutral": 1,
  "missed": 1,
  "null_sent_at": 0,
  "outcome": {
    "predicted": 2,
    "scorable": 2,
    "skipped": 0
  },
  "positives": 3,
  "precision_after_cleanup": {
    "k": 3,
    "n": 4
  },
  "precision_before_cleanup": {
    "k": 2,
    "n": 4
  },
  "recall": {
    "k": 2,
    "n": 3
  },
  "recall_excluding_legacy": {
    "k": 1,
    "n": 2
  },
  "recall_with_cleanup_yes": {
    "k": 3,
    "n": 4
  },
  "recall_with_cleanup_yes_excluding_legacy": {
    "k": 2,
    "n": 3
  },
  "rows_scanned": 900,
  "schema": 1,
  "seed_linked_to_deals": 0,
  "sender_rules_download_rejected": false,
  "sender_rules_source": "download",
  "sender_rules_version": 4,
  "side": {
    "correct": 2,
    "not_predicted": 0,
    "skipped": 0,
    "wrong": 0
  },
  "true_detections": 2,
  "unaskable": 0,
  "unmatched": 1,
  "unmatched_deals": 1,
  "window_months": 12
};

export const ADMIN_LIST = {
  "truncated": false,
  "rows": [
    {
      "app_version": "2.47.0",
      "org_current_pin_at": "2026-11-11T18:50:02.172359+00:00",
      "org_current_pin_version": 5,
      "org_id": ORG_X,
      "org_name": "P4219 X",
      "sender_rules_version": 999999,
      "submitted_at": "2026-11-11T18:50:02.172359+00:00",
      "user_id": USER_6,
      "user_name": "P4219 user 6",
      "version_bundled": null,
      "version_canary_org": null,
      "version_published_at": null,
      "version_released": null,
      "version_was_canary_for_this_org": false,
      "report": { ...CAPTURED_REPORT, "sender_rules_version": 999999 }
    },
    {
      "app_version": "2.47.0",
      "org_current_pin_at": null,
      "org_current_pin_version": null,
      "org_id": ORG_Z,
      "org_name": "P4219 Z",
      "sender_rules_version": 5,
      "submitted_at": "2026-11-11T18:50:02.172359+00:00",
      "user_id": USER_13,
      "user_name": null,
      "version_bundled": false,
      "version_canary_org": ORG_X,
      "version_published_at": "2026-11-11T18:50:02.172359+00:00",
      "version_released": false,
      "version_was_canary_for_this_org": false,
      "report": { ...CAPTURED_REPORT, "sender_rules_version": 5 }
    },
    {
      "app_version": "2.47.0",
      "org_current_pin_at": "2026-11-11T18:50:02.172359+00:00",
      "org_current_pin_version": 5,
      "org_id": ORG_X,
      "org_name": "P4219 X",
      "sender_rules_version": 5,
      "submitted_at": "2026-11-11T18:49:02.172359+00:00",
      "user_id": USER_6,
      "user_name": "P4219 user 6",
      "version_bundled": false,
      "version_canary_org": ORG_X,
      "version_published_at": "2026-11-11T18:50:02.172359+00:00",
      "version_released": false,
      "version_was_canary_for_this_org": true,
      "report": { ...CAPTURED_REPORT, "sender_rules_version": 5 }
    },
    {
      "app_version": "2.47.0",
      "org_current_pin_at": "2026-11-11T18:50:02.172359+00:00",
      "org_current_pin_version": 5,
      "org_id": ORG_X,
      "org_name": "P4219 X",
      "sender_rules_version": 4,
      "submitted_at": "2026-11-11T18:47:02.172359+00:00",
      "user_id": USER_6,
      "user_name": "P4219 user 6",
      "version_bundled": false,
      "version_canary_org": null,
      "version_published_at": "2026-11-10T18:17:21.28396+00:00",
      "version_released": true,
      "version_was_canary_for_this_org": false,
      "report": { ...CAPTURED_REPORT }
    },
    {
      "app_version": "2.47.0",
      "org_current_pin_at": "2026-11-11T18:50:02.172359+00:00",
      "org_current_pin_version": 5,
      "org_id": ORG_X,
      "org_name": "P4219 X",
      "sender_rules_version": 1,
      "submitted_at": "2026-11-11T18:43:02.172359+00:00",
      "user_id": USER_10,
      "user_name": "Pat Ten",
      "version_bundled": true,
      "version_canary_org": null,
      "version_published_at": "2026-11-07T19:36:39.82752+00:00",
      "version_released": true,
      "version_was_canary_for_this_org": false,
      "report": { ...CAPTURED_REPORT, "detections": 7, "sender_rules_version": 1 }
    },
    {
      "app_version": "2.47.0",
      "org_current_pin_at": "2026-11-11T18:50:02.172359+00:00",
      "org_current_pin_version": 5,
      "org_id": ORG_X,
      "org_name": "P4219 X",
      "sender_rules_version": 2,
      "submitted_at": "2026-11-11T18:33:02.172359+00:00",
      "user_id": USER_10,
      "user_name": "Pat Ten",
      "version_bundled": false,
      "version_canary_org": ORG_OTHER,
      "version_published_at": "2026-11-10T18:16:07.639865+00:00",
      "version_released": false,
      "version_was_canary_for_this_org": false,
      "report": { ...CAPTURED_REPORT, "detections": 1, "sender_rules_version": 2 }
    }
  ]
};

export const PR2_REPORT: Record<string, unknown> = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../electron/services/learn/__tests__/fixtures/pilotReport-real-4219.json'), 'utf8'),
).report;

/** The 42501 the function raises for a caller without a grant (migration; S4 in the PR1 harness). */
export const LIST_REFUSED = { code: '42501', message: 'Not allowed' };
/** PostgREST's answer when the function does not exist on that database. */
export const LIST_MISSING = { code: 'PGRST202', message: 'Could not find the function public.learn_pilot_report_admin_list without parameters in the schema cache' };

/** A deep copy, so a test can change one field without touching the others. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
