/**
 * BACKLOG-2311 — End-to-end address-matching repro (hermetic, seeded fixtures).
 *
 * We cannot test with the reporter's real mailbox, so we reproduce her exact
 * scenario with the hermetic fake-mailbox fixtures
 * (`fixtures/fake-mailbox/emails.json` + `emailFixtureService`) and drive the
 * REAL autolink pipeline: `autoLinkCommunicationsForContact` →
 * `findEmailsByContactEmails` → `contentContainsAddress` / `withAddressFallback`.
 *
 * WHY the DB layer is mocked (not real SQLite): the real-native `better-sqlite3`
 * integration tests (autoLinkService.junction.test.ts, expandAttachedThreads)
 * cannot run in this worktree — its node_modules is symlinked from the main repo
 * and built for Electron's Node ABI, so `new Database()` crashes under system-Node
 * jest (NODE_MODULE_VERSION mismatch). This test therefore mocks ONLY the
 * dbConnection layer with a fixture-driven in-memory model and runs the real
 * service + real matching logic on top. The exact SQL shape of
 * findEmailsByContactEmails is separately guarded (in CI) by the junction test.
 *
 * Assertions are by IDENTITY (which fixture email ids attach to which
 * transaction), never by count.
 *
 * @see BACKLOG-2311
 */

import { getEmailById } from "./fixtures/fake-mailbox/emailFixtureService";
import type { FakeEmail } from "./fixtures/fake-mailbox/types";
import { normalizeAddress, contentContainsAddress } from "../../utils/addressNormalization";

// ----- Mocked dbConnection (fixture-driven in-memory model) -----
const mockDbAll = jest.fn();
const mockDbGet = jest.fn();
const mockDbRun = jest.fn();

jest.mock("../db/core/dbConnection", () => ({
  dbAll: (...args: unknown[]) => mockDbAll(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbRun: (...args: unknown[]) => mockDbRun(...args),
}));

jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

jest.mock("../messageMatchingService", () => ({
  normalizePhone: jest.fn(() => null),
}));

jest.mock("../db/communicationDbService", () => ({
  createThreadCommunicationReference: jest.fn(),
  isThreadLinkedToTransaction: jest.fn().mockResolvedValue(false),
  getIgnoredEmailIdsForTransaction: jest.fn().mockReturnValue(new Set()),
  getIgnoredThreadIdsForTransaction: jest.fn().mockReturnValue(new Set()),
  getIgnoredCommunicationIdsForTransaction: jest.fn().mockReturnValue(new Set()),
}));

// Imported AFTER the mocks are registered.
import { autoLinkCommunicationsForContact } from "../autoLinkService";

// ----- Seed model -----
interface SeedTxn {
  property_address: string | null;
  property_street?: string | null;
  skip_address_filter?: number;
}
interface Seed {
  userId: string;
  userEmail: string;
  transactions: Record<string, SeedTxn>;
  /** contactId -> the contact's email addresses */
  contacts: Record<string, string[]>;
  /** (contactId, transactionId) membership pairs */
  membership: Array<{ contactId: string; transactionId: string }>;
  /** fixture emails participating in the mailbox */
  emails: Array<{ id: string; sender: string; recipients: string[]; subject: string; body: string; sent_at: string; thread_id: string }>;
}

/** Convert a fake-mailbox FakeEmail into a seed email row. */
function fromFixture(id: string): Seed["emails"][number] {
  const e = getEmailById(id) as FakeEmail;
  if (!e) throw new Error(`fixture email not found: ${id}`);
  return {
    id: e.id,
    sender: e.sender,
    recipients: e.recipients,
    subject: e.subject,
    body: e.body,
    sent_at: e.sent_at,
    thread_id: e.thread_id,
  };
}

const WINDOW = { start: new Date("2024-01-01T00:00:00Z"), end: new Date("2024-12-31T23:59:59Z") };

/**
 * Wire the module-level db mocks to a fresh seed. Returns a helper to read back
 * which fixture email ids were linked to a given transaction.
 */
function installDb(seed: Seed): { linkedFor: (txnId: string) => string[] } {
  const links = new Set<string>(); // `${emailId}::${txnId}`
  const key = (emailId: string, txnId: string) => `${emailId}::${txnId}`;

  mockDbGet.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes("COUNT(DISTINCT tc.transaction_id)")) {
      const contactId = params?.[0] as string;
      const txns = new Set(
        seed.membership.filter((m) => m.contactId === contactId).map((m) => m.transactionId)
      );
      return { cnt: txns.size };
    }
    if (sql.includes("FROM contacts WHERE id")) {
      const contactId = params?.[0] as string;
      return seed.contacts[contactId] ? { id: contactId } : null;
    }
    if (sql.includes("FROM transactions")) {
      const txnId = params?.[0] as string;
      const t = seed.transactions[txnId];
      if (!t) return null;
      return {
        user_id: seed.userId,
        started_at: "2024-01-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
        closed_at: null,
        property_address: t.property_address,
        property_street: t.property_street ?? null,
        skip_address_filter: t.skip_address_filter ?? 0,
      };
    }
    if (sql.includes("FROM users_local")) {
      return { email: seed.userEmail };
    }
    if (sql.includes("FROM communications") && sql.includes("email_id")) {
      const emailId = params?.[0] as string;
      const txnId = params?.[1] as string;
      return links.has(key(emailId, txnId)) ? { id: "comm", transaction_id: txnId } : null;
    }
    if (sql.includes("FROM emails WHERE id")) {
      const emailId = params?.[0] as string;
      const e = seed.emails.find((x) => x.id === emailId);
      return { user_id: seed.userId, thread_id: e?.thread_id ?? null };
    }
    return null;
  });

  mockDbAll.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes("FROM contact_emails")) {
      const contactId = params?.[0] as string;
      return (seed.contacts[contactId] ?? []).map((email) => ({ email }));
    }
    if (sql.includes("FROM contact_phones")) {
      return [];
    }
    if (sql.includes("FROM email_participants ep")) {
      // Real params: [txnId, ...contactEmails, userId, startISO, endISO]
      const p = (params ?? []) as string[];
      const txnId = p[0];
      const startISO = p[p.length - 2];
      const endISO = p[p.length - 1];
      const contactEmails = new Set(p.slice(1, p.length - 3).map((e) => e.toLowerCase()));

      return seed.emails
        .filter((e) => {
          const participants = [e.sender, ...e.recipients].map((a) => a.toLowerCase());
          const isParticipant = participants.some((a) => contactEmails.has(a));
          const inWindow = e.sent_at >= startISO && e.sent_at <= endISO;
          const alreadyLinked = links.has(key(e.id, txnId));
          return isParticipant && inWindow && !alreadyLinked;
        })
        .map((e) => ({ id: e.id, subject: e.subject, body_plain: e.body }));
    }
    if (sql.includes("FROM messages") && sql.includes("sms")) {
      return [];
    }
    return [];
  });

  mockDbRun.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes("INSERT INTO communications")) {
      const p = (params ?? []) as unknown[];
      const txnId = p[2] as string;
      const emailId = p[3] as string;
      links.add(key(emailId, txnId));
    }
  });

  return {
    linkedFor: (txnId: string) =>
      [...links].filter((k) => k.endsWith(`::${txnId}`)).map((k) => k.split("::")[0]).sort(),
  };
}

