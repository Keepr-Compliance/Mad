/**
 * BACKLOG-4120 PR3 — renderer fixtures, TRANSCRIBED from the real producers.
 *
 * Source: the REAL learn handlers over the REAL schema.sql (the
 * learnModeHandlers-4120 harness), 2026-11-04: one synthetic deal email with
 * one not-downloaded PDF, one hand-entered transaction created before the
 * cutoff, then learn:run, sample-draw, cleanup-next, preview, sample-next,
 * score and get-state. Replies pasted as printed; only the sample row id is
 * replaced (the producer writes a random UUID). Extra questions below are
 * the same shapes with other synthetic values.
 */
import type {
  LearnCleanupNextResult,
  LearnListAnswersResult,
  LearnPreviewResult,
  LearnScoreResult,
  LearnStateResult,
} from "../../../../../electron/types/ipc/window-api-learn";

export const STATE_ON: LearnStateResult = {
  success: true,
  available: true,
  enabled: true,
  answers: { deal: 0, bulk: 0 },
};

export const CLEANUP_NEXT: LearnCleanupNextResult = {
  success: true,
  question: { detectionId: "d1", address: "4120 canarytest lane, testville, zz 00000", emailCount: 1 },
};

export const PREVIEW_CLEANUP: LearnPreviewResult = {
  success: true,
  emails: [
    {
      id: "e-00001",
      subject: "Offer accepted",
      sender: "agent@example.test",
      recipients: "me@example.test",
      sentAt: "2026-10-01T10:00:00.000Z",
      bodyHtml: '<p>Canaryhtml</p><img src="https://tracker.example.test/pixel.gif">',
      bodyPlain:
        "Canarybody: offer accepted on 4120 Canarytest Lane, Testville, ZZ 00000. Closing next month, escrow opened.",
      attachments: [
        {
          id: "att-4120-1",
          filename: "Canary purchase agreement.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1234,
          downloaded: false,
          storagePath: null,
        },
      ],
    },
  ],
  totalEmails: 1,
  questionAttachmentId: "att-4120-1",
};

export const SAMPLE_ROW_ID = "row-4120-1";

export const SCORE: LearnScoreResult = {
  success: true,
  score: {
    ruleVersion: 1,
    windowMonths: 12,
    earliestDay: "2026-10-01",
    latestDay: "2026-10-01",
    rowsScanned: 1,
    nullSentAt: 0,
    labelsWithoutLocalMail: 0,
    buckets: { manual: 1, auto: 0, hybrid: 0, rejected: 0 },
    detections: 1,
    trueDetections: 0,
    knownWrong: 0,
    matchedNeutral: 0,
    unmatched: 1,
    unmatchedDeals: 1,
    unaskable: 0,
    cleanupYes: 0,
    cleanupNo: 0,
    cleanupUnanswered: 1,
    hiddenBySeed: { keys: 0, detections: 0, emails: 0 },
    seedLinkedToDeals: 0,
    answersByRuleVersion: [],
    senderRulesVersion: 1,
    senderRulesSource: "bundled",
    senderRulesDownloadRejected: false,
    senderCensus: {
      dealLinkedSuppressed: [],
      minCensusLinkedEmails: 20,
      bulkCaught: { k: 0, n: 0, interval: null },
      realEstateSuppressed: { k: 0, n: 0, interval: null },
      foundDealsLost: { full: 0, minusContactKeeps: 0 },
      cleanupYesLost: { full: 0, minusContactKeeps: 0 },
      keptBy: { K1: 0, K2: 0, K3: 0 },
      keepConflicts: 0,
      coverage: {
        gmail: { rows: 0, headers: 0, labels: 0 },
        outlook: { rows: 0, headers: 0, labels: 0 },
        unknown: { rows: 0, headers: 0, labels: 0 },
      },
    },
    positives: 1,
    legacyManualPositives: 1,
    legacyCutoffDay: "2026-08-31",
    legacyCutoffIsMinimum: true,
    found: 0,
    missed: 1,
    recall: { k: 0, n: 1, interval: { rate: 0, low: 0, high: 79.3 } },
    recallWithCleanupYes: { k: 0, n: 1, interval: { rate: 0, low: 0, high: 79.3 } },
    recallExcludingLegacy: { k: 0, n: 0, interval: null },
    recallWithCleanupYesExcludingLegacy: { k: 0, n: 0, interval: null },
    precisionBeforeCleanup: { k: 0, n: 1, interval: { rate: 0, low: 0, high: 79.3 } },
    precisionAfterCleanup: { k: 0, n: 0, interval: null },
    side: { correct: 0, wrong: 0, notPredicted: 0, skipped: 0 },
    outcome: { scorable: 0, skipped: 0, predicted: 0 },
    bulk: {
      answered: 0,
      realEstate: 0,
      newsletterSpam: 0,
      skip: 0,
      notCached: 0,
      newsletterFlagged: { k: 0, n: 0, interval: null },
      realEstateFlagged: { k: 0, n: 0, interval: null },
    },
  },
  copyBlock:
    "Keepr Learn mode score (rules v1)\nWindow: 12 months, 2026-10-01 to 2026-10-01\nEmails scanned: 1; without a sent date: 0\nDeals in key: manual 1 (of which created before 2026-08-31, possibly auto-detected: 1 in the mail window, minimum), auto 0, hybrid 0, rejected 0; outside the mail window: 0\nDetections: 1; true 0; known wrong 0; unmatched 1 = 1 deals + 0 without a key (cleanup yes 0, no 0, unanswered 1)\nHidden by live sender rules (sender rules v1): 0 deals, 0 detections, 0 emails; seed emails linked to deals: 0\nAnswers by rules version: none\nDeals found: 0; missed: 1\nRecall: 0/1 = 0% (95% CI 0-79.3%)\nRecall with cleanup Yes: 0/1 = 0% (95% CI 0-79.3%)\nRecall without manual deals created before the cutoff: 0/0 (n/a)\nRecall with cleanup Yes, without manual deals created before the cutoff: 0/0 (n/a)\nPrecision before cleanup: 0/1 = 0% (95% CI 0-79.3%)\nPrecision after cleanup: 0/0 (n/a)\nSide: correct 0, wrong 0, not predicted 0, skipped 0\nOutcome: scorable 0, skipped 0, predicted by baseline 0 0\nBulk sample: answered 0 (real estate 0, newsletter/spam 0, skip 0, no longer cached 0)\nNewsletter/spam flagged as real estate: 0/0 (n/a)\nReal estate flagged as real estate: 0/0 (n/a)",
};

