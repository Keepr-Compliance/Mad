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
  buildTransactionsQuery,
  buildGlobalContactQuery,
  buildGlobalEmailQuery,
  buildGlobalTextQuery,
  buildUnattachedEmailQuery,
  buildUnattachedTextQuery,
  searchGlobalContent,
  type SearchableDb,
} from "./transactionSearchDbService";

const TXN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

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
    const q = buildContactQuery(TXN, "(415) 555-0109", 20);
    // phoneKey param and phone pattern use the normalized digits.
    expect(q.params).toContain("4155550109");
    expect(q.params).toContain("%4155550109%");
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
    // Phase 1.5: params[0] is the matched-attachment projection pattern; the
    // transaction scope key follows it.
    expect(q.params[1]).toBe(TXN);
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
            participants_flat: "+15555550112, +15555550120",
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
      { id: "m1", sender: "+15555550112", snippet: "on my way to closing", sentAt: null },
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

// ===========================================================================
// BACKLOG-1870: ATTACHMENT FILENAME SEARCH
// ===========================================================================
// A filename token (e.g. "wire", "disclosure") must surface the containing
// email/text even when the word appears ONLY in an attachment's name.

describe("BACKLOG-1870: attachment filename matching (query builders)", () => {
  it("buildEmailQuery matches attachments.filename joined by email_id", () => {
    const q = buildEmailQuery(TXN, "wire", 20);
    expect(q.sql).toContain("FROM attachments a");
    expect(q.sql).toContain("a.email_id = e.id");
    expect(q.sql).toContain("a.filename LIKE ? ESCAPE");
    // 1 projection (Phase 1.5) + subject/body/sender/recipients/filename = six.
    expect(q.params.filter((p) => p === "%wire%")).toHaveLength(6);
    // The COUNT query has NO projection: subject/body/sender/recipients/filename = five.
    expect(q.countSql).toContain("a.filename LIKE ? ESCAPE");
    expect(q.countParams.filter((p) => p === "%wire%")).toHaveLength(5);
  });

  it("buildTextQuery matches attachments.filename by message_id or external_message_id", () => {
    const q = buildTextQuery(TXN, "receipt", 20);
    expect(q.sql).toContain("a.message_id = m.id");
    expect(q.sql).toContain("a.external_message_id = m.external_id");
    expect(q.sql).toContain("a.filename LIKE ? ESCAPE");
    // 1 projection (Phase 1.5) + body_text/participants_flat/filename = four.
    expect(q.params.filter((p) => p === "%receipt%")).toHaveLength(4);
  });

  it("buildGlobalEmailQuery adds the attachment predicate to both SELECT and COUNT", () => {
    const q = buildGlobalEmailQuery(USER, "disclosure", 20);
    expect(q.sql).toContain("a.email_id = e.id");
    expect(q.sql).toContain("a.filename LIKE ? ESCAPE");
    expect(q.countSql).toContain("a.filename LIKE ? ESCAPE");
    // 1 projection + 5 match patterns; the COUNT has no projection (5).
    expect(q.params.filter((p) => p === "%disclosure%")).toHaveLength(6);
    expect(q.countParams.filter((p) => p === "%disclosure%")).toHaveLength(5);
  });

  it("buildGlobalTextQuery adds the attachment predicate", () => {
    const q = buildGlobalTextQuery(USER, "settlement", 20);
    expect(q.sql).toContain("a.message_id = m.id");
    expect(q.sql).toContain("a.filename LIKE ? ESCAPE");
    // 1 projection + body_text/participants_flat/filename = four.
    expect(q.params.filter((p) => p === "%settlement%")).toHaveLength(4);
  });

  it("buildUnattachedEmailQuery / buildUnattachedTextQuery also match filenames", () => {
    const e = buildUnattachedEmailQuery(USER, "addendum", 20);
    expect(e.sql).toContain("a.email_id = e.id");
    expect(e.sql).toContain("a.filename LIKE ? ESCAPE");
    expect(e.params.filter((p) => p === "%addendum%")).toHaveLength(5);

    const t = buildUnattachedTextQuery(USER, "photo", 20);
    expect(t.sql).toContain("a.message_id = m.id");
    expect(t.sql).toContain("a.filename LIKE ? ESCAPE");
    expect(t.params.filter((p) => p === "%photo%")).toHaveLength(3);
  });

  it("escapes LIKE wildcards in the attachment predicate too", () => {
    const q = buildEmailQuery(TXN, "50%_x", 20);
    // Every bound filename pattern (projection + filter clauses) is escaped.
    expect(q.params.filter((p) => p === "%50\\%\\_x%")).toHaveLength(6);
  });
});

