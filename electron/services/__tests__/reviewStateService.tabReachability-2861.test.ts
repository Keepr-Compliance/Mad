/**
 * @jest-environment node
 *
 * BACKLOG-2861 — the condition that makes Option A a display fix rather than a
 * silent drop, proved against the REAL schema on the REAL SQLite driver.
 *
 * THE SETUP. The Emails-tab header now counts only `linkedThreads`, which
 * excludes every needs-review conversation. On the founder's transaction that
 * means "0 conversations (0 emails)" over an empty list — accepted by him, but
 * ONLY because the nine emails behind it stay reachable through the Needs Review
 * button. If that button could be hidden while the tab is holding needs-review
 * threads, the same nine emails would be counted by nothing, listed by nothing
 * and openable by nothing: strictly worse than the bug being fixed.
 *
 * THE HAZARD. Two independent definitions of "needs review" decide those two
 * things, and they are written in different languages against different shapes:
 *
 *   renderer  `threadMatchReason` (EmailThreadCard.tsx)  — per-THREAD, needs
 *             review when EVERY email in it is `address_missing`
 *   service   `getReviewState` legacy population          — per-EMAIL,
 *             `communications WHERE transaction_id = ? AND email_id IS NOT NULL
 *              AND match_reason = 'address_missing'`
 *
 * The founder's one-source rule is quoted at reviewStateService.ts:589. Two
 * sources remain here on purpose (reasoned out on the item: the service set
 * includes PENDING rows that have no `communications` row at all, so the tab
 * structurally cannot mirror it, and deriving the tab split from the async
 * queue would flash needs-review threads into the Linked list on every open).
 * What this file does instead is put BOTH definitions on ONE set of rows and
 * pin the only implication that can hurt anyone:
 *
 *     a needs-review thread on the tab  ⟹  a non-empty review queue
 *
 * The converse is deliberately NOT asserted, and asserting it would be a bug: a
 * PENDING item is not linked, so it correctly has no `communications` row and is
 * correctly absent from the tab while still showing on the button.
 *
 * NOTHING HERE IS HAND-WRITTEN WHERE A PRODUCER EXISTS. Rows are written by the
 * real `linkEmailToTransaction`, read back by the real
 * `getCommunicationsWithMessages` — the query the Emails tab is actually fed —
 * grouped by the real `processEmailThreads`, classified by the real
 * `threadMatchReason`, and counted by the real `groupReviewItemsByThread` (the
 * function `useReviewQueue` derives the badge from). A fixture standing in for
 * any of those would be describing a state the app may not be able to emit.
 *
 * CONTROLS, and the mutations measured against them — see the PR body for the
 * numbers:
 *   C4  revert the legacy-population union in getReviewState → the reachability
 *       assertions go red while the tab still holds six needs-review threads.
 *   C5  the force-re-cache regression, transcribed from emailForceStaging.ts.
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
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import { getReviewState, queueEmailForReview } from "../reviewStateService";
import { linkEmailToTransaction } from "../autoLinkService";
import { getCommunicationsWithMessages } from "../db/communicationDbService";
import {
  processEmailThreads,
  threadMatchReason,
} from "../../../src/components/transactionDetailsModule/components/EmailThreadCard";
import { groupReviewItemsByThread } from "../../../src/components/transactionDetailsModule/utils/reviewThreads";
import type { ReviewItemDto } from "../../types/ipc/window-api-transactions";
import type { Communication } from "../../types/models";

const USER = "u-2861";
const TXN = "t-2861";

const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  // Migration-only v56 columns, absent from schema.sql — omitting them is a
  // state the app never has (see reviewStateService-2791.test.ts).
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE transaction_contacts ADD COLUMN removed_reason TEXT;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_at DATETIME;");
  db.exec("ALTER TABLE contacts ADD COLUMN removed_reason TEXT;");
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-1')",
  ).run(USER, "me@agent.com");
  db.prepare(
    "INSERT INTO transactions (id, user_id, property_address, started_at, closed_at) VALUES (?, ?, ?, ?, ?)",
  ).run(TXN, USER, "1 Test St", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
}

/** An email row + its `from` participant, transcribed from schema.sql. */
function addEmail(db: DatabaseType, id: string, threadId: string, subject: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, thread_id, subject, sender, recipients, body_plain, sent_at, created_at)
     VALUES (?, ?, ?, ?, 'paul@example.com', 'me@agent.com', 'hello', ?, CURRENT_TIMESTAMP)`,
  ).run(id, USER, threadId, subject, sentAt);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, 'paul@example.com')`,
  ).run(id, `hash-${id}`);
}

