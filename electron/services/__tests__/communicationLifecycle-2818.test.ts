/**
 * @jest-environment node
 *
 * BACKLOG-2818 — THE PUBLISHED LIFECYCLE, ENFORCED.
 *
 * BACKLOG-2791 wrote the Communication Lifecycle Contract (three states, seven
 * transitions, two invariants) and reviewTransitions-2791 pins the BEHAVIOUR of
 * each move. Neither pinned the DEFINITION: the states were implicit in table
 * membership and the restore discriminator was a raw literal, so the contract
 * page and the code could drift apart without a single test noticing.
 *
 * This suite closes that gap in three places:
 *
 *   1. THE DISCRIMINATOR IS A PERSISTED-DATA CONTRACT. `REVIEW_REJECTION_REASON`
 *      is pinned against the raw literal, and a shipped-style row written with
 *      the raw literal is shown to still be recognised. Change the constant and
 *      these go red together with the fixtures in reviewTransitions-2791 and
 *      reviewStateService.textSideDoor-2791.
 *
 *   2. THE STATES ARE SWITCHED WITH A NEVER-CHECK, so a fourth state cannot be
 *      added without every switch failing to compile.
 *
 *   3. THE TRANSITION TABLE IS COMPARED TO REALITY, derived by EXECUTION: the
 *      real operations are driven against a real sqlite database, the from->to
 *      pair of every observed move is collected, and the result is compared to
 *      `LIFECYCLE_TRANSITIONS` as SETS IN BOTH DIRECTIONS. A pair the code
 *      performs that is missing from the table is code drift; a published row no
 *      operation performs is contract drift. Neither passes silently.
 *
 * WHY STATE IS DERIVED AT CONTRACT LEVEL, NOT FROM WHICH TABLE A ROW IS IN
 * -----------------------------------------------------------------------
 * A legacy BACKLOG-2319 item is physically a `communications` row — LINKED, by
 * table — and yet SUGGESTED by the contract, which is why `getReviewState()`
 * unions it in. Approving one flips `match_reason` and moves no row at all, so a
 * store-membership derivation would read it as linked->linked: a pair in no
 * published row, which would red this suite for a transition the contract
 * describes perfectly well as T3. So SUGGESTED is `getReviewState()` membership
 * (both origins), LINKED is a `communications` row that is NOT in that set, and
 * REMOVED is the join "Show removed" itself uses.
 *
 * CONTROLS RUN — see the PR body for measured counts.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/m") },
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(), setUser: jest.fn(), addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn().mockResolvedValue(undefined), debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined), error: jest.fn().mockResolvedValue(undefined) };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = { initialize: jest.fn().mockResolvedValue(undefined), getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false), getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}) };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({ queryContacts: jest.fn(), isPoolReady: jest.fn(() => false) }));
// Provider/network services, mocked only so transactionService can be imported —
// T5 and T7 live on it and are driven for real below.
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import {
  getReviewState,
  countReviewItems,
  syncReviewQueueForTransaction,
  approveReviewItems,
  rejectReviewItems,
  restoreRejectedToQueue,
} from "../reviewStateService";
import { linkEmailToTransaction } from "../autoLinkService";
import transactionService from "../transactionService";
import {
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  PUBLISHED_TRANSITION_KEYS,
  REVIEW_REJECTION_REASON,
  assertNeverLifecycleState,
  blocksComplete,
  lifecycleTransitionKey,
  transitionsFor,
  type CommunicationLifecycleState,
  type LifecycleFrom,
} from "../../types/ipc/communicationLifecycle";

const U = "u-lc", T = "t-lc", C = "c-lc", PROPERTY = "3414 Sapp Rd SW";
const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

/** The exact join "Show removed" uses (transactions:get-removed-emails). */
const REMOVED_SQL = `
  SELECT DISTINCT e.id AS email_id FROM ignored_communications ic
  JOIN emails e ON ((ic.email_id IS NOT NULL AND ic.email_id = e.id)
    OR (ic.original_communication_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM communications c WHERE c.id = ic.original_communication_id AND c.email_id = e.id)))
  WHERE ic.transaction_id = ? ORDER BY e.id`;

let h: MigrationHarness;
let db: DatabaseType;

/* ------------------------------------------------------------------ *
 * State derivation — contract level, with the never-check on it
 * ------------------------------------------------------------------ */

