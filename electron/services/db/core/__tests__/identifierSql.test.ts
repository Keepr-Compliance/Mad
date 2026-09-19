/**
 * BACKLOG-3102 PR 2 — the identifier builder's alphabet is the brand's alphabet.
 *
 * ## Why the sweep is a sweep and not a sample
 *
 * The first draft of this design enumerated 37 characters — lowercase, digits,
 * underscore — and proved "totality" with `satisfies Record<IdentChar, SafeSql>`.
 * That proves totality over **a set someone picked by hand**, not over the pattern
 * the brand actually enforces. `STAGING_NAME_PATTERN`'s suffix class is
 * `[A-Za-z0-9_]`, which admits UPPERCASE. A name `checkedStagingTable` accepts
 * would have thrown inside the builder — latent only because today's generator
 * emits lowercase.
 *
 * A sample of "a few characters from each class" would not have caught that, and
 * neither would re-reading the regex, which is how it was missed. So the oracle
 * below is the LIVE `checkedStagingTable`, driven over every code point, and the
 * assertion runs in BOTH directions:
 *
 *   - a character the brand admits and the builder rejects → a name that passes
 *     validation and then throws at the point of use;
 *   - a character the builder admits and the brand rejects → the builder is wider
 *     than the thing it is supposed to mirror, which is the security property.
 *
 * Neither module's alphabet is written down here. Both are interrogated.
 */
import { stagingTableSql } from "../identifierSql";
import { STAGING_PREFIX, checkedStagingTable, type StagingTableName } from "../../stagingDdlSql";

type Kind = "email-recache" | "message-import";
const KINDS: readonly Kind[] = ["email-recache", "message-import"];

/** A one-character suffix isolates `ch` as the only thing either side can reject. */
const nameWith = (kind: Kind, ch: string): string => `${STAGING_PREFIX[kind]}0_${ch}`;

/** THE ORACLE — the real validator, not a copy of its pattern. */
function brandAccepts(kind: Kind, ch: string): boolean {
  try {
    checkedStagingTable(nameWith(kind, ch), kind);
    return true;
  } catch {
    return false;
  }
}

/** The builder, interrogated through its public surface. The forged brand here is
 * the whole point: this is exactly the route a hostile name would take. */
function builderAccepts(kind: Kind, ch: string): boolean {
  try {
    stagingTableSql(nameWith(kind, ch) as unknown as StagingTableName);
    return true;
  } catch {
    return false;
  }
}

const ALL_CODE_POINTS: readonly string[] = Array.from({ length: 0x10000 }, (_, cp) =>
  String.fromCharCode(cp),
);

describe("BACKLOG-3102 — the builder's alphabet equals the brand's, swept not sampled", () => {
  it("sweeps a corpus big enough to contain the disagreement (a guard over zero always passes)", () => {
    expect(ALL_CODE_POINTS).toHaveLength(0x10000);
  });

  it.each(KINDS)(
    "%s: every character the pattern admits, the builder admits — and no others",
    (kind) => {
      const brandOnly: string[] = [];
      const builderOnly: string[] = [];
      const admitted: string[] = [];

      for (const ch of ALL_CODE_POINTS) {
        const b = brandAccepts(kind, ch);
        const k = builderAccepts(kind, ch);
        if (b) admitted.push(ch);
        if (b && !k) brandOnly.push(ch);
        if (k && !b) builderOnly.push(ch);
      }

      // Reported as CHARACTER SETS, not counts: a count tells you something
      // diverged, the set tells you what — and "uppercase is missing" is the
      // finding, not "63 !== 37".
      expect({ acceptedByPatternButNotBuilder: brandOnly, acceptedByBuilderButNotPattern: builderOnly }).toEqual({
        acceptedByPatternButNotBuilder: [],
        acceptedByBuilderButNotPattern: [],
      });

      // And the set is non-trivial, so the equality above is not two empty sets
      // agreeing with each other.
      expect(admitted.join("")).toBe(
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz",
      );
      expect(admitted).toHaveLength(63);
    },
  );

  it("admits UPPERCASE — the class the first draft of this builder dropped", () => {
    // Named separately because it is the specific defect this file exists for.
    // Folded into the sweep it would be one silent member of a 63-element set.
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      expect([ch, brandAccepts("email-recache", ch), builderAccepts("email-recache", ch)]).toEqual([
        ch,
        true,
        true,
      ]);
    }
  });

  it("covers every character of every prefix literal, so the union claim is measured", () => {
    // The header argues the suffix class `[A-Za-z0-9_]` is the union because the
    // token class and the prefix literals are subsets of it. That is reasoning;
    // this is the measurement.
    for (const kind of KINDS) {
      for (const ch of STAGING_PREFIX[kind]) {
        expect([kind, ch, builderAccepts(kind, ch)]).toEqual([kind, ch, true]);
      }
    }
    for (const ch of "0123456789abcdef") {
      expect([ch, builderAccepts("email-recache", ch)]).toEqual([ch, true]);
    }
  });
});

