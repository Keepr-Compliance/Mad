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
  isPublishedTransition,
  transitionsFor,
  classifyRemoval,
  LEGACY_NEEDS_REVIEW_CLASSIFICATION,
  type CommunicationLifecycleState,
  type LifecycleFrom,
  type LifecycleActionId,
  type RemovalFlavor,
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

/**
 * The flavour of the suppression row this email currently occupies, classified
 * from the row's OWN stored values — never from what the test believes it wrote.
 * `undefined` when the email is not in REMOVED.
 */
function removalFlavorOf(emailId: string): RemovalFlavor | undefined {
  const row = db
    .prepare(
      "SELECT reason, match_reason FROM ignored_communications WHERE transaction_id=? AND email_id=?",
    )
    .get(T, emailId) as { reason: string | null; match_reason: string | null } | undefined;
  return row ? classifyRemoval(row.reason, row.match_reason) : undefined;
}

/** The contract row ids sharing a key, for naming a failure. */
function rowsFor(key: string): string {
  const ids = LIFECYCLE_TRANSITIONS.filter(
    (t) => lifecycleTransitionKey(t.from, t.to, t.removalFlavor) === key,
  ).map((t) => t.id);
  return ids.join("/") || "no row";
}

/**
 * Every door published for a move, UNIONED across the rows sharing its key.
 *
 * Per key, not per row: T4 and T4b are both `suggested->removed` (the flavour
 * qualifies the From column only), so the doors that reach that move are the
 * union of theirs.
 */
