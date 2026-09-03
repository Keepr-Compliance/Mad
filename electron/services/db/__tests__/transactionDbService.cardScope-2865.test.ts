/**
 * @jest-environment node
 *
 * BACKLOG-2865 — the transactions-list card's number and the Emails tab's
 * header, produced by two different code paths, put on ONE set of real rows.
 *
 * THE DEFECT. BACKLOG-2861 scoped the Emails tab header to `linkedThreads`. The
 * card's number came from a `COUNT(DISTINCT c.email_id)` subquery that still
 * counted every attached email, so on the founder's transaction the list read 9
 * over a tab reading "0 conversations (0 emails)". Fixing one surface and not
 * the other moved the disagreement one screen earlier.
 *
 * WHY A COUNT ASSERTION IS NOT ENOUGH, AND WHAT EACH FIXTURE KILLS. The rule is
 * per-THREAD ("needs review only when EVERY email in the conversation is
 * address_missing"), and several wrong implementations produce the right number
 * on a naive corpus:
 *
 *   MIXED          one thread, 1 address_found + 2 address_missing → 3.
 *                  Kills "count emails whose match_reason != address_missing",
 *                  which returns 1 and would otherwise pass every other case here.
 *   SUBJECT        thread_id NULL, "Re: fwd: Closing timeline" + "CLOSING TIMELINE"
 *                  collapsing into ONE conversation whose linked-ness is decided
 *                  by that collapse. Kills a thread_id-only approximation and any
 *                  drift in the repeated-prefix strip.
 *   PER-EMAIL KEY  an email WITH a thread_id never joins one without, even on an
 *                  identical subject. Kills a per-conversation reading of the
 *                  key precedence.
 *   N != M         5 emails in 2 conversations. This is the LABEL control: the
 *                  card number is 5, so a test that saw 2 would be watching a
 *                  thread count wear an email's name.
 *   ALL-REVIEW     the founder's live shape, 9 emails / 6 conversations → 0, AND
 *                  a non-empty review queue on the same rows, because a 0 that
 *                  meant the emails were gone would be worse than the bug.
 *
 * NOTHING IS HAND-WRITTEN WHERE A PRODUCER EXISTS. `communications` rows are
 * written by the real `linkEmailToTransaction`; the card number comes from the
 * real `getTransactions`/`getTransactionByIdSync`; the tab's two numbers come
 * from the real `getCommunicationsWithMessages` → `processEmailThreads` →
 * `threadMatchReason`, which is literally what TransactionEmailsTab.tsx:659/672
 * render. This file may import across the main/renderer boundary that the
 * production modules may not — that is what makes it a parity test.
 *
 * CONTROL C1 (see the PR body for measured numbers): point `getTransactions`
 * back at `COUNT(DISTINCT c.email_id)` and the agreement assertions go red.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import {
  createMigrationHarness,
  type MigrationHarness,
} from "../../__tests__/helpers/migrationTestHarness";
import { dbGet } from "../core/dbConnection";
import { unsafeSql } from "../core/sqlText";
import { getTransactions, getTransactionByIdSync } from "../transactionDbService";
import { getCommunicationsWithMessages } from "../communicationDbService";
import { linkEmailToTransaction } from "../../autoLinkService";
import { getReviewState } from "../../reviewStateService";
import {
  processEmailThreads,
  threadMatchReason,
} from "../../../../src/components/transactionDetailsModule/components/EmailThreadCard";
import { groupReviewItemsByThread } from "../../../../src/components/transactionDetailsModule/utils/reviewThreads";
import type { Communication } from "../../../types/models";

const USER = "u-2865";

/** The four deals, each shaped to kill a different wrong implementation. */
const T_LINKED = "t-2865-linked";
const T_MIXED = "t-2865-mixed";
const T_REVIEW = "t-2865-review";
const T_SUBJECT = "t-2865-subject";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "../../../database/schema.sql"),
  "utf8",
);

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  // Migration-only v56 columns, absent from schema.sql. Omitting them is a state
  // the app never has — same note as reviewStateService-2791/tabReachability-2861.
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-1')",
  ).run(USER, "me@agent.com");
  for (const id of [T_LINKED, T_MIXED, T_REVIEW, T_SUBJECT]) {
    db.prepare(
      "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      id,
      USER,
      `${id} St`,
      "2026-01-01T00:00:00.000Z",
      "2026-12-31T00:00:00.000Z",
    );
  }
}

