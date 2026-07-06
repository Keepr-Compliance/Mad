/**
 * Unit tests for transactionSearchDbService (BACKLOG-1866)
 *
 * The native SQLite driver is mocked project-wide (jest.config moduleNameMapper),
 * so these tests inject a faithful fake `db` that routes queries by an inert SQL
 * marker comment. This lets us verify:
 *   - SCOPING: every group query is gated by the transaction's junction rows, and
 *     a matching-but-UNLINKED email is never returned.
 *   - Each match field (name / email / phone / subject / body / sender / text body).
 *   - Empty query short-circuits (no DB access).
 *   - LIKE wildcard escaping (% and _).
 *   - Per-group LIMIT and total counts / grouped shaping.
 */

import {
  escapeLike,
  buildContactQuery,
  buildEmailQuery,
  buildTextQuery,
  searchLinkedContent,
  type SearchableDb,
} from "./transactionSearchDbService";

const TXN = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// Fake DB: routes prepare(sql) by the marker comment embedded in each query.
// ---------------------------------------------------------------------------

interface FakeRoute {
  marker: string;
  rows?: unknown[];
  count?: number;
}

function makeFakeDb(routes: FakeRoute[]) {
  const preparedSql: string[] = [];
  const db: SearchableDb = {
    prepare(sql: string) {
      preparedSql.push(sql);
      // Match on the short group key (e.g. "mad:search:emails"), a substring of
      // BOTH the SELECT marker (`.../* mad:search:emails */`) and the COUNT
      // marker (`.../* mad:search:emails:count */`), so one route feeds both.
      const route = routes.find((r) => sql.includes(r.marker));
      return {
        all: (..._params: unknown[]) => route?.rows ?? [],
        get: (..._params: unknown[]) =>
          route ? { total: route.count ?? (route.rows?.length ?? 0) } : { total: 0 },
      };
    },
  };
  return { db, preparedSql };
}

