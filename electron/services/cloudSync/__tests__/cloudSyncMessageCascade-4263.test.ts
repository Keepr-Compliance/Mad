/**
 * @jest-environment node
 *
 * BACKLOG-4263 P5, control C-5d: SQLite fires the `communications` AFTER DELETE trigger for link rows removed by an
 * ON DELETE CASCADE (an email or text deleted, a deal deleted), on the real schema.sql with foreign_keys = ON (as
 * databaseService.ts opens it) and recursive_triggers at its default; the next pass then tombstones the online row.
 *
 * On CI this suite must run on the bundled driver (better-sqlite3-multiple-ciphers): it reads the SQLite version the
 * installed package's header declares and asks the engine itself (sqlite_version(), sqlite3mc_version()). When CI is
 * set and the engine is not the bundled one, the suite fails.
 */
import fs from "fs";
import path from "path";
import { DRIVER, openTestDb } from "./helpers/sqlite";
import { dealId, enableUser, freshDb, insertDeal } from "./helpers/fixtures";
import { makeEngine, pass, startAndPass } from "./helpers/engine";
import { addEmail, addText, fz, linkEmail, linkText, linkThread } from "./helpers/messageFixtures";

function engineFacts(): { header: string | null; got: string; mc: string | null; bundled: boolean } {
  const db = openTestDb();
  try {
    const hdr = fs.readFileSync(
      path.join(path.dirname(require.resolve("better-sqlite3-multiple-ciphers/package.json")), "deps/sqlite3/sqlite3.h"),
      "utf8",
    );
    const header = /#define SQLITE_VERSION\s+"([^"]+)"/.exec(hdr)?.[1] ?? null;
    const got = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    let mc: string | null = null;
    try {
      mc = (db.prepare("SELECT sqlite3mc_version() AS v").get() as { v: string }).v;
    } catch {
      mc = null;
    }
    return { header, got, mc, bundled: !!header && got === header && typeof mc === "string" && mc.length > 0 };
  } finally {
    db.close();
  }
}

const facts = engineFacts();
// One line naming the engine, written to stdout (not the console, so --silent keeps it).
process.stdout.write(`C-5d engine: ${DRIVER}; sqlite ${facts.got}; header ${facts.header}; sqlite3mc ${facts.mc}\n`);
const dirtyOf = (db: ReturnType<typeof freshDb>) =>
  (db.prepare("SELECT transaction_id FROM cloud_sync_dirty ORDER BY transaction_id").all() as Array<{ transaction_id: string }>).map((r) => r.transaction_id);

describe(`C-5d cascade deletes mark the deal [${DRIVER}] sqlite ${facts.got} header ${facts.header} sqlite3mc ${facts.mc}`, () => {
  it("runs on the bundled driver when CI is set", () => {
    if (process.env.CI && !facts.bundled) {
      throw new Error(`C-5d must run on the bundled driver: sqlite ${facts.got}, header ${facts.header}, mc ${facts.mc}`);
    }
    expect(typeof facts.got).toBe("string");
  });

  it("the app's pragmas: foreign_keys on, recursive_triggers off", () => {
    const db = freshDb();
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 0 });
  });

  it("deleting an email cascades its link and marks the deal; with foreign keys off nothing cascades and nothing is marked", () => {
    for (const fk of [true, false]) {
      const db = freshDb();
      enableUser(db);
      const deal = dealId();
      insertDeal(db, deal);
      addEmail(db, fz(1, 1));
      linkEmail(db, fz(2, 1), deal, fz(1, 1));
      db.prepare("DELETE FROM cloud_sync_dirty").run();
      if (!fk) db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM emails WHERE id = ?").run(fz(1, 1));
      expect([fk, dirtyOf(db)]).toEqual([fk, fk ? [deal] : []]);
    }
  });

  it("deleting a text cascades its per-message link and marks the deal; deleting a deal marks it", () => {
    const db = freshDb();
    enableUser(db);
    const [a, b] = [dealId(), dealId()];
    insertDeal(db, a);
    insertDeal(db, b);
    addText(db, fz(3, 1), { threadId: null });
    linkText(db, fz(2, 1), a, fz(3, 1));
    addEmail(db, fz(1, 1));
    linkEmail(db, fz(2, 2), b, fz(1, 1));
    db.prepare("DELETE FROM cloud_sync_dirty").run();
    db.prepare("DELETE FROM messages WHERE id = ?").run(fz(3, 1));
    expect(dirtyOf(db)).toEqual([a]);
    db.prepare("DELETE FROM cloud_sync_dirty").run();
    db.prepare("DELETE FROM transactions WHERE id = ?").run(b);
    expect(dirtyOf(db)).toEqual([b]);
  });

  it("a cascade started inside another trigger's body still fires the link trigger (recursive_triggers off)", () => {
    const db = freshDb();
    enableUser(db);
    const deal = dealId();
    insertDeal(db, deal);
    addEmail(db, fz(1, 1));
    linkEmail(db, fz(2, 1), deal, fz(1, 1));
    db.exec("CREATE TABLE c5d_kick (email_id TEXT)");
    db.exec("CREATE TRIGGER c5d_kick_t AFTER INSERT ON c5d_kick BEGIN DELETE FROM emails WHERE id = NEW.email_id; END;");
    db.prepare("DELETE FROM cloud_sync_dirty").run();
    db.prepare("INSERT INTO c5d_kick VALUES (?)").run(fz(1, 1));
    expect(dirtyOf(db)).toEqual([deal]);
  });

  it("end to end: an email deleted on this computer is tombstoned online by the next pass", async () => {
    const db = freshDb();
    enableUser(db);
    const deal = dealId();
    insertDeal(db, deal);
    addEmail(db, fz(1, 1));
    addEmail(db, fz(1, 2));
    linkEmail(db, fz(2, 1), deal, fz(1, 1));
    linkEmail(db, fz(2, 2), deal, fz(1, 2));
    addText(db, fz(3, 1));
    linkThread(db, fz(2, 3), deal, "macos-chat-1");
    const e = makeEngine(db);
    e.server.messagesUpload = true;
    await startAndPass(e);
    expect(e.server.messages.filter((m) => !m.removed)).toHaveLength(3);
    db.prepare("DELETE FROM emails WHERE id = ?").run(fz(1, 2));
    await pass(e);
    expect(e.server.messages.filter((m) => !m.removed).map((m) => m.localId).sort()).toEqual([fz(1, 1), `guid-${fz(3, 1)}`].sort());
  });
});