describe("BACKLOG-1870 Phase 1.5: matched-attachment filename projection", () => {
  it("email/text builders project matched filenames via group_concat, binding the pattern first", () => {
    const e = buildEmailQuery(TXN, "wire", 20);
    expect(e.sql).toContain("group_concat(a.filename, char(10))");
    expect(e.sql).toContain("AS matchedAttachments");
    // Projection pattern is the FIRST bound param (SELECT precedes WHERE).
    expect(e.params[0]).toBe("%wire%");
    // The COUNT query does NOT carry the projection.
    expect(e.countSql).not.toContain("matchedAttachments");

    const t = buildTextQuery(TXN, "receipt", 20);
    expect(t.sql).toContain("group_concat(a.filename, char(10))");
    expect(t.sql).toContain("AS matchedAttachments");
    expect(t.params[0]).toBe("%receipt%");

    const ge = buildGlobalEmailQuery(USER, "wire", 20);
    expect(ge.sql).toContain("AS matchedAttachments");
    expect(ge.params[0]).toBe("%wire%");
    expect(ge.countSql).not.toContain("matchedAttachments");

    const gt = buildGlobalTextQuery(USER, "wire", 20);
    expect(gt.sql).toContain("AS matchedAttachments");
    expect(gt.params[0]).toBe("%wire%");
  });

  it("scoped: returns the matched filename(s) on the email hit (de-duped, cap 5)", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:emails",
        rows: [
          {
            id: "e-wire",
            subject: "Closing docs",
            sender: "agent@x.com",
            sentAt: "2026-01-02T00:00:00Z",
            snippet: "see attached",
            // group_concat blob: newline-separated, with a duplicate to prove de-dup.
            matchedAttachments: "wire-instructions.pdf\nwire-instructions.pdf",
          },
        ],
        count: 1,
      },
    ]);

    const res = searchLinkedContent(db, TXN, "wire");
    expect(res.emails.items).toHaveLength(1);
    expect(res.emails.items[0].matchedAttachmentFilenames).toEqual([
      "wire-instructions.pdf",
    ]);
  });

  it("scoped: omits the field when the match was subject/body-only (NULL projection)", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:emails",
        rows: [
          {
            id: "e-subject",
            subject: "wire transfer confirmation",
            sender: "bank@x.com",
            sentAt: "2026-01-02T00:00:00Z",
            snippet: "done",
            matchedAttachments: null, // no attachment matched the term
          },
        ],
        count: 1,
      },
    ]);

    const res = searchLinkedContent(db, TXN, "wire");
    expect(res.emails.items[0].matchedAttachmentFilenames).toBeUndefined();
  });

  it("scoped: returns the matched filename(s) on the text hit", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:texts",
        rows: [
          {
            id: "m-photo",
            body_text: "here you go",
            participants_flat: "+15555550112",
            sentAt: "2026-01-03T00:00:00Z",
            matchedAttachments: "IMG_2201.heic",
          },
        ],
        count: 1,
      },
    ]);

    const res = searchLinkedContent(db, TXN, "IMG_2201");
    expect(res.texts.items[0].matchedAttachmentFilenames).toEqual([
      "IMG_2201.heic",
    ]);
  });

  it("global: returns matched filename(s) on email + text hits", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:emails",
        rows: [
          {
            id: "e-wire",
            subject: "Docs",
            sender: "a@x.com",
            sentAt: "2026-02-01",
            snippet: "b",
            matchedAttachments: "wire.pdf\ndeed.pdf",
            attrTxnId: "t1",
            attrAddress: "123 Main St",
          },
        ],
        count: 1,
      },
      {
        marker: "mad:search:texts",
        rows: [
          {
            id: "m-photo",
            body_text: "pic",
            participants_flat: "+15555550112",
            sentAt: "2026-02-02",
            matchedAttachments: "photo.jpg",
            attrTxnId: "t1",
            attrAddress: "123 Main St",
          },
        ],
        count: 1,
      },
    ]);

    const res = searchGlobalContent(db, USER, "wire");
    expect(res.emails.items[0].matchedAttachmentFilenames).toEqual([
      "wire.pdf",
      "deed.pdf",
    ]);
    expect(res.texts.items[0].matchedAttachmentFilenames).toEqual(["photo.jpg"]);
  });
});