/**
 * The founder's transaction: SIX conversations, NINE emails, every one of them
 * `address_missing` — the state auto-link leaves behind when the mail names no
 * property address. Written through the real linker so the `communications`
 * rows are the rows production writes.
 */
const CONVERSATIONS: Array<[thread: string, emails: string[]]> = [
  ["th-1", ["e-1a", "e-1b"]],
  ["th-2", ["e-2a", "e-2b"]],
  ["th-3", ["e-3a", "e-3b"]],
  ["th-4", ["e-4"]],
  ["th-5", ["e-5"]],
  ["th-6", ["e-6"]],
];

async function attachAllAsAddressMissing(db: DatabaseType, suffix = ""): Promise<string[]> {
  const created: string[] = [];
  let n = 0;
  for (const [thread, emails] of CONVERSATIONS) {
    for (const e of emails) {
      const id = `${e}${suffix}`;
      addEmail(db, id, `${thread}${suffix}`, `Subject ${e}`, `2026-06-${String(++n).padStart(2, "0")}T00:00:00.000Z`);
      const outcome = await linkEmailToTransaction(id, TXN, "auto", 0.5, "address_missing");
      expect(outcome).toBe("linked");
      created.push(id);
    }
  }
  return created;
}

/** Exactly what the Emails tab is fed: the real loader, the real channel filter. */
async function loadTabEmails(): Promise<Communication[]> {
  return (await getCommunicationsWithMessages(TXN, "email")) as Communication[];
}

/** The email ids the tab would hold BACK from its Linked list. */
function tabNeedsReviewEmailIds(comms: Communication[]): Set<string> {
  return new Set(
    processEmailThreads(comms)
      .filter((t) => threadMatchReason(t) === "needs_review")
      .flatMap((t) => t.emails.map((e) => (e as Communication).email_id as string)),
  );
}

function reviewEmailIds(items: ReviewItemDto[]): Set<string> {
  return new Set(items.map((i) => i.email_id).filter((id): id is string => id != null));
}