const USER_ID = "user-2311";
const USER_EMAIL = "user@keepr.test";
const MADISON = "contact-madison";
const MADISON_EMAIL = "madison@example.com";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("BACKLOG-2311 address-matching repro (hermetic fixtures, real pipeline)", () => {
  // ---------------------------------------------------------------------------
  // Case 1 — THE MADISON REPRO: abbreviated 'Rd SW' must link to a transaction
  // stored as '3414 Sapp Road Southwest'. Red under old behavior, green now.
  // ---------------------------------------------------------------------------
  it("Case 1 (repro): email '3414 Sapp Rd SW' links to transaction '3414 Sapp Road Southwest'", async () => {
    // --- Red→green documentation at the matching-logic layer ---
    const emailText = getEmailById("fake-email-2311-sapp-abbrev")!.body; // "...3414 Sapp Rd SW..."
    // OLD behavior: the normalizer kept "sapp road southwest" and required EVERY
    // literal token, so the abbreviated email failed the filter.
    const oldRequiredTerms = ["sapp", "road", "southwest"];
    const oldWouldMatch =
      /\b3414\b/i.test(emailText) &&
      oldRequiredTerms.every((w) => new RegExp(`\\b${w}\\b`, "i").test(emailText));
    expect(oldWouldMatch).toBe(false); // RED: pre-fix this email did NOT match

    // NEW behavior: canonicalization folds Rd/Road and SW/Southwest → matches.
    const addr = normalizeAddress("3414 Sapp Road Southwest, Olympia, WA 98512")!;
    expect(contentContainsAddress(emailText, addr)).toBe(true); // GREEN

    // --- End-to-end: run the REAL autolink pipeline on seeded fixtures ---
    // Madison is on TWO transactions so the address gate is ACTIVELY applied
    // (not the single-candidate bypass) — proving canonicalization is what links it.
    const seed: Seed = {
      userId: USER_ID,
      userEmail: USER_EMAIL,
      transactions: {
        "txn-sapp": { property_address: "3414 Sapp Road Southwest, Olympia, WA 98512" },
        "txn-decoy": { property_address: "500 Pine Boulevard, Olympia, WA 98512" },
      },
      contacts: { [MADISON]: [MADISON_EMAIL] },
      membership: [
        { contactId: MADISON, transactionId: "txn-sapp" },
        { contactId: MADISON, transactionId: "txn-decoy" },
      ],
      emails: [fromFixture("fake-email-2311-sapp-abbrev")],
    };
    const db = installDb(seed);

    const result = await autoLinkCommunicationsForContact({
      contactId: MADISON,
      transactionId: "txn-sapp",
      dateRange: WINDOW,
    });

    expect(result.emailsLinked).toBe(1);
    expect(db.linkedFor("txn-sapp")).toEqual(["fake-email-2311-sapp-abbrev"]);
  });

  // ---------------------------------------------------------------------------
  // Case 2 — reverse variant: full-form email links to abbreviated transaction.
  // ---------------------------------------------------------------------------
  it("Case 2 (reverse): email '3414 Sapp Road Southwest' links to transaction '3414 Sapp Rd SW'", async () => {
    const seed: Seed = {
      userId: USER_ID,
      userEmail: USER_EMAIL,
      transactions: {
        "txn-sapp-abbrev": { property_address: "3414 Sapp Rd SW" },
        "txn-decoy": { property_address: "500 Pine Boulevard" },
      },
      contacts: { [MADISON]: [MADISON_EMAIL] },
      membership: [
        { contactId: MADISON, transactionId: "txn-sapp-abbrev" },
        { contactId: MADISON, transactionId: "txn-decoy" },
      ],
      emails: [fromFixture("fake-email-2311-sapp-full")],
    };
    const db = installDb(seed);

    const result = await autoLinkCommunicationsForContact({
      contactId: MADISON,
      transactionId: "txn-sapp-abbrev",
      dateRange: WINDOW,
    });

    expect(result.emailsLinked).toBe(1);
    expect(db.linkedFor("txn-sapp-abbrev")).toEqual(["fake-email-2311-sapp-full"]);
  });

  // ---------------------------------------------------------------------------
  // Case 3 — multi-candidate disambiguation: one contact on two transactions,
  // two emails each naming one address (different abbreviation styles). Each
  // email routes to the CORRECT transaction, never both.
  // ---------------------------------------------------------------------------
  it("Case 3 (disambiguation): each email routes to its own transaction, not both", async () => {
    const seed: Seed = {
      userId: USER_ID,
      userEmail: USER_EMAIL,
      transactions: {
        "txn-oak": { property_address: "100 Oak St" }, // email says "100 Oak Street"
        "txn-elm": { property_address: "200 Elm Avenue" }, // email says "200 Elm Ave"
      },
      contacts: { [MADISON]: [MADISON_EMAIL] },
      membership: [
        { contactId: MADISON, transactionId: "txn-oak" },
        { contactId: MADISON, transactionId: "txn-elm" },
      ],
      emails: [fromFixture("fake-email-2311-oak-full"), fromFixture("fake-email-2311-elm-abbrev")],
    };
    const db = installDb(seed);

    const oak = await autoLinkCommunicationsForContact({
      contactId: MADISON,
      transactionId: "txn-oak",
      dateRange: WINDOW,
    });
    const elm = await autoLinkCommunicationsForContact({
      contactId: MADISON,
      transactionId: "txn-elm",
      dateRange: WINDOW,
    });

    expect(oak.emailsLinked).toBe(1);
    expect(elm.emailsLinked).toBe(1);
    // Identity: correct routing, NOT cross-linked.
    expect(db.linkedFor("txn-oak")).toEqual(["fake-email-2311-oak-full"]);
    expect(db.linkedFor("txn-elm")).toEqual(["fake-email-2311-elm-abbrev"]);
  });

  // ---------------------------------------------------------------------------
  // Case 4 — multi-candidate OVER-ATTACH (documented tradeoff): the second
  // transaction has ZERO emails naming its own address, so the restored widening
  // fallback attaches the contact's in-window emails to it. This is the
  // deliberate "over-attach beats drop" behavior; per-link match_reason + a
  // review/approve UX to trim it is BACKLOG-2319.
  // ---------------------------------------------------------------------------
  it("Case 4 (over-attach tradeoff): a transaction with no address-matching email gets the fallback attach", async () => {
    const seed: Seed = {
      userId: USER_ID,
      userEmail: USER_EMAIL,
      transactions: {
        "txn-oak": { property_address: "100 Oak St" },
        "txn-pine": { property_address: "500 Pine Boulevard" }, // no email names Pine
      },
      contacts: { [MADISON]: [MADISON_EMAIL] },
      membership: [
        { contactId: MADISON, transactionId: "txn-oak" },
        { contactId: MADISON, transactionId: "txn-pine" },
      ],
      emails: [fromFixture("fake-email-2311-oak-full")], // only names Oak
    };
    const db = installDb(seed);

    const pine = await autoLinkCommunicationsForContact({
      contactId: MADISON,
      transactionId: "txn-pine",
      dateRange: WINDOW,
    });

    // CURRENT behavior: address filter yields 0 for Pine → fallback widens →
    // the Oak email over-attaches to the Pine transaction. Asserting the
    // tradeoff explicitly (BACKLOG-2319 will add per-link match_reason + review).
    expect(pine.emailsLinked).toBe(1);
    expect(db.linkedFor("txn-pine")).toEqual(["fake-email-2311-oak-full"]);
  });
});