describe("BACKLOG-1870: attachment filename matching (integration)", () => {
  it("scoped: a filename-only match surfaces the containing email (exact id)", () => {
    // The email's subject/body do NOT contain "wire"; only its attachment does.
    // The fake db returns that email for the email route, mirroring the EXISTS join.
    const emailHitByFilename = {
      id: "email-with-wire-pdf",
      subject: "Closing docs",
      sender: "agent@x.com",
      sentAt: "2026-01-02T00:00:00Z",
      snippet: "see attached",
    };
    const { db, preparedSql } = makeFakeDb([
      { marker: "mad:search:emails", rows: [emailHitByFilename], count: 1 },
    ]);

    const res = searchLinkedContent(db, TXN, "wire");

    expect(res.emails.items.map((e) => e.id)).toEqual(["email-with-wire-pdf"]);
    // The executed email SELECT actually probes attachments.filename.
    const emailSelect = preparedSql.find(
      (s) => s.includes("/* mad:search:emails */") && s.includes("SELECT e.id"),
    );
    expect(emailSelect).toContain("a.filename LIKE ? ESCAPE");
    expect(emailSelect).toContain("a.email_id = e.id");
  });

  it("scoped: a filename-only match surfaces the containing text (exact id)", () => {
    const textHitByFilename = {
      id: "msg-with-photo",
      body_text: "here you go",
      participants_flat: "+15555550112",
      sentAt: "2026-01-03T00:00:00Z",
    };
    const { db, preparedSql } = makeFakeDb([
      { marker: "mad:search:texts", rows: [textHitByFilename], count: 1 },
    ]);

    const res = searchLinkedContent(db, TXN, "IMG_2201");

    expect(res.texts.items.map((t) => t.id)).toEqual(["msg-with-photo"]);
    const textSelect = preparedSql.find(
      (s) => s.includes("/* mad:search:texts */") && s.includes("SELECT m.id"),
    );
    expect(textSelect).toContain("a.filename LIKE ? ESCAPE");
  });

  it("global: a filename-only match surfaces the containing email with attribution", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:emails",
        rows: [
          {
            id: "e-wire",
            subject: "Docs",
            sender: "a@x.com",
            sentAt: "2026-02-01",
            snippet: "b",
            attrTxnId: "t1",
            attrAddress: "123 Main St",
          },
        ],
        count: 1,
      },
    ]);

    const res = searchGlobalContent(db, USER, "wire");

    expect(res.emails.items.map((e) => e.id)).toEqual(["e-wire"]);
    expect(res.emails.items[0].attribution).toEqual({
      transactionId: "t1",
      propertyAddress: "123 Main St",
    });
  });
});

// ===========================================================================
// BACKLOG-1876: GLOBAL (UNSCOPED) SEARCH
// ===========================================================================