function publishedActionsFor(key: string): ReadonlySet<LifecycleActionId> {
  const out = new Set<LifecycleActionId>();
  for (const t of LIFECYCLE_TRANSITIONS) {
    if (lifecycleTransitionKey(t.from, t.to, t.removalFlavor) === key) {
      for (const a of t.actions) out.add(a);
    }
  }
  return out;
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
  it("the flavour keeps T6 and T7b apart — they share a from->to pair", () => {
    // The founder's T7b ruling put a THIRD row on the REMOVED source, and two of
    // the three (T6, T7b) land on SUGGESTED. On a bare from->to pair they would
    // be the same key, and either row could be deleted from the table without a
    // test noticing. The flavour is what separates them.
    expect(transitionsFor("removed", "suggested", "review-rejection").map((t) => t.id)).toEqual(["T6"]);
    expect(transitionsFor("removed", "suggested", "ordinary-address-missing").map((t) => t.id)).toEqual(["T7b"]);
    expect(transitionsFor("removed", "linked", "ordinary").map((t) => t.id)).toEqual(["T7"]);

    // ...and an ordinary removal restoring to SUGGESTED is NOT published — that
    // combination is T7b's alone, which is the ruling's whole point.
    expect(isPublishedTransition("removed", "suggested", "ordinary")).toBe(false);
    expect(isPublishedTransition("removed", "suggested", "review-rejection")).toBe(true);
  });

  it("classifyRemoval reads the reason before the classification", () => {
    // A review rejection ALSO carries the legacy classification; testing the
    // classification first would misread every rejection as T7b and send
    // never-approved mail back as an ordinary restore.
    expect(classifyRemoval(REVIEW_REJECTION_REASON, LEGACY_NEEDS_REVIEW_CLASSIFICATION)).toBe("review-rejection");
    expect(classifyRemoval("Manually unlinked by user", LEGACY_NEEDS_REVIEW_CLASSIFICATION)).toBe("ordinary-address-missing");
    expect(classifyRemoval("Manually unlinked by user", "address_found")).toBe("ordinary");
    expect(classifyRemoval(null, null)).toBe("ordinary");
  });

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
    const observedActions = new Map<string, Set<LifecycleActionId>>();

    /**
     * Drive one REAL operation, and attribute every move it causes to the door
     * that caused it.
     *
     * ATTRIBUTION IS PER EMAIL, NOT PER CALL (BACKLOG-2825), because one call is
     * not one door. The sync's single pass splits its emails between the
     * confident door (T1) and the address-missing door (T2); the tab's trash on
     * a mixed thread moves an ordinary linked email (T5) and a legacy
     * address-missing email (T4b) in the same click. A per-call action id would
     * have to lie about one of them.
     *
     * The attribution is not free narration either — it is checked. Claim a
     * door for an email and the move lands on a key that door is not published
     * for, and the action comparison below reds.
     */
    async function drive(
      moves: ReadonlyArray<readonly [string, LifecycleActionId]>,
      op: () => Promise<unknown>,
    ): Promise<void> {
      const before = snapshot();
      // The flavour has to be read BEFORE the operation: a restore deletes the
      // suppression row it acted on, so afterwards there is nothing left to
      // classify. This is the only moment the source flavour is observable.
      const flavorBefore = new Map<string, RemovalFlavor | undefined>(
        moves.map(([id]) => [id, removalFlavorOf(id)]),
      );
      await op();
      const after = snapshot();
      for (const [id, action] of moves) {
        const from = stateOf(before, id);
        const to = stateOf(after, id);
        if (from === to) continue;
        // Leaving every home is not a lifecycle move; it is a disappearance,
        // and no contract row can describe it.
        expect(to).not.toBe("new");
        // Flavour qualifies the SOURCE only, exactly as the contract writes it.
        const flavor = from === "removed" ? flavorBefore.get(id) : undefined;
        if (from === "removed") {
          // A removed item with no classifiable suppression row would make the
          // key silently flavourless and collapse T6/T7/T7b back together.
          expect(flavor).toBeDefined();
        }
        const key = lifecycleTransitionKey(from, to as CommunicationLifecycleState, flavor);
        observed.set(key, [...(observed.get(key) ?? []), `${action} (${id})`]);
        observedActions.set(key, (observedActions.get(key) ?? new Set<LifecycleActionId>()).add(action));
      }
    }

    // -- T1 door A + T2: the sync's confident/ambiguous split -----------------
    addEmail("e-confident", `Docs for ${PROPERTY} attached.`);
    addEmail("e-ambiguous", "Are you free Thursday?");
    addEmail("e-reject", "Coffee tomorrow?");
    addEmail("e-trash", `Closing on ${PROPERTY} is set.`);
    await drive(
      [
        // Which door each email took is CLAIMED here and checked below: a
        // confident-door claim on an email the sync actually queued would land
        // "sync-confident-split" on new->suggested, which T2 does not publish.
        ["e-confident", "sync-confident-split"],
        ["e-trash", "sync-confident-split"],
        ["e-ambiguous", "sync-address-missing"],
        ["e-reject", "sync-address-missing"],
      ],
      () => syncReviewQueueForTransaction({ transactionId: T, reason: "open" }),
    );
    expect(snapshot().suggested.sort()).toEqual(["e-ambiguous", "e-reject"]);
    expect(snapshot().linked.sort()).toEqual(["e-confident", "e-trash"]);

    // -- T1 door B: manual attach -------------------------------------------
    // The contract lists TWO triggers for T1; exercising only the sync half
    // would leave the other door unobserved.
    addEmail("e-manual", "Unrelated, attached by hand");
    await drive([["e-manual", "manual-attach"]], () =>
      linkEmailToTransaction("e-manual", T, "manual", 0.95, "user_confirmed"),
    );
    expect(snapshot().linked).toContain("e-manual");

    // -- T3: Confirm on a review card ---------------------------------------
    const ambiguousItem = getReviewState(T).items.find((i) => i.email_id === "e-ambiguous")!;
    await drive([["e-ambiguous", "review-confirm"]], () =>
      approveReviewItems([ambiguousItem.id]),
    );

    // -- T4: trash on a review card -----------------------------------------
    const rejectItem = getReviewState(T).items.find((i) => i.email_id === "e-reject")!;
    await drive([["e-reject", "review-trash"]], () => rejectReviewItems([rejectItem.id]));
    expect(snapshot().removed).toContain("e-reject");

    // -- T6: Restore a REVIEW rejection -> back to SUGGESTED ------------------
    const rejectedRow = db
      .prepare("SELECT id FROM ignored_communications WHERE transaction_id=? AND email_id='e-reject'")
      .get(T) as { id: string };
    await drive([["e-reject", "removed-card-restore"]], () =>
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
    await drive([["e-trash", "linked-card-trash"]], () =>
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
    await drive([["e-trash", "removed-card-restore"]], () =>
      transactionService.restoreRemovedEmailThread(ordinary.id, "e-trash", T, U),
    );
    expect(snapshot().linked).toContain("e-trash");

    // -- T7b: the founder's 2026-08-23 ruling --------------------------------
    // An ordinary removal that CARRIED the legacy needs-review classification
    // restores to SUGGESTED, not LINKED: the shipped restore preserves the
    // classification, so the recreated link lands back in the population
    // getReviewState counts.
    //
    // Every leg is driven by its real producer. The legacy link is created with
    // the exact call autoLinkService makes for the ambiguous half when it is not
    // queueing ("auto", 0.5, the legacy classification) — transcribed from
    // autoLinkService, not invented — and it is then trashed and restored
    // through transactionService, the same two functions the tab's buttons call.
    addEmail("e-legacy", "Sunday brunch?");
    // The door is the sync's address-missing half: this is the exact call
    // autoLinkService makes for the ambiguous half when it is not queueing
    // (autoLinkService.ts:938 — "auto", the run's confidence, the match reason),
    // so it is T2's door, not a fourth one.
    await drive([["e-legacy", "sync-address-missing"]], () =>
      linkEmailToTransaction("e-legacy", T, "auto", 0.5, LEGACY_NEEDS_REVIEW_CLASSIFICATION),
    );
    // Linked by table, SUGGESTED by contract — the case a store-membership
    // derivation gets wrong.
    expect(snapshot().suggested).toContain("e-legacy");

    const legacyLink = db
      .prepare("SELECT id FROM communications WHERE transaction_id=? AND email_id='e-legacy'")
      .get(T) as { id: string };
    // T4b — the SAME door as T5, on an email in a different source state. See
    // the T4b row for how a legacy address-missing email reaches a card in the
    // tab's LINKED list.
    await drive([["e-legacy", "linked-card-trash"]], () =>
      transactionService.unlinkCommunication(legacyLink.id),
    );

    const legacyRemoved = db
      .prepare("SELECT id FROM ignored_communications WHERE transaction_id=? AND email_id='e-legacy'")
      .get(T) as { id: string };
    // The flavour the real producers actually left behind, classified from the
    // row itself. If this were "ordinary" the next step would be T7, not T7b.
    expect(removalFlavorOf("e-legacy")).toBe("ordinary-address-missing");

    await drive([["e-legacy", "removed-card-restore"]], () =>
      transactionService.restoreRemovedEmailThread(legacyRemoved.id, "e-legacy", T, U),
    );
    // Back in needs-review — NOT linked. This is the whole of the ruling.
    expect(snapshot().suggested).toContain("e-legacy");
    expect(snapshot().linked).not.toContain("e-legacy");

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
      .map((k) => `${k} (${rowsFor(k)}) is published but no operation performed it`);
    expect(unexercised).toEqual([]);

    /* ------- the same two directions, on the DOORS (BACKLOG-2825) -------
     *
     * `actions` used to be free text that nothing read: the SR deleted
     * "manual-attach" from T1 and all six tests stayed green, so the published
     * Trigger column could drift from the app's real doors in silence. These
     * two comparisons are what make the column load-bearing.
     */

    // DIRECTION 3 — an undeclared door: the code reached this move through an
    // action no row publishes for it. Deleting an action from a row lands here.
    const undeclaredDoors: string[] = [];
    for (const key of [...observedActions.keys()].sort()) {
      const published = publishedActionsFor(key);
      for (const action of [...observedActions.get(key)!].sort()) {
        if (!published.has(action)) {
          undeclaredDoors.push(
            `${action} performed ${key} but no LIFECYCLE_TRANSITIONS row for that move declares it`,
          );
        }
      }
    }
    expect(undeclaredDoors).toEqual([]);

    // DIRECTION 4 — a published door nothing opens: an action on a row that no
    // operation in this suite actually drove.
    const undrivenDoors: string[] = [];
    for (const key of publishedKeys) {
      const driven = observedActions.get(key) ?? new Set<LifecycleActionId>();
      for (const action of [...publishedActionsFor(key)].sort()) {
        if (!driven.has(action)) {
          undrivenDoors.push(
            `${action} is declared on ${rowsFor(key)} (${key}) but no operation performed it`,
          );
        }
      }
    }
    expect(undrivenDoors).toEqual([]);

    // And, stated as one set equality, so the failure diff shows both sides.
    expect(observedKeys).toEqual(publishedKeys);

    // Sanity: every contract row id is distinct and all of them are present, so
    // a silently truncated table cannot make the comparisons above vacuous.
    expect(LIFECYCLE_TRANSITIONS.map((t) => t.id)).toEqual([
      "T1", "T2", "T3", "T4", "T4b", "T5", "T6", "T7", "T7b",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Completeness — the table can explain its own preconditions
 * ------------------------------------------------------------------ */

/**
 * THE CLOSURE PROPERTY OF THE TABLE (BACKLOG-2825).
 *
 * A removal's flavour is an INPUT to the rows that leave REMOVED — it is what
 * selects the destination, which is why T6, T7 and T7b share a source state and
 * differ only by it. So every flavour the table CONSUMES has to be a flavour the
 * table also WRITES, or the table is describing a precondition it cannot explain
 * how anything reaches.
 *
 * It failed that, and the failure was invisible. Published with eight rows,
 * `ordinary-address-missing` was T7b's source and NO row wrote it: T4 documents
 * `review-rejection`, T5 documents `ordinary`. Read as data, the table could not
 * answer "how does an item get into that state?" — because the removal that
 * creates T7b's precondition is a `suggested->removed` move, the same KEY as T4,
 * and was silently folded into T4's row while writing a different flavour.
 *
 * This is checked as DATA, not by execution, and deliberately: it is a property
 * of the table's shape, so it holds (or fails) without a database, and a `-t`
 * filtered run of it is honest.
 */
describe("COMPLETENESS — every source flavour the table consumes, some row writes", () => {
  it("no row leaves REMOVED through a flavour no row writes into REMOVED", () => {
    const written = new Set<RemovalFlavor>();
    for (const t of LIFECYCLE_TRANSITIONS) {
      if (t.to === "removed" && t.removalFlavor) written.add(t.removalFlavor);
    }

    const unproduced = LIFECYCLE_TRANSITIONS.filter(
      (t) => t.from === "removed" && t.removalFlavor && !written.has(t.removalFlavor),
    ).map(
      (t) =>
        `removed(${t.removalFlavor}) is the source of ${t.id}, but no published row writes ` +
        `${t.removalFlavor} into REMOVED — the table cannot explain how that state is reached`,
    );
    expect(unproduced).toEqual([]);

    // NOT VACUOUS. Asserted as an exact SET, not a count: an emptied or
    // truncated table would otherwise pass the check above by consuming nothing.
    const consumed = new Set<RemovalFlavor>(
      LIFECYCLE_TRANSITIONS.filter((t) => t.from === "removed" && t.removalFlavor).map(
        (t) => t.removalFlavor!,
      ),
    );
    expect([...consumed].sort()).toEqual([
      "ordinary",
      "ordinary-address-missing",
      "review-rejection",
    ]);
  });
});
