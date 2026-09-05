/**
 * BACKLOG-3044 PR 4 — the date-window builder, pinned on ALL FOUR branches.
 *
 * ## Why four and not one
 *
 * `messagesForPhoneMatchingSql` is the only statement in this PR assembled from a
 * CONDITIONAL fragment. A builder is byte-identical only if every branch is, and
 * testing one branch tests one branch. `sql-move-identity.mjs` renders the
 * interpolation as a marker and so compares the skeleton — it cannot see which text
 * each branch produces, and it would pass on a builder that emitted the wrong clause,
 * the right clause twice, or the two clauses in the wrong order.
 *
 * ## What the pre-move code did, and why the ORDER is a contract
 *
 * The caller accumulated the clause beside its bound values:
 *
 *     if (options?.startDate) { dateFilter += " AND m.sent_at >= ?"; params.push(startDate); }
 *     if (options?.endDate)   { dateFilter += " AND m.sent_at <= ?"; params.push(end); }
 *
 * Clause and value are one contract. If the builder emitted the END clause before the
 * START clause, both statements would still be valid SQL, the skeleton would be
 * unchanged, every other control in this PR would stay green — and the two bound
 * values would be swapped, so the window would run from the end date to the start
 * date and match nothing. This suite is what makes that a failure instead of a bug.
 *
 * The expected strings are GENERATED from the pre-move source at `1ba6557ff` by
 * `.tmp3044d/gen-datefilter-test.mjs` and written in by script. Typing them by hand
 * would let one typo enter both the builder and the fixture and cancel itself out.
 */
import { messagesForPhoneMatchingSql } from "../messageMatchingSql";

describe("BACKLOG-3044 PR 4 — messagesForPhoneMatchingSql is byte-identical on every branch", () => {
  it("neither bound", () => {
    expect(messagesForPhoneMatchingSql({ hasStart: false, hasEnd: false })).toBe(
      "\n    SELECT\n      m.id,\n      m.participants,\n      m.participants_flat,\n      m.direction,\n      m.channel\n    FROM messages m\n    WHERE m.user_id = ?\n      AND m.channel IN ('sms', 'imessage')\n      AND m.duplicate_of IS NULL\n      AND (\n        m.transaction_id IS NULL\n        OR m.transaction_id != ?\n      )\n      AND m.id NOT IN (\n        SELECT message_id FROM communications\n        WHERE transaction_id = ? AND message_id IS NOT NULL\n      )\n      AND m.id NOT IN (\n        SELECT ic.original_communication_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL\n      )\n      AND (m.thread_id IS NULL OR m.thread_id = '' OR m.thread_id NOT IN (\n        SELECT ic.thread_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL\n      ))\n  ",
    );
  });

  it("start only", () => {
    expect(messagesForPhoneMatchingSql({ hasStart: true, hasEnd: false })).toBe(
      "\n    SELECT\n      m.id,\n      m.participants,\n      m.participants_flat,\n      m.direction,\n      m.channel\n    FROM messages m\n    WHERE m.user_id = ?\n      AND m.channel IN ('sms', 'imessage')\n      AND m.duplicate_of IS NULL\n      AND (\n        m.transaction_id IS NULL\n        OR m.transaction_id != ?\n      )\n      AND m.id NOT IN (\n        SELECT message_id FROM communications\n        WHERE transaction_id = ? AND message_id IS NOT NULL\n      )\n      AND m.id NOT IN (\n        SELECT ic.original_communication_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL\n      )\n      AND (m.thread_id IS NULL OR m.thread_id = '' OR m.thread_id NOT IN (\n        SELECT ic.thread_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL\n      )) AND m.sent_at >= ?\n  ",
    );
  });

  it("end only", () => {
    expect(messagesForPhoneMatchingSql({ hasStart: false, hasEnd: true })).toBe(
      "\n    SELECT\n      m.id,\n      m.participants,\n      m.participants_flat,\n      m.direction,\n      m.channel\n    FROM messages m\n    WHERE m.user_id = ?\n      AND m.channel IN ('sms', 'imessage')\n      AND m.duplicate_of IS NULL\n      AND (\n        m.transaction_id IS NULL\n        OR m.transaction_id != ?\n      )\n      AND m.id NOT IN (\n        SELECT message_id FROM communications\n        WHERE transaction_id = ? AND message_id IS NOT NULL\n      )\n      AND m.id NOT IN (\n        SELECT ic.original_communication_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL\n      )\n      AND (m.thread_id IS NULL OR m.thread_id = '' OR m.thread_id NOT IN (\n        SELECT ic.thread_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL\n      )) AND m.sent_at <= ?\n  ",
    );
  });

  it("both bounds", () => {
    expect(messagesForPhoneMatchingSql({ hasStart: true, hasEnd: true })).toBe(
      "\n    SELECT\n      m.id,\n      m.participants,\n      m.participants_flat,\n      m.direction,\n      m.channel\n    FROM messages m\n    WHERE m.user_id = ?\n      AND m.channel IN ('sms', 'imessage')\n      AND m.duplicate_of IS NULL\n      AND (\n        m.transaction_id IS NULL\n        OR m.transaction_id != ?\n      )\n      AND m.id NOT IN (\n        SELECT message_id FROM communications\n        WHERE transaction_id = ? AND message_id IS NOT NULL\n      )\n      AND m.id NOT IN (\n        SELECT ic.original_communication_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL\n      )\n      AND (m.thread_id IS NULL OR m.thread_id = '' OR m.thread_id NOT IN (\n        SELECT ic.thread_id FROM ignored_communications ic\n        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL\n      )) AND m.sent_at >= ? AND m.sent_at <= ?\n  ",
    );
  });

  it("puts the START clause before the END clause when both are present", () => {
    // Named separately from the byte pin above because this is the property whose
    // violation is INVISIBLE: swapping them keeps the SQL valid and the skeleton
    // identical, and silently swaps the two bound values.
    const both = messagesForPhoneMatchingSql({ hasStart: true, hasEnd: true });
    expect(both.indexOf("m.sent_at >= ?")).toBeGreaterThan(-1);
    expect(both.indexOf("m.sent_at >= ?")).toBeLessThan(both.indexOf("m.sent_at <= ?"));
  });

  it("emits each clause at most once", () => {
    const both = messagesForPhoneMatchingSql({ hasStart: true, hasEnd: true });
    expect(both.match(/m\.sent_at >= \?/g)).toHaveLength(1);
    expect(both.match(/m\.sent_at <= \?/g)).toHaveLength(1);
  });
});