describe("scoped builders are byte-unchanged (BACKLOG-1866 non-regression)", () => {
  // These snapshots pin the exact scoped SQL/params so the generalization work
  // for BACKLOG-1876 cannot silently regress the single-transaction queries.
  it("buildContactQuery is stable", () => {
    const q = buildContactQuery(TXN, "john", 20);
    expect({
      sql: q.sql,
      countSql: q.countSql,
      params: q.params,
      countParams: q.countParams,
    }).toMatchSnapshot();
  });

  it("buildEmailQuery is stable", () => {
    const q = buildEmailQuery(TXN, "escrow", 20);
    expect({
      sql: q.sql,
      countSql: q.countSql,
      params: q.params,
      countParams: q.countParams,
    }).toMatchSnapshot();
  });

  it("buildTextQuery is stable", () => {
    const q = buildTextQuery(TXN, "closing", 20);
    expect({
      sql: q.sql,
      countSql: q.countSql,
      params: q.params,
      countParams: q.countParams,
    }).toMatchSnapshot();
  });
});

describe("buildTransactionsQuery", () => {
  it("matches property_address AND linked contact display_name, user-scoped", () => {
    const q = buildTransactionsQuery(USER, "main", 20);
    expect(q.sql).toContain("FROM transactions t");
    // BACKLOG-2366: the tombstone filter sits in the ON clause, not the WHERE.
    // In the WHERE it would turn this LEFT JOIN into an inner one for any
    // transaction whose only party had been removed, so that transaction would
    // stop matching on property_address too — a party edit silently breaking
    // address search.
    expect(q.sql).toContain("LEFT JOIN transaction_contacts tc");
    expect(q.sql).toContain("ON tc.transaction_id = t.id AND tc.removed_at IS NULL");
    expect(q.sql).toContain("LEFT JOIN contacts c ON c.id = tc.contact_id");
    expect(q.sql).toContain("t.user_id = ?");
    expect(q.sql).toContain("t.property_address LIKE ? ESCAPE");
    expect(q.sql).toContain("c.display_name LIKE ? ESCAPE");
    expect(q.countSql).toContain("COUNT(DISTINCT t.id)");
    // First param is the user scope key; last is the limit.
    expect(q.params[0]).toBe(USER);
    expect(q.params[q.params.length - 1]).toBe(20);
    expect(q.params).toContain("%main%");
  });
});

describe("buildGlobalEmailQuery", () => {
  it("attributes to the primary (earliest-linked) transaction via correlated subquery", () => {
    const q = buildGlobalEmailQuery(USER, "escrow", 20);
    expect(q.sql).toContain("t.property_address AS attrAddress");
    expect(q.sql).toContain("JOIN transactions t ON t.id = comm.transaction_id");
    // Deterministic tie-break: earliest linked_at, then id.
    expect(q.sql).toContain("ORDER BY c2.linked_at ASC, c2.id ASC");
    expect(q.sql).toContain("e.user_id = ?");
    // Count only over emails linked to some transaction.
    expect(q.countSql).toContain("COUNT(DISTINCT e.id)");
    expect(q.countSql).toContain("comm.transaction_id IS NOT NULL");
    // Phase 1.5: params[0] is the matched-attachment projection pattern; user scope follows.
    expect(q.params[1]).toBe(USER);
    expect(q.params).toContain("%escrow%");
  });

  it("escapes LIKE wildcards in the query", () => {
    const q = buildGlobalEmailQuery(USER, "50%_x", 20);
    expect(q.params).toContain("%50\\%\\_x%");
    expect(q.sql).toContain("ESCAPE '\\'");
  });
});