describe("BACKLOG-2861 — the tab's needs-review set is reachable from the button", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);
  });

  afterEach(async () => {
    try {
      await harness.cleanup();
    } catch {
      /* already cleaned */
    }
  });

  describe("C4 — both definitions, one set of rows", () => {
    it("every email the tab holds back is in the review queue, by ID SET", async () => {
      const created = await attachAllAsAddressMissing(db);
      expect(created).toHaveLength(9);

      const comms = await loadTabEmails();
      // The loader returned the founder's shape: 9 emails in 6 conversations.
      expect(comms).toHaveLength(9);
      expect(processEmailThreads(comms)).toHaveLength(6);

      const heldBack = tabNeedsReviewEmailIds(comms);
      // All six conversations are needs-review, so the Linked list is empty and
      // the header now reads 0/0 — the state the founder accepted.
      expect(heldBack).toEqual(new Set(created));

      const state = getReviewState(TXN);
      const reachable = reviewEmailIds(state.items);

      // THE IMPLICATION. Named individually so a failure says WHICH email fell
      // through, rather than that two numbers differ — a count assertion is
      // exactly what failed to catch the original defect.
      const dropped = [...heldBack].filter((id) => !reachable.has(id));
      expect(dropped).toEqual([]);

      // ...and therefore the button is rendered. `TransactionHeader` shows it at
      // `reviewCount > 0`, where reviewCount is this exact derivation.
      expect(groupReviewItemsByThread(state.items).length).toBeGreaterThan(0);
      expect(groupReviewItemsByThread(state.items)).toHaveLength(6);
    });

    it("a MIXED thread stays linked and its address_missing email is still reachable", async () => {
      // The one shape where the per-THREAD and per-EMAIL rules genuinely differ.
      // The thread is Linked (not every email is missing), so the tab renders it
      // AND the service still lists the ambiguous email. That double-surface is
      // existing behaviour; what matters is that nothing falls out of the union.
      addEmail(db, "e-mix-a", "th-mix", "Closing timeline", "2026-06-01T00:00:00.000Z");
      addEmail(db, "e-mix-b", "th-mix", "Re: Closing timeline", "2026-06-02T00:00:00.000Z");
      await linkEmailToTransaction("e-mix-a", TXN, "auto", 0.5, "address_missing");
      await linkEmailToTransaction("e-mix-b", TXN, "auto", 0.85, "address_found");

      const comms = await loadTabEmails();
      const threads = processEmailThreads(comms);
      expect(threads).toHaveLength(1);
      expect(threadMatchReason(threads[0])).toBe("linked");

      // Held back: nothing. Rendered: both emails.
      expect(tabNeedsReviewEmailIds(comms)).toEqual(new Set());

      // The ambiguous half is nonetheless in the queue — so the union covers
      // every attached email and the disjointness that does NOT hold is not
      // asserted anywhere.
      expect(reviewEmailIds(getReviewState(TXN).items)).toEqual(new Set(["e-mix-a"]));
    });

    it("closes the predicate gap: a NULL email_id row cannot reach the tab as an email", async () => {
      // getReviewState's legacy population requires `email_id IS NOT NULL`;
      // threadMatchReason requires nothing of the kind. If a row could carry
      // match_reason='address_missing' with a NULL email_id it would be
      // needs-review to the renderer and INVISIBLE to the service — a real
      // silent drop, and the reason this gap was checked before Option A was
      // built rather than after.
      //
      // It is not producible, and the closure is at the LOADER, not merely at
      // the write paths: `getCommunicationsWithMessages` derives channel='email'
      // only from the `emails` join, which itself requires a non-NULL email_id.
      db.prepare(
        `INSERT INTO communications (id, user_id, transaction_id, thread_id, link_source, link_confidence, match_reason)
         VALUES ('c-null', ?, ?, 'th-orphan', 'auto', 0.5, 'address_missing')`,
      ).run(USER, TXN);

      // The tab's own fetch (channelFilter 'email') excludes it in SQL.
      expect(await loadTabEmails()).toHaveLength(0);

      // And on an UNFILTERED load it is still not an email: no emails row joined,
      // no messages row joined, so the projected channel is 'unknown' and
      // processEmailThreads' isEmailMessage check drops it.
      const unfiltered = (await getCommunicationsWithMessages(TXN)) as Communication[];
      expect(unfiltered).toHaveLength(1);
      expect((unfiltered[0] as { channel?: string }).channel).toBe("unknown");
      expect(processEmailThreads(unfiltered)).toHaveLength(0);
      expect(tabNeedsReviewEmailIds(unfiltered)).toEqual(new Set());
    });
  });

  describe("C5 — regression guard for the trigger (force re-cache)", () => {
    it("cascades BOTH link tables, then survives reinsert under NEW email ids", async () => {
      // TRANSCRIBED from emailForceStaging.ts, not invented:
      //   `deleteLiveForceSet` is a plain `DELETE FROM emails WHERE <forceSet>`,
      //   and its own comment names the consequence — "every ON DELETE CASCADE
      //   fires: the participants junction, attachments, and the three link
      //   tables (transaction links, plus their ignored and pending-review
      //   siblings)". schema.sql:1327 and :1470 are those cascades.
      //   `insertFromStaging` then re-inserts the rebuilt rows, which carry NEW
      //   ids. The founder's run reported emailsDeleted 490, emailsInserted 487.
      //
      // So the true post-swap state is: emails present under NEW ids, NO
      // communications rows, NO pending_review_communications rows. Auto-link
      // re-attaches them afterwards as address_missing — which is the state he
      // was looking at when he filed this.
      const first = await attachAllAsAddressMissing(db);

      // A PENDING row as well, and this is load-bearing rather than decoration.
      //
      // BACKLOG-2861 SR review: the first cut of this guard asserted that
      // `pending_review_communications` was empty after the delete, over a table
      // that NO line in the fixture ever wrote to. It read as proof that the
      // pending-review cascade fires; it was a count that was already zero, and
      // it could not have gone red for any reason. The `communications` half was
      // genuinely discriminating; this half was not, and the summary claimed
      // both. Written through the real `queueEmailForReview`, not a hand-rolled
      // INSERT, so the row is the row production queues.
      //
      // A TENTH email, deliberately NOT linked: that is what a pending item IS
      // (queued without a `communications` row), and it keeps the pending row
      // out of getReviewState's email_id dedup, where the pending twin would win
      // and mask the legacy row this file is really about.
      addEmail(db, "e-pending", "th-pending", "Queued, never linked", "2026-06-20T00:00:00.000Z");
      expect(await queueEmailForReview(TXN, "e-pending", USER)).toBe(true);

      // PRECONDITION, asserted before the mutation rather than after it. Without
      // this line the post-delete assertion below is indistinguishable from a
      // table that was empty all along — which is exactly the defect being fixed.
      const pendingBefore = db
        .prepare("SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?")
        .get(TXN) as { n: number };
      expect(pendingBefore.n).toBe(1);

      // 9 linked + 1 pending. The pending one is NOT on the tab and correctly
      // never was — the converse implication this suite deliberately does not
      // assert.
      expect(getReviewState(TXN).items).toHaveLength(10);
      expect(tabNeedsReviewEmailIds(await loadTabEmails())).toEqual(new Set(first));

      db.pragma("foreign_keys = ON");
      const deleted = db.prepare("DELETE FROM emails WHERE user_id = ?").run(USER).changes;
      expect(deleted).toBe(10);

      // Both cascades really fired — asserted, not assumed, and both halves can
      // now go red. This is the step the incident report attributed the
      // disappearance to.
      const linksLeft = db
        .prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?")
        .get(TXN) as { n: number };
      expect(linksLeft.n).toBe(0);
      const pendingLeft = db
        .prepare("SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?")
        .get(TXN) as { n: number };
      expect(pendingLeft.n).toBe(0);
      expect(getReviewState(TXN).items).toHaveLength(0);

      // Re-insert under NEW ids and let auto-link re-attach, exactly as happened.
      const second = await attachAllAsAddressMissing(db, "-v2");
      expect(second.some((id) => first.includes(id))).toBe(false);

      // No pending rows came BACK — the cascade took the queued one and nothing
      // rebuilt it, so everything asserted below is purely the legacy
      // population's work. Meaningful now that a pending row demonstrably
      // existed a few lines above.
      const stillNoPending = db
        .prepare("SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?")
        .get(TXN) as { n: number };
      expect(stillNoPending.n).toBe(0);

      const comms = await loadTabEmails();
      expect(comms).toHaveLength(9);

      const heldBack = tabNeedsReviewEmailIds(comms);
      expect(heldBack).toEqual(new Set(second));

      const state = getReviewState(TXN);
      const dropped = [...heldBack].filter((id) => !reviewEmailIds(state.items).has(id));
      expect(dropped).toEqual([]);
      expect(groupReviewItemsByThread(state.items)).toHaveLength(6);
    });
  });
});