let clock = 0;

/** An email row, transcribed from schema.sql. `sent_at` is monotonic so the
 *  loader's `ORDER BY e.sent_at DESC` is deterministic across runs. */
function addEmail(
  db: DatabaseType,
  id: string,
  threadId: string | null,
  subject: string | null,
): void {
  clock += 1;
  const sentAt = `2026-06-01T00:${String(clock).padStart(2, "0")}:00.000Z`;
  db.prepare(
    `INSERT INTO emails (id, user_id, thread_id, subject, sender, recipients, body_plain, sent_at, created_at)
     VALUES (?, ?, ?, ?, 'paul@example.com', 'me@agent.com', 'hello', ?, CURRENT_TIMESTAMP)`,
  ).run(id, USER, threadId, subject, sentAt);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'paul@example.com')`,
  ).run(id, `hash-${id}`);
}

type Reason = "address_found" | "address_missing" | "manual" | "user_confirmed";

/**
 * Attach one email through the REAL linker.
 *
 * `reason === null` writes a NULL `match_reason` — a legacy pre-BACKLOG-2319
 * link, which the tab treats as `address_found`. The linker's parameter is
 * typed non-null, so that one row is set directly afterwards; it is the only
 * value production cannot write today and the only one written by hand.
 */
async function attach(
  db: DatabaseType,
  emailId: string,
  txn: string,
  reason: Reason | null,
): Promise<void> {
  const outcome = await linkEmailToTransaction(
    emailId,
    txn,
    "auto",
    0.5,
    reason ?? "address_found",
  );
  expect(outcome).toBe("linked");
  if (reason === null) {
    db.prepare(
      "UPDATE communications SET match_reason = NULL WHERE email_id = ? AND transaction_id = ?",
    ).run(emailId, txn);
  }
}

/** The two numbers TransactionEmailsTab.tsx:659/672 render, from the real path. */
async function tabHeader(txn: string): Promise<{ conversations: number; emails: number }> {
  const comms = (await getCommunicationsWithMessages(txn, "email")) as Communication[];
  const linked = processEmailThreads(comms).filter(
    (t) => threadMatchReason(t) !== "needs_review",
  );
  return {
    conversations: linked.length,
    emails: linked.reduce((sum, t) => sum + t.emailCount, 0),
  };
}

/** The number the list card renders, from the real list producer. */
async function cardCount(txn: string): Promise<number> {
  const rows = await getTransactions({ user_id: USER });
  const row = rows.find((t) => t.id === txn);
  expect(row).toBeDefined();
  return row?.email_count ?? -1;
}

/** What the card showed BEFORE this item: the count that ignored the split. */
function rawEmailCount(txn: string): number {
  return (
    dbGet<{ n: number }>(
      unsafeSql(`SELECT COUNT(DISTINCT c.email_id) as n FROM communications c
        WHERE c.transaction_id = ? AND c.email_id IS NOT NULL`),
      [txn],
    )?.n ?? -1
  );
}

describe("BACKLOG-2865 — the card counts what the Emails tab describes", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(async () => {
    clock = 0;
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);

    // T_LINKED — 5 emails in 2 conversations, nothing in review.
    // The unit control: 5 != 2, so an email count and a thread count are
    // distinguishable here and nowhere a single-email fixture could tell them apart.
    for (const id of ["L-1a", "L-1b", "L-1c"]) {
      addEmail(db, id, "th-L1", "Inspection scheduling");
      await attach(db, id, T_LINKED, "address_found");
    }
    addEmail(db, "L-2a", "th-L2", "Appraisal");
    await attach(db, "L-2a", T_LINKED, "manual");
    addEmail(db, "L-2b", "th-L2", "Re: Appraisal");
    await attach(db, "L-2b", T_LINKED, "user_confirmed");

    // T_MIXED — one MIXED conversation (linked, all 3 counted) plus one wholly
    // in review (2 excluded).
    addEmail(db, "M-1a", "th-M1", "Closing docs");
    await attach(db, "M-1a", T_MIXED, "address_found");
    addEmail(db, "M-1b", "th-M1", "Re: Closing docs");
    await attach(db, "M-1b", T_MIXED, "address_missing");
    addEmail(db, "M-1c", "th-M1", "Re: Closing docs");
    await attach(db, "M-1c", T_MIXED, "address_missing");
    for (const id of ["M-2a", "M-2b"]) {
      addEmail(db, id, "th-M2", "Unrelated chatter");
      await attach(db, id, T_MIXED, "address_missing");
    }

    // T_REVIEW — the founder's transaction: 9 emails, 6 conversations, every one
    // address_missing.
    const review: Array<[string, string[]]> = [
      ["th-R1", ["R-1a", "R-1b"]],
      ["th-R2", ["R-2a", "R-2b"]],
      ["th-R3", ["R-3a", "R-3b"]],
      ["th-R4", ["R-4"]],
      ["th-R5", ["R-5"]],
      ["th-R6", ["R-6"]],
    ];
    for (const [thread, ids] of review) {
      for (const id of ids) {
        addEmail(db, id, thread, `Subject ${id}`);
        await attach(db, id, T_REVIEW, "address_missing");
      }
    }

    // T_SUBJECT — the grouping fallbacks.
    //   S-1 + S-2 share a normalized subject and NO thread_id → ONE conversation.
    //     S-1 is address_missing, S-2 is not, so the collapse is what makes both
    //     count. Split them and S-1 disappears.
    addEmail(db, "S-1", null, "Re: fwd: Closing timeline");
    await attach(db, "S-1", T_SUBJECT, "address_missing");
    addEmail(db, "S-2", null, "  CLOSING TIMELINE  ");
    await attach(db, "S-2", T_SUBJECT, "address_found");
    //   S-3 carries a thread_id on the SAME subject → a SEPARATE conversation,
    //     wholly in review, excluded. Key precedence is per email.
    addEmail(db, "S-3", "th-S3", "Closing timeline");
    await attach(db, "S-3", T_SUBJECT, "address_missing");
    //   S-4 has no thread_id and an empty subject → keyed on its own id.
    addEmail(db, "S-4", null, "");
    await attach(db, "S-4", T_SUBJECT, "address_missing");
    //   S-5 is a legacy link: NULL match_reason → address_found → linked.
    addEmail(db, "S-5", null, null);
    await attach(db, "S-5", T_SUBJECT, null);
  });

  afterEach(async () => {
    try {
      await harness.cleanup();
    } catch {
      /* already cleaned */
    }
  });

  describe("the card and the tab agree, on the same rows", () => {
    it.each([
      ["all linked", T_LINKED],
      ["mixed", T_MIXED],
      ["all needs-review", T_REVIEW],
      ["subject-fallback grouping", T_SUBJECT],
    ])("%s", async (_name, txn) => {
      const tab = await tabHeader(txn);
      const card = await cardCount(txn);

      // THE ASSERTION THIS ITEM EXISTS FOR. Not "both are plausible" — the same
      // integer, against the tab's email figure.
      expect(card).toBe(tab.emails);
    });

    it("holds for getTransactionByIdSync too — the producer getOverview returns", async () => {
      // TransactionDetails re-reads email_count from getOverview after every
      // auto-sync (BACKLOG-2838). Scoping only the list producer would show the
      // right number on load and the wrong one after the first refresh.
      for (const txn of [T_LINKED, T_MIXED, T_REVIEW, T_SUBJECT]) {
        const tab = await tabHeader(txn);
        expect(getTransactionByIdSync(txn)?.email_count).toBe(tab.emails);
      }
    });
  });

  describe("the numbers themselves, named", () => {
    it("all-linked: 5 emails in 2 conversations — the card shows 5, not 2", async () => {
      const tab = await tabHeader(T_LINKED);
      expect(tab).toEqual({ conversations: 2, emails: 5 });

      // The LABEL control. `email_count` is a count of EMAILS (BACKLOG-2838
      // ruled on this field's unit), so the card must read 5. A card reading 2
      // would be a thread count under an envelope, which is the older half of
      // this item's report. The two numbers differ here on purpose — on a
      // one-email-per-thread fixture this assertion proves nothing.
      expect(await cardCount(T_LINKED)).toBe(5);
      expect(tab.conversations).not.toBe(tab.emails);
    });

    it("mixed: a conversation with ONE non-missing email counts ALL of its emails", async () => {
      // 3 from the mixed conversation, 0 from the wholly-missing one.
      expect(await cardCount(T_MIXED)).toBe(3);
      expect(await tabHeader(T_MIXED)).toEqual({ conversations: 1, emails: 3 });

      // The per-email shortcut would return 1 here (only M-1a is not
      // address_missing) and would pass every other case in this file.
      const notMissing = dbGet<{ n: number }>(
        unsafeSql(`SELECT COUNT(*) as n FROM communications
          WHERE transaction_id = ? AND email_id IS NOT NULL
            AND COALESCE(match_reason, 'address_found') != 'address_missing'`),
        [T_MIXED],
      )?.n;
      expect(notMissing).toBe(1);
      expect(await cardCount(T_MIXED)).not.toBe(notMissing);
    });

    it("all needs-review: the card reads 0 — the founder's live state", async () => {
      expect(await cardCount(T_REVIEW)).toBe(0);
      expect(await tabHeader(T_REVIEW)).toEqual({ conversations: 0, emails: 0 });

      // And what it used to read, on these same rows.
      expect(rawEmailCount(T_REVIEW)).toBe(9);
    });

    it("subject fallback: normalized-subject collapse decides the count", async () => {
      // S-1 + S-2 (one conversation, linked) = 2, plus S-5 (legacy NULL) = 1.
      // S-3 (own thread, missing) and S-4 (own key, missing) are excluded.
      expect(await cardCount(T_SUBJECT)).toBe(3);
      expect(await tabHeader(T_SUBJECT)).toEqual({ conversations: 2, emails: 3 });
      expect(rawEmailCount(T_SUBJECT)).toBe(5);
    });
  });

  describe("a 0 on the card does not mean the emails are gone", () => {
    it("all nine stay in the review queue, and the Needs Review button renders", () => {
      // The condition BACKLOG-2861 made part of its deliverable, re-asserted for
      // the card: scoping a count is only a display fix while the excluded mail
      // is still reachable. If this ever fails, the founder's deal reads 0 on the
      // list, 0 in the tab, and has nine emails openable by nothing.
      const state = getReviewState(T_REVIEW);
      expect(state.items).toHaveLength(9);
      expect(groupReviewItemsByThread(state.items)).toHaveLength(6);
    });
  });

  describe("the submit summary is unaffected, by construction", () => {
    it("scoped == raw on a deal whose review queue is empty", async () => {
      // SubmitForReviewModal renders this same field as "Emails: N". It can only
      // open through useCompleteTransaction, which re-reads the queue at click
      // time and has NO bypass — so it never sees a deal with an address_missing
      // row, and on such a deal the two counts coincide. This pins that rather
      // than assuming it: if the scoping ever starts excluding something the
      // queue does not know about, the submit number silently under-reports what
      // is exported and this goes red.
      expect(getReviewState(T_LINKED).items).toHaveLength(0);
      expect(await cardCount(T_LINKED)).toBe(rawEmailCount(T_LINKED));

      // ...and on the deals the gate WOULD block, the two genuinely differ, so
      // the assertion above is not vacuous.
      expect(await cardCount(T_MIXED)).not.toBe(rawEmailCount(T_MIXED));
      expect(await cardCount(T_REVIEW)).not.toBe(rawEmailCount(T_REVIEW));
    });
  });

  describe("the INNER JOIN is inert today, and why", () => {
    it("the schema forbids the only shape LEFT vs INNER could disagree on", async () => {
      // The row fetch INNER JOINs `emails`, mirroring getCommunicationsWithMessages
      // (which derives channel from that join, so a dangling email_id arrives as
      // channel 'unknown' and processEmailThreads drops it).
      //
      // I first wrote this as a control asserting the old COUNT(DISTINCT c.email_id)
      // over-counted such a row. It does not, because the row cannot exist: the
      // FK is enforced (databaseService.ts:360 sets foreign_keys=ON) and carries
      // ON DELETE CASCADE, so deleting an email takes its link with it. Asserting
      // the over-count would have described a state the app cannot emit.
      //
      // What is true is asserted instead: the join choice is faithful to the
      // loader AND currently unobservable. If the FK is ever dropped, this goes
      // red and the assumption gets re-examined rather than silently inherited.
      expect(() =>
        db
          .prepare(
            `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source, match_reason)
             VALUES ('c-dangling', ?, ?, 'e-does-not-exist', 'auto', 'address_found')`,
          )
          .run(USER, T_LINKED),
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Unchanged by the attempt.
      expect(await cardCount(T_LINKED)).toBe(5);
      expect(rawEmailCount(T_LINKED)).toBe(5);
    });
  });
});