describe("buildGlobalTextQuery", () => {
  it("uses a ROW_NUMBER window over the UNION-ed linkage set (no duplicated thread predicate)", () => {
    const q = buildGlobalTextQuery(USER, "closing", 20);
    expect(q.sql).toContain("ROW_NUMBER() OVER");
    expect(q.sql).toContain("PARTITION BY ml.msg_id");
    // Deterministic tie-break: earliest linked_at, then comm id.
    expect(q.sql).toContain("ORDER BY ml.linked_at ASC, ml.comm_id ASC");
    expect(q.sql).toContain("UNION ALL");
    expect(q.sql).toContain("m.channel IN ('sms', 'imessage')");
    expect(q.sql).toContain("m.user_id = ?");
    expect(q.sql).toContain("m.body_text LIKE ? ESCAPE");
    expect(q.sql).toContain("m.participants_flat LIKE ? ESCAPE");
    // Phase 1.5: params[0] is the matched-attachment projection pattern; user scope follows.
    expect(q.params[1]).toBe(USER);
    expect(q.params[q.params.length - 1]).toBe(20);
  });
});

describe("buildGlobalContactQuery", () => {
  it("matches name/email/phone (EXISTS, no fan-out) and attributes via ROW_NUMBER", () => {
    const q = buildGlobalContactQuery(USER, "john", 20);
    expect(q.sql).toContain("ROW_NUMBER() OVER");
    expect(q.sql).toContain("PARTITION BY c.id");
    expect(q.sql).toContain("ORDER BY tc.is_primary DESC, tc.created_at ASC, t.id ASC");
    expect(q.sql).toContain("c.user_id = ?");
    expect(q.sql).toContain("c.display_name LIKE ? ESCAPE");
    expect(q.sql).toContain("EXISTS");
    expect(q.sql).toContain("ce.email LIKE ? ESCAPE");
    expect(q.sql).toContain("cp.phone_normalized LIKE ? ESCAPE");
    expect(q.params[0]).toBe(USER);
  });

  it("normalizes phone queries to the last-10-digit lookup key (1866 parity)", () => {
    const q = buildGlobalContactQuery(USER, "(415) 555-0109", 20);
    expect(q.params).toContain("4155550109");
    expect(q.params).toContain("%4155550109%");
  });

  it("disables the phone predicate when the query has no digits (empty-key guard)", () => {
    const q = buildGlobalContactQuery(USER, "john", 20);
    expect(q.params).toContain("");
  });
});

describe("unattached buckets", () => {
  it("buildUnattachedEmailQuery requires NO communications row for the email", () => {
    const q = buildUnattachedEmailQuery(USER, "invoice", 20);
    expect(q.sql).toContain("NOT EXISTS");
    expect(q.sql).toContain("comm.email_id = e.id");
    expect(q.sql).toContain("e.user_id = ?");
    expect(q.params[0]).toBe(USER);
    expect(q.params).toContain("%invoice%");
  });

  it("buildUnattachedTextQuery excludes both direct and thread-batch links", () => {
    const q = buildUnattachedTextQuery(USER, "hi", 20);
    // Two NOT EXISTS clauses: direct message_id link and thread-batch link.
    expect(q.sql.match(/NOT EXISTS/g)?.length).toBe(2);
    expect(q.sql).toContain("comm.message_id = m.id");
    expect(q.sql).toContain("comm3.thread_id = m.thread_id");
    expect(q.sql).toContain("m.channel IN ('sms', 'imessage')");
    expect(q.params[0]).toBe(USER);
  });
});