// ---- same shapes, other synthetic values -----------------------------------

export const CLEANUP_NEXT_2: LearnCleanupNextResult = {
  success: true,
  question: { detectionId: "d2", address: "77 canarytest road, testville, zz 00000", emailCount: 2 },
};

export const PREVIEW_CLEANUP_2: LearnPreviewResult = {
  success: true,
  emails: [
    {
      id: "e-00003",
      subject: "Counter offer",
      sender: "Pat Example <pat@example.test>",
      recipients: "me@example.test",
      sentAt: "2026-10-05T10:00:00.000Z",
      bodyHtml: null,
      bodyPlain: "Counter offer on 77 Canarytest Road, Testville, ZZ 00000.",
      attachments: [
        { id: "att-4120-3", filename: "Counter.pdf", mimeType: "application/pdf", sizeBytes: 900, downloaded: false, storagePath: null },
        { id: "att-4120-4", filename: "Disclosure.pdf", mimeType: "application/pdf", sizeBytes: 900, downloaded: false, storagePath: null },
      ],
    },
  ],
  totalEmails: 2,
  questionAttachmentId: "att-4120-3",
};

/** A newsletter with a tracking pixel and a CSS background (bulk question). */
export const PREVIEW_BULK: LearnPreviewResult = {
  success: true,
  emails: [
    {
      id: "e-00002",
      subject: "Canarynews weekly listings",
      sender: "Canary Listings <news@example.test>",
      recipients: "me@example.test",
      sentAt: "2026-10-02T10:00:00.000Z",
      bodyHtml:
        '<p>Canarynews</p><img src="https://tracker.example.test/open.gif"><div style="background:url(https://tracker.example.test/bg.png)">x</div>',
      bodyPlain: "Canarynews",
      attachments: [
        { id: "att-4120-5", filename: "flyer.pdf", mimeType: "application/pdf", sizeBytes: 10, downloaded: false, storagePath: null },
      ],
    },
  ],
  totalEmails: 1,
  questionAttachmentId: null,
};

export const PREVIEW_BULK_2: LearnPreviewResult = {
  success: true,
  emails: [
    {
      id: "e-00004",
      subject: "Canarynews second issue",
      sender: "news@example.test",
      recipients: "me@example.test",
      sentAt: "2026-10-03T10:00:00.000Z",
      bodyHtml: '<p>Second</p><img src="https://tracker.example.test/open2.gif">',
      bodyPlain: "Second",
      attachments: [],
    },
  ],
  totalEmails: 1,
  questionAttachmentId: null,
};

/**
 * learn:list-answers (2.46.2), TRANSCRIBED from the real handler over the real
 * schema (learnModeHandlers-4120 C13, 2026-11-06): one deal answer, one mail
 * answer, newest first. A third row shows a message no longer cached
 * (label null), the shape the LEFT JOIN produces.
 */
export const LIST_ANSWERS: LearnListAnswersResult = {
  success: true,
  answers: [
    {
      kind: "deal",
      id: "dla-c",
      label: "4120 Canarytest Lane, Testville, ZZ 00000",
      itemDate: null,
      answeredAt: "2026-11-02T00:00:00Z",
      answer: "yes",
    },
    {
      kind: "bulk",
      id: "lba-c",
      label: "Canarysubject offer",
      itemDate: "2026-10-01T10:00:00.000Z",
      answeredAt: "2026-11-01T00:00:00Z",
      answer: "real_estate",
    },
    {
      kind: "bulk",
      id: "lba-gone",
      label: null,
      itemDate: null,
      answeredAt: "2026-10-30T00:00:00Z",
      answer: "skip",
    },
  ],
};