describe("the forged name cannot be laundered — it throws, it is not quoted around", () => {
  /**
   * THE REASON THIS MODULE EXISTS.
   *
   * `checkedStagingTable` mints the brand with `return name as StagingTableName`.
   * That assertion names neither `SafeSql` nor `unsafeSql`, so no escape counter
   * and no seam guard sees it — anyone can write the cast below. Under the
   * rejected design (`unsafeSql(`"${name}"`)`) this value would become `SafeSql`
   * silently. Here there is nothing to assert: `"` and `;` have no map entry.
   */
  const FORGED = 'x" ; DROP TABLE emails --' as unknown as StagingTableName;

  it("THROWS on the forged staging name rather than returning SQL", () => {
    expect(() => stagingTableSql(FORGED)).toThrow(/Illegal character/);
  });

  it("names the offending character, so the failure is actionable", () => {
    expect(() => stagingTableSql(FORGED)).toThrow(/"\\""/);
  });

  it.each([
    ['a double quote closes the identifier', 'staging_emailrecache_0_a"b'],
    ["a semicolon starts a second statement", "staging_emailrecache_0_a;b"],
    ["a space starts a second token", "staging_emailrecache_0_a b"],
    ["a hyphen starts a comment", "staging_emailrecache_0_a--b"],
    ["a backtick is MySQL quoting", "staging_emailrecache_0_a`b"],
    ["a NUL byte truncates C-string readers", "staging_emailrecache_0_a\u0000b"],
    ["a newline hides the tail from a one-line log", "staging_emailrecache_0_a\nb"],
  ])("refuses %s", (_why, name) => {
    expect(() => stagingTableSql(name as unknown as StagingTableName)).toThrow(
      /Illegal character/,
    );
  });
});

describe("byte-identity — the builder emits what the template literal emitted", () => {
  /**
   * Before this module, every call site wrote `` `"${stagingTable}"` ``. If the
   * builder produced an equivalent-but-different string — a different quoting
   * style, a stripped character, a normalised case — it would be a silent data
   * change on the path that reads and deletes the user's mail, not a type change.
   *
   * Asserted over EVERY admitted character rather than a sample name, so a single
   * map entry emitting the wrong character is caught wherever it sits.
   */
  it("emits exactly '\"' + name + '\"' for a name built from every admitted character", () => {
    const everyChar = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
    const name = `${STAGING_PREFIX["email-recache"]}0_${everyChar}`;
    const checked = checkedStagingTable(name, "email-recache");
    expect(stagingTableSql(checked)).toBe(`"${name}"`);
  });

  it("emits the real generated shape unchanged", () => {
    const checked = checkedStagingTable(
      `${STAGING_PREFIX["email-recache"]}0123456789ab_emails`,
      "email-recache",
    );
    expect(stagingTableSql(checked)).toBe('"staging_emailrecache_0123456789ab_emails"');
  });

  it("is a plain string at runtime — the brand is compile-time only", () => {
    const checked = checkedStagingTable(
      `${STAGING_PREFIX["message-import"]}deadbeef_messages`,
      "message-import",
    );
    expect(typeof stagingTableSql(checked)).toBe("string");
  });
});