describe("escapeLike", () => {
  it("escapes backslash, percent and underscore", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c\\d")).toBe("c\\\\d");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("buildContactQuery", () => {
  it("scopes by transaction_contacts and matches name/email/phone", () => {
    const q = buildContactQuery(TXN, "john", 20);
    expect(q.sql).toContain("FROM transaction_contacts tc");
    expect(q.sql).toContain("tc.transaction_id = ?");
    expect(q.sql).toContain("c.display_name LIKE ? ESCAPE");
    expect(q.sql).toContain("ce.email LIKE ? ESCAPE");
    expect(q.sql).toContain("cp.phone_normalized LIKE ? ESCAPE");
    // First param is the transaction id (the scoping key); last is the limit.
    expect(q.params[0]).toBe(TXN);
    expect(q.params[q.params.length - 1]).toBe(20);
    expect(q.params).toContain("%john%");
  });

  it("normalizes phone queries to the last-10-digit lookup key", () => {
    const q = buildContactQuery(TXN, "(415) 555-1234", 20);
    // phoneKey param and phone pattern use the normalized digits.
    expect(q.params).toContain("4155551234");
    expect(q.params).toContain("%4155551234%");
  });

  it("does not phone-match when the query has no digits (empty key guard)", () => {
    const q = buildContactQuery(TXN, "john", 20);
    // The empty-string guard param prevents `LIKE %%` matching every phone.
    expect(q.params).toContain("");
  });
});

describe("buildEmailQuery", () => {
  it("joins the communications junction and matches subject/body/sender/recipients", () => {
    const q = buildEmailQuery(TXN, "escrow", 20);
    expect(q.sql).toContain("JOIN communications comm ON comm.email_id = e.id");
    expect(q.sql).toContain("comm.transaction_id = ?");
    expect(q.sql).toContain("e.subject LIKE ? ESCAPE");
    expect(q.sql).toContain("e.body_plain LIKE ? ESCAPE");
    expect(q.sql).toContain("e.sender LIKE ? ESCAPE");
    expect(q.sql).toContain("e.recipients LIKE ? ESCAPE");
    expect(q.params[0]).toBe(TXN);
    expect(q.params).toContain("%escrow%");
  });
});

describe("buildTextQuery", () => {
  it("scopes to communications (message_id or thread batch) and sms/imessage only", () => {
    const q = buildTextQuery(TXN, "closing", 20);
    expect(q.sql).toContain("m.channel IN ('sms', 'imessage')");
    expect(q.sql).toContain("comm.transaction_id = ?");
    expect(q.sql).toContain("comm2.thread_id = m2.thread_id");
    expect(q.sql).toContain("m.body_text LIKE ? ESCAPE");
    expect(q.sql).toContain("m.participants_flat LIKE ? ESCAPE");
    // Transaction id is bound twice (direct + thread-batch subqueries).
    expect(q.params.filter((p) => p === TXN)).toHaveLength(2);
  });
});

describe("searchLinkedContent", () => {
  it("returns empty groups and never touches the DB for an empty/whitespace query", () => {
    const { db, preparedSql } = makeFakeDb([]);
    const spy = jest.spyOn(db, "prepare");

    const blank = searchLinkedContent(db, TXN, "   ");

    expect(blank.contacts).toEqual({ items: [], total: 0 });
    expect(blank.emails).toEqual({ items: [], total: 0 });
    expect(blank.texts).toEqual({ items: [], total: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(preparedSql).toHaveLength(0);
  });

  it("returns ONLY rows linked to the given transaction (unlinked matching email excluded)", () => {
    // The fake returns exactly what the transaction-scoped query would return.
    // An unlinked-but-matching email exists in the wider DB but is NOT wired into
    // the email route, mirroring the JOIN excluding it.
    const linkedEmail = {
      id: "email-linked",
      subject: "Escrow instructions",
      sender: "agent@x.com",
      sentAt: "2026-01-02T00:00:00Z",
      snippet: "escrow details",
    };
    const { db, preparedSql } = makeFakeDb([
      { marker: "mad:search:emails", rows: [linkedEmail], count: 1 },
    ]);

    const res = searchLinkedContent(db, TXN, "escrow");

    // Only the linked email comes back.
    expect(res.emails.items.map((e) => e.id)).toEqual(["email-linked"]);
    expect(res.emails.items.map((e) => e.id)).not.toContain("email-unlinked");

    // And the scoping is real: the executed email SELECT is gated by the junction
    // with the transaction id bound as the first parameter.
    const emailSelect = preparedSql.find(
      (s) => s.includes("/* mad:search:emails */") && s.includes("SELECT e.id"),
    );
    expect(emailSelect).toContain("JOIN communications comm");
    expect(emailSelect).toContain("comm.transaction_id = ?");
  });

  it("groups results by type with per-group totals that can exceed returned items", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:contacts",
        rows: [{ contactId: "c1", displayName: "John Doe", role: "Buyer" }],
        count: 1,
      },
      {
        marker: "mad:search:emails",
        rows: [
          { id: "e1", subject: "Hi", sender: "a@x.com", sentAt: null, snippet: "b" },
          { id: "e2", subject: "Re: Hi", sender: "b@x.com", sentAt: null, snippet: "c" },
        ],
        count: 7, // more matches than returned items ⇒ total reflects the count query
      },
      {
        marker: "mad:search:texts",
        rows: [
          {
            id: "m1",
            body_text: "on my way to closing",
            participants_flat: "+15551234567, +15559998888",
            sentAt: null,
          },
        ],
        count: 1,
      },
    ]);

    const res = searchLinkedContent(db, TXN, "hi");

    expect(res.contacts.items).toEqual([
      { contactId: "c1", displayName: "John Doe", role: "Buyer" },
    ]);
    expect(res.contacts.total).toBe(1);

    expect(res.emails.items).toHaveLength(2);
    expect(res.emails.total).toBe(7);

    // Text shaping: sender is the first participant token; snippet from body_text.
    expect(res.texts.items).toEqual([
      { id: "m1", sender: "+15551234567", snippet: "on my way to closing", sentAt: null },
    ]);
    expect(res.texts.total).toBe(1);
  });

  it("respects a custom per-group limit", () => {
    const { preparedSql, db } = makeFakeDb([
      { marker: "mad:search:emails", rows: [], count: 0 },
    ]);
    searchLinkedContent(db, TXN, "x", { limit: 5 });
    const emailSelect = preparedSql.find(
      (s) => s.includes("/* mad:search:emails */") && s.includes("SELECT e.id"),
    );
    expect(emailSelect).toContain("LIMIT ?");
    // The email SELECT's last bound param is the limit; assert via a fresh build.
    const built = buildEmailQuery(TXN, "x", 5);
    expect(built.params[built.params.length - 1]).toBe(5);
  });

  it("escapes SQL LIKE wildcards (% and _) in the query", () => {
    // A query containing % and _ must be matched literally, not as wildcards.
    const built = buildEmailQuery(TXN, "50%_x", 20);
    expect(built.params).toContain("%50\\%\\_x%");
    // ESCAPE clause is present so the backslash escapes are honored.
    expect(built.sql).toContain("ESCAPE '\\'");
  });
});
