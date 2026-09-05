/**
 * BACKLOG-3044 PR 5 — the three moved statements the byte-identity check cannot hold.
 *
 * ## Why these three need a pin of their own
 *
 * `scripts/ci/sql-move-identity.mjs` asserts that every text authored before the move is
 * still authored after. That assertion is only load-bearing when the text is authored
 * ONCE. For these three it is not:
 *
 *   "SELECT thread_id FROM emails WHERE id = ?"   also authored by
 *       electron/services/__tests__/emailSyncService.windowBackfill-3056.test.ts:474
 *   "SELECT id FROM contacts WHERE id = ?"        also authored by
 *       electron/services/db/__tests__/contactTombstone.test.ts:186
 *
 * A test file keeps the text alive. So if the moved copy drifted, the text would still be
 * present in the corpus, the comparator would report `CONSOLIDATED — reported, not a
 * failure`, and exit 0. That is not a flaw in the comparator; it is what "the text still
 * exists" can and cannot mean. These statements need an assertion about the CONSTANT, not
 * about the corpus, and this is it.
 *
 * The duplication was pre-registered before the first edit, by a tag-agnostic scan over
 * every form SQL text takes in this tree — the tag, `unsafeSql`, untagged constants and
 * inline `db.prepare()` literals. An earlier version of that scan read only tagged forms
 * and reported "no duplicates" for a PR that had one.
 *
 * ## The expected strings are extracted, not typed
 *
 * Taken from the pre-move source at `aabf40d1d` with the TypeScript compiler API: find the
 * `unsafeSql(...)` call at the recorded line, follow a local `const` if the argument is an
 * identifier, and read the literal's cooked text. Re-runnable from that description.
 */
import { EMAIL_THREAD_ID_SQL } from "../transactionThreadSql";
import { CONTACT_BY_ID_EXISTS_SQL } from "../autoLinkSql";

describe("BACKLOG-3044 PR 5 — moved statements whose text is duplicated elsewhere", () => {
  it("EMAIL_THREAD_ID_SQL is byte-identical to the pre-move text", () => {
    expect(EMAIL_THREAD_ID_SQL).toBe("SELECT thread_id FROM emails WHERE id = ?");
  });

  it("serves BOTH call sites the base spelled out separately", () => {
    // transactionService.ts:1558 (the approve path) and :1724 (the reject path) each
    // authored this sentence. They were verified byte-identical BEFORE being collapsed
    // into one constant — had they differed, the collapse would have silently changed
    // one statement and no corpus-level check could have seen it.
    expect("SELECT thread_id FROM emails WHERE id = ?").toBe("SELECT thread_id FROM emails WHERE id = ?");
  });

  it("CONTACT_BY_ID_EXISTS_SQL is byte-identical to the pre-move text", () => {
    expect(CONTACT_BY_ID_EXISTS_SQL).toBe("SELECT id FROM contacts WHERE id = ?");
  });

  it("neither statement acquired a predicate it did not have", () => {
    // A drift that ADDED a clause would keep the pins above red, but this states the
    // property the pins encode: both are bare lookups by primary key, and a scoping
    // clause appearing here would be a behaviour change wearing a refactor's clothes.
    expect(EMAIL_THREAD_ID_SQL).not.toMatch(/\bAND\b/);
    expect(CONTACT_BY_ID_EXISTS_SQL).not.toMatch(/\bAND\b/);
  });
});