/** SUGGESTED: the ONE read path, which unions the pending and legacy origins. */
const suggestedIds = (): string[] =>
  getReviewState(T)
    .items.map((i) => i.email_id)
    .filter((id): id is string => !!id);

/** LINKED: a `communications` row that getReviewState does NOT claim. */
const linkedIds = (): string[] => {
  const flagged = new Set(suggestedIds());
  return (
    db
      .prepare(
        "SELECT email_id FROM communications WHERE transaction_id=? AND email_id IS NOT NULL",
      )
      .all(T) as Array<{ email_id: string }>
  )
    .map((r) => r.email_id)
    .filter((id) => !flagged.has(id));
};

/** REMOVED: what "Show removed" renders. */
const removedIds = (): string[] =>
  (db.prepare(REMOVED_SQL).all(T) as Array<{ email_id: string }>).map((r) => r.email_id);

/**
 * THE NEVER-CHECK THAT MATTERS.
 *
 * Every state must say how it is observed. Add a fourth to the union and this
 * `default` is a compile error naming it — which is the enforcement the founder
 * asked for, applied to the one function that would otherwise silently return
 * an empty set for the new state and let every assertion below pass.
 */
function membersOf(state: CommunicationLifecycleState): string[] {
  switch (state) {
    case "suggested":
      return suggestedIds();
    case "linked":
      return linkedIds();
    case "removed":
      return removedIds();
    default:
      return assertNeverLifecycleState(state);
  }
}

type Snapshot = Record<CommunicationLifecycleState, string[]>;

/** Built by iterating the published tuple, so a new state is snapshotted too. */
function snapshot(): Snapshot {
  const out = {} as Snapshot;
  for (const state of LIFECYCLE_STATES) out[state] = membersOf(state);
  return out;
}

/** Where does this email live? `"new"` = in none of the three homes yet. */
function stateOf(snap: Snapshot, emailId: string): LifecycleFrom {
  for (const state of LIFECYCLE_STATES) {
    if (snap[state].includes(emailId)) return state;
  }
  return "new";
}

/* ------------------------------------------------------------------ *
 * Fixture
 * ------------------------------------------------------------------ */

function addEmail(id: string, body: string, threadId: string | null = null): void {
  db.prepare(
    `INSERT INTO emails (id,user_id,subject,sender,body_plain,sent_at,created_at,thread_id)
     VALUES (?,?,?, 'jane@example.com', ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP, ?)`,
  ).run(id, U, `S ${id}`, body, threadId);
  db.prepare(
    `INSERT INTO email_participants (email_id,role,position,participant_hash,email_address)
     VALUES (?, 'from', 0, ?, 'jane@example.com')`,
  ).run(id, `h-${id}`);
}