describe("searchGlobalContent", () => {
  it("returns five empty groups and never touches the DB for an empty query", () => {
    const { db, preparedSql } = makeFakeDb([]);
    const spy = jest.spyOn(db, "prepare");

    const res = searchGlobalContent(db, USER, "   ");

    expect(res.transactions).toEqual({ items: [], total: 0 });
    expect(res.contacts).toEqual({ items: [], total: 0 });
    expect(res.emails).toEqual({ items: [], total: 0 });
    expect(res.texts).toEqual({ items: [], total: 0 });
    expect(res.unattached).toEqual({ items: [], total: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(preparedSql).toHaveLength(0);
  });

  it("groups results, maps transaction attribution, and merges the unattached bucket", () => {
    const { db } = makeFakeDb([
      {
        marker: "mad:search:transactions",
        rows: [{ id: "t1", propertyAddress: "123 Main St" }],
        count: 1,
      },
      {
        marker: "mad:search:contacts",
        rows: [
          {
            contactId: "c1",
            displayName: "John Doe",
            role: "Buyer",
            attrTxnId: "t1",
            attrAddress: "123 Main St",
          },
          {
            contactId: "c2",
            displayName: "Jane Roe",
            role: null,
            attrTxnId: null,
            attrAddress: null,
          },
        ],
        count: 2,
      },
      {
        marker: "mad:search:emails",
        rows: [
          {
            id: "e1",
            subject: "Escrow",
            sender: "a@x.com",
            sentAt: "2026-02-01",
            snippet: "b",
            attrTxnId: "t1",
            attrAddress: "123 Main St",
          },
        ],
        count: 4,
      },
      {
        marker: "mad:search:texts",
        rows: [
          {
            id: "m1",
            body_text: "on my way",
            participants_flat: "+15555550112, +15555550120",
            sentAt: "2026-02-02",
            attrTxnId: "t2",
            attrAddress: "456 Oak Ave",
          },
        ],
        count: 1,
      },
      {
        marker: "mad:search:unattached:emails",
        rows: [
          {
            id: "u-e1",
            subject: "Unlinked",
            sender: "x@y.com",
            sentAt: "2026-03-01",
            snippet: "sn",
          },
        ],
        count: 3,
      },
      {
        marker: "mad:search:unattached:texts",
        rows: [
          {
            id: "u-m1",
            body_text: "unlinked text",
            participants_flat: "+15555550130",
            sentAt: "2026-01-01",
          },
        ],
        count: 2,
      },
    ]);

    const res = searchGlobalContent(db, USER, "escrow");

    // Transactions group
    expect(res.transactions.items).toEqual([
      { id: "t1", propertyAddress: "123 Main St" },
    ]);
    expect(res.transactions.total).toBe(1);

    // Contacts: attribution mapped; null attribution ⇒ null (not attached).
    expect(res.contacts.items[0].attribution).toEqual({
      transactionId: "t1",
      propertyAddress: "123 Main St",
    });
    expect(res.contacts.items[1].attribution).toBeNull();
    expect(res.contacts.total).toBe(2);

    // Emails: attribution + true total > items.
    expect(res.emails.items[0].attribution).toEqual({
      transactionId: "t1",
      propertyAddress: "123 Main St",
    });
    expect(res.emails.total).toBe(4);

    // Texts: sender is first participant token; attribution to the owning txn.
    expect(res.texts.items[0]).toMatchObject({
      id: "m1",
      sender: "+15555550112",
      snippet: "on my way",
      attribution: { transactionId: "t2", propertyAddress: "456 Oak Ave" },
    });

    // Unattached: merged (email + text), total = 3 + 2 = 5, kinds tagged, sorted
    // by sentAt desc (2026-03-01 email before 2026-01-01 text).
    expect(res.unattached.total).toBe(5);
    expect(res.unattached.items.map((u) => `${u.kind}:${u.id}`)).toEqual([
      "email:u-e1",
      "text:u-m1",
    ]);
  });

  it("scopes every group query by the user id", () => {
    const { db, preparedSql } = makeFakeDb([]);
    searchGlobalContent(db, USER, "anything");
    // Every prepared SELECT/COUNT is user-scoped. Transactions/contacts bind USER
    // first; emails/texts bind the Phase-1.5 matched-attachment projection pattern
    // first, then USER — so assert the scope key is bound, not its exact position.
    expect(buildTransactionsQuery(USER, "x", 20).params[0]).toBe(USER);
    expect(buildGlobalContactQuery(USER, "x", 20).params[0]).toBe(USER);
    expect(buildGlobalEmailQuery(USER, "x", 20).params[1]).toBe(USER);
    expect(buildGlobalTextQuery(USER, "x", 20).params[1]).toBe(USER);
    // And the orchestrator did hit the DB (non-empty query).
    expect(preparedSql.length).toBeGreaterThan(0);
  });
});
