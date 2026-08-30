/**
 * @jest-environment node
 *
 * BACKLOG-2804 (support ticket 111) — the role words that come out of SQL.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS AT ALL
 * ===========================================================================
 * Most role labels in this app are made in the renderer, from
 * ROLE_DISPLAY_NAMES. `getTransactionsByContact` is the exception: its first
 * query builds the label in a SQL CASE, off the legacy denormalized columns
 * (`buyer_agent_id`, `seller_agent_id`, ...), and hands the finished WORDS to
 * the renderer. `checkCanDelete` returns them and three surfaces print them
 * verbatim — the "can't delete this contact" modal, the contact preview's
 * deals list, and the Contacts screen. So renaming the seller-side chip
 * without touching this leaves the app saying "Listing Agent" in one place and
 * "Seller Agent" in another about the same person on the same deal.
 *
 * ===========================================================================
 * WHY IT USES A REAL DATABASE
 * ===========================================================================
 * The existing coverage (databaseService.contactDeletion.test.ts) mocks
 * `prepare()` and hands back hand-written rows. Those tests exercise the
 * dedupe/merge logic above the query and NEVER RUN THE SQL — the CASE could
 * say anything at all and they would still pass, because the string they
 * assert is the string their own fixture supplied. This suite runs the real
 * statement against the real `schema.sql` so the label is read out of the
 * producer instead of being described.
 *
 * Fixture values are reserved-for-documentation only (`example.com`).
 */

import { readFileSync } from "fs";
import path from "path";
import { openTestDb, type TestDb } from "../../__tests__/helpers/syncSqliteDriver";

let db: TestDb;

jest.mock("../core/dbConnection", () => ({
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
}));

import { getTransactionsByContact } from "../contactDbService";

const SCHEMA_PATH = path.join(__dirname, "../../../database/schema.sql");
const USER = "user-2804";

function addContact(id: string, displayName: string): void {
  db.prepare(
    "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)",
  ).run(id, USER, displayName);
}

/**
 * A deal that names this contact in one of the denormalized agent columns —
 * the shape the CASE under test reads.
 */
function addTransactionWithAgent(
  txnId: string,
  column: "buyer_agent_id" | "seller_agent_id" | "inspector_id",
  contactId: string,
): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, ${column})
     VALUES (?, ?, ?, ?)`,
  ).run(txnId, USER, `${txnId} Example Way`, contactId);
}

async function rolesFor(contactId: string): Promise<string[]> {
  const txns = await getTransactionsByContact(contactId);
  return txns.flatMap((t) => t.roles ?? []);
}

beforeEach(() => {
  db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // BACKLOG-2993: the v56 tombstone columns (and every other chain-added
  // column) now come from the baseline schema.sql exec'd above — the
  // per-migration DDL bolt-ons this fixture used to apply are gone with
  // the chain.

  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id)
     VALUES (?, 'owner@example.com', 'google', 'oauth-2804')`,
  ).run(USER);
});

afterEach(() => {
  db.close();
});

describe("BACKLOG-2804 — getTransactionsByContact names the seller's agent", () => {
  it('labels the seller_agent_id party "Listing Agent"', async () => {
    addContact("c-robin", "Robin Example");
    addTransactionWithAgent("txn-a", "seller_agent_id", "c-robin");

    expect(await rolesFor("c-robin")).toEqual(["Listing Agent"]);
  });

  it('never emits the retired word "Seller Agent"', async () => {
    addContact("c-robin", "Robin Example");
    addTransactionWithAgent("txn-a", "seller_agent_id", "c-robin");

    expect(await rolesFor("c-robin")).not.toContain("Seller Agent");
  });

  it("leaves the other denormalized role labels alone", async () => {
    // The negative control. Rewriting the CASE wholesale, or matching the
    // wrong column, would pass the two cases above and break these.
    addContact("c-dana", "Dana Example");
    addTransactionWithAgent("txn-b", "buyer_agent_id", "c-dana");
    expect(await rolesFor("c-dana")).toEqual(["Buyer Agent"]);

    addContact("c-sam", "Sam Example");
    addTransactionWithAgent("txn-c", "inspector_id", "c-sam");
    expect(await rolesFor("c-sam")).toEqual(["Inspector"]);
  });

  it("names each side correctly when one contact is both, on two deals", async () => {
    // Identity, not count: which DEAL carries which label is what a user
    // reads off the "can't delete" modal before deciding to delete someone.
    addContact("c-jordan", "Jordan Example");
    addTransactionWithAgent("txn-sell", "seller_agent_id", "c-jordan");
    addTransactionWithAgent("txn-buy", "buyer_agent_id", "c-jordan");

    const txns = await getTransactionsByContact("c-jordan");
    const byId = new Map(txns.map((t) => [t.id, t.roles ?? []]));

    expect(byId.get("txn-sell")).toEqual(["Listing Agent"]);
    expect(byId.get("txn-buy")).toEqual(["Buyer Agent"]);
  });
});