beforeEach(() => {
  h = createMigrationHarness({ seedV29Schema: false });
  db = h.db;
  db.exec(SCHEMA);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS i1 ON pending_review_communications(transaction_id,email_id) WHERE email_id IS NOT NULL;`,
  );
  // v56 tombstone columns: declared on neither table in schema.sql, so a
  // schema.sql-only fixture is a state the app never has and autoLinkService's
  // candidate count throws "no such column" into its own swallowing catch.
  for (const t of ["transaction_contacts", "contacts"]) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN removed_at DATETIME;`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN removed_reason TEXT;`);
  }
  db.prepare("INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,'google','o')").run(U, "me@a.com");
  db.prepare("INSERT INTO transactions (id,user_id,property_address,started_at,closed_at) VALUES (?,?,?,?,?)")
    .run(T, U, PROPERTY, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id,user_id,display_name) VALUES (?,?,?)").run(C, U, "Jane Seller");
  db.prepare("INSERT INTO contact_emails (id,contact_id,email) VALUES ('ce',?,?)").run(C, "jane@example.com");
  db.prepare("INSERT INTO transaction_contacts (id,transaction_id,contact_id) VALUES ('tc',?,?)").run(T, C);
});
afterEach(async () => { try { await h.cleanup(); } catch { /* cleaned */ } });

/* ------------------------------------------------------------------ *
 * 1. The discriminator
 * ------------------------------------------------------------------ */

describe("REVIEW_REJECTION_REASON is a persisted-data contract", () => {
  it("still spells the value that is already on users' disks", () => {
    // THE RAW LITERAL IS DELIBERATE — NOT the constant.
    //
    // Every other site in the codebase now imports the constant, so a changed
    // constant would move read and write together and no behavioural test could
    // see it. This assertion is the anchor that makes the mutation control fire:
    // the value is written into `ignored_communications.reason` by shipped
    // builds and cannot be renamed without a migration.
    expect(REVIEW_REJECTION_REASON).toBe("rejected_in_review");
  });

  it("recognises a rejection row written by a SHIPPED build, spelled out longhand", async () => {
    addEmail("e-shipped", "Are you free Thursday?");
    // RAW LITERAL ON PURPOSE — this row stands in for one already on disk,
    // written before the constant existed. Restore must still route it back to
    // the queue rather than re-linking it as an ordinary removal.
    db.prepare(
      `INSERT INTO ignored_communications (id,user_id,transaction_id,email_id,reason,match_reason)
       VALUES ('ig-shipped',?,?,'e-shipped','rejected_in_review','address_missing')`,
    ).run(U, T);

    expect(await restoreRejectedToQueue("ig-shipped")).toBe(1);
    expect(suggestedIds()).toEqual(["e-shipped"]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The states
 * ------------------------------------------------------------------ */

describe("the published states", () => {
  it("blocksComplete matches what the Complete gate actually counts", async () => {
    // The gate reads countReviewItems(). Pin the published predicate against it
    // rather than against a second copy of the rule.
    addEmail("e-miss", "Are you free Thursday?");
    addEmail("e-match", `Docs for ${PROPERTY} attached.`);
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });

    const snap = snapshot();
    expect(snap.suggested).toEqual(["e-miss"]);
    expect(snap.linked).toEqual(["e-match"]);

    // SUGGESTED holds the gate open...
    expect(blocksComplete("suggested")).toBe(true);
    expect(countReviewItems(T)).toBeGreaterThan(0);

    // ...and nothing else does: approve the only suggested item and the gate
    // opens with a LINKED item still on the deal.
    await approveReviewItems([getReviewState(T).items[0].id]);
    expect(blocksComplete("linked")).toBe(false);
    expect(blocksComplete("removed")).toBe(false);
    expect(snapshot().linked.sort()).toEqual(["e-match", "e-miss"]);
    expect(countReviewItems(T)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Exhaustiveness — the table vs. what the code actually does
 * ------------------------------------------------------------------ */

describe("EXHAUSTIVENESS — LIFECYCLE_TRANSITIONS vs the real operations", () => {
  /**
   * Deliberately ONE test, not seven plus an assertion.
   *
   * The set is built by execution, so a `-t` filtered run (how controls are
   * measured in this repo) would otherwise assert a partially-populated set and
   * red for the wrong reason. Every step carries its own expect, so a failure
   * still names the step that broke.
   */
  it("every transition performed is published, and every published transition is performed", async () => {
    const observed = new Map<string, string[]>();

    async function drive(
      label: string,
      emailIds: string[],
      op: () => Promise<unknown>,
    ): Promise<void> {
      const before = snapshot();
      await op();
      const after = snapshot();
      for (const id of emailIds) {
        const from = stateOf(before, id);
        const to = stateOf(after, id);
        if (from === to) continue;
        // Leaving every home is not a lifecycle move; it is a disappearance,
        // and no contract row can describe it.
        expect(to).not.toBe("new");
        const key = lifecycleTransitionKey(from, to as CommunicationLifecycleState);
        observed.set(key, [...(observed.get(key) ?? []), `${label} (${id})`]);
      }
    }

    // -- T1 door A + T2: the sync's confident/ambiguous split -----------------
    addEmail("e-confident", `Docs for ${PROPERTY} attached.`);
    addEmail("e-ambiguous", "Are you free Thursday?");
    addEmail("e-reject", "Coffee tomorrow?");
    addEmail("e-trash", `Closing on ${PROPERTY} is set.`);
    await drive(
      "T1/T2 sync split",
      ["e-confident", "e-ambiguous", "e-reject", "e-trash"],
      () => syncReviewQueueForTransaction({ transactionId: T, reason: "open" }),
    );
    expect(snapshot().suggested.sort()).toEqual(["e-ambiguous", "e-reject"]);
    expect(snapshot().linked.sort()).toEqual(["e-confident", "e-trash"]);

    // -- T1 door B: manual attach -------------------------------------------
    // The contract lists TWO triggers for T1; exercising only the sync half
    // would leave the other door unobserved.
    addEmail("e-manual", "Unrelated, attached by hand");
    await drive("T1 manual attach", ["e-manual"], () =>
      linkEmailToTransaction("e-manual", T, "manual", 0.95, "user_confirmed"),
    );
    expect(snapshot().linked).toContain("e-manual");

    // -- T3: Confirm on a review card ---------------------------------------
    const ambiguousItem = getReviewState(T).items.find((i) => i.email_id === "e-ambiguous")!;
    await drive("T3 review confirm", ["e-ambiguous"], () =>
      approveReviewItems([ambiguousItem.id]),
    );

    // -- T4: trash on a review card -----------------------------------------
    const rejectItem = getReviewState(T).items.find((i) => i.email_id === "e-reject")!;
    await drive("T4 review trash", ["e-reject"], () => rejectReviewItems([rejectItem.id]));
    expect(snapshot().removed).toContain("e-reject");

    // -- T6: Restore a REVIEW rejection -> back to SUGGESTED ------------------
    const rejectedRow = db
      .prepare("SELECT id FROM ignored_communications WHERE transaction_id=? AND email_id='e-reject'")
      .get(T) as { id: string };
    await drive("T6 restore review rejection", ["e-reject"], () =>
      restoreRejectedToQueue(rejectedRow.id),
    );
    expect(snapshot().suggested).toContain("e-reject");

    // -- T5: trash on a LINKED card, through the REAL unlink path -------------
    // transactionService.unlinkCommunication, not a fixture insert: the reason
    // string it writes ("Manually unlinked by user") is the producer's, and a
    // hand-written stand-in would be a state the app never emits.
    const linkRow = db
      .prepare("SELECT id FROM communications WHERE transaction_id=? AND email_id='e-trash'")
      .get(T) as { id: string };
    await drive("T5 linked-card trash", ["e-trash"], () =>
      transactionService.unlinkCommunication(linkRow.id),
    );
    expect(snapshot().removed).toContain("e-trash");

    // The real producer's discriminator is NOT a review rejection — which is
    // exactly what keeps T7 and T6 apart.
    const ordinary = db
      .prepare("SELECT id, reason FROM ignored_communications WHERE transaction_id=? AND email_id='e-trash'")
      .get(T) as { id: string; reason: string | null };
    expect(ordinary.reason).not.toBe(REVIEW_REJECTION_REASON);

    // -- T7: Restore an ORDINARY removal -> back to LINKED --------------------
    await drive("T7 restore ordinary removal", ["e-trash"], () =>
      transactionService.restoreRemovedEmailThread(ordinary.id, "e-trash", T, U),
    );
    expect(snapshot().linked).toContain("e-trash");

    /* ---------------- the two directions ---------------- */

    const observedKeys = [...observed.keys()].sort();
    const publishedKeys = [...PUBLISHED_TRANSITION_KEYS].sort();

    // DIRECTION 1 — code drift: a move the code performs that no contract row
    // describes. The message names the pair and what drove it.
    const unpublished = observedKeys
      .filter((k) => !PUBLISHED_TRANSITION_KEYS.has(k))
      .map((k) => `${k} performed by ${observed.get(k)!.join(", ")} but absent from LIFECYCLE_TRANSITIONS`);
    expect(unpublished).toEqual([]);

    // DIRECTION 2 — contract drift: a published row nothing performs. Deleting a
    // row from the table lands here, named.
    const unexercised = publishedKeys
      .filter((k) => !observed.has(k))
      .map((k) => {
        const [from, to] = k.split("->") as [LifecycleFrom, CommunicationLifecycleState];
        const rows = transitionsFor(from, to).map((t) => t.id).join("/");
        return `${k} (${rows || "no row"}) is published but no operation performed it`;
      });
    expect(unexercised).toEqual([]);

    // And, stated as one set equality, so the failure diff shows both sides.
    expect(observedKeys).toEqual(publishedKeys);

    // Sanity: every contract row id is distinct and all seven are present, so a
    // silently truncated table cannot make the comparison above vacuous.
    expect(LIFECYCLE_TRANSITIONS.map((t) => t.id)).toEqual([
      "T1", "T2", "T3", "T4", "T5", "T6", "T7",
    ]);
  });
});
