/**
 * BACKLOG-3085 — the three fragment PRODUCERS that stopped being `string`, held
 * against text transcribed from the pre-conversion tree.
 *
 * `reactionExclusion` and `activeContactsClause` are spliced into statements all over
 * `db/` and, for `reactionExclusion`, into four statements OUTSIDE it that belong to
 * BACKLOG-3044. Converting them to produce `SafeSql` changed how they are BUILT — a
 * closed alias map and, for the reaction band, two numbers restated as SQL — so
 * "they still emit the same characters" is a claim that has to be measured, not
 * asserted in a PR body.
 *
 * The expected strings below are TRANSCRIBED from the tree at `da4953fe6`, before any
 * edit. They are deliberately written out in full rather than composed from the
 * constants: a test that rebuilt its expectation the way the code does would pass
 * whatever the code did.
 */
import {
  REACTION_TYPE_BAND_MIN,
  REACTION_TYPE_BAND_MAX,
} from "../../../utils/reactionUtils";
import {
  ACTIVE_CONTACTS_CLAUSE_C,
  ACTIVE_CONTACTS_CLAUSE_UNALIASED,
  activeContactsClause,
} from "../contactTombstoneSql";
import { LOCAL_REACTION_EXCLUSION, reactionExclusion } from "../reactionExclusion";

describe("reactionExclusion emits the characters it emitted before the brand", () => {
  it("matches the transcribed text for every alias in the closed set", () => {
    expect(reactionExclusion("m")).toBe(
      "(m.associated_message_type IS NULL OR m.associated_message_type NOT BETWEEN 2000 AND 3005)",
    );
    expect(reactionExclusion("m2")).toBe(
      "(m2.associated_message_type IS NULL OR m2.associated_message_type NOT BETWEEN 2000 AND 3005)",
    );
    expect(reactionExclusion()).toBe(
      "(associated_message_type IS NULL OR associated_message_type NOT BETWEEN 2000 AND 3005)",
    );
    expect(LOCAL_REACTION_EXCLUSION).toBe(reactionExclusion());
  });

  /**
   * THE CHECKED DUPLICATION. The band is stated twice — once as numbers in
   * `reactionUtils` for the JavaScript-side test, once as SQL text in
   * `reactionExclusion.ts` because the tag refuses to splice a number. This is what
   * holds them equal, so changing one and not the other is a red test rather than a
   * filter that silently stops matching what `isReaction()` matches.
   */
  it("keeps the SQL band equal to the numeric band", () => {
    expect(reactionExclusion("m")).toContain(
      `NOT BETWEEN ${REACTION_TYPE_BAND_MIN} AND ${REACTION_TYPE_BAND_MAX}`,
    );
  });
});

describe("the contact tombstone clauses are unchanged text", () => {
  it("matches the transcribed text", () => {
    expect(activeContactsClause("c")).toBe(" AND c.removed_at IS NULL");
    expect(ACTIVE_CONTACTS_CLAUSE_C).toBe(" AND c.removed_at IS NULL");
    expect(ACTIVE_CONTACTS_CLAUSE_UNALIASED).toBe(" AND removed_at IS NULL");
  });

  /**
   * The leading space is load-bearing: every call site appends this onto an existing
   * `WHERE`, so losing it produces `... = 1AND c.removed_at IS NULL`. Asserted on its
   * own because a whitespace change is exactly what a reformat would make and exactly
   * what a `.trim()` in a future helper would make.
   */
  it("keeps the leading space the call sites depend on", () => {
    expect(ACTIVE_CONTACTS_CLAUSE_C.startsWith(" AND")).toBe(true);
    expect(ACTIVE_CONTACTS_CLAUSE_UNALIASED.startsWith(" AND")).toBe(true);
  });
});
