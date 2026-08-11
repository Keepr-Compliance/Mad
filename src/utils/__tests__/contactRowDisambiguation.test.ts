/**
 * SIX ROWS WITH ONE NAME MUST BE SIX DISTINGUISHABLE ROWS (BACKLOG-2663)
 *
 * ===========================================================================
 * THE BUG
 * ===========================================================================
 * Searching `whit` in the transaction Add Contacts picker returned three rows
 * reading `Dana Whitlock` and six reading one other real person's name. Every
 * row was a name and a `+ Add`. The gate instruction was "import the Dana with
 * phone 555-0130" and it could not be followed. It blocked the same step three
 * times.
 *
 * ===========================================================================
 * THE ASSERTION SHAPE, AND WHY IT IS SETS AND NOT COUNTS
 * ===========================================================================
 * "Every row got a line" is not the property under test — the property is that
 * NO TWO ROWS IN A GROUP READ THE SAME. A test asserting that six lines exist
 * passes on six copies of the word "Acme". So the six-way cases assert
 * `new Set(lines).size === 6`, which is the literal statement of what the
 * founder could not do.
 *
 * ===========================================================================
 * THE RULE THIS FILE EXISTS TO PIN — AND THE ONE THAT FAILS IT
 * ===========================================================================
 * BACKLOG-2625 solved the same shape for review-queue candidates with
 * `differsFromAColliding`: show a field when it differs from AT LEAST ONE other
 * colliding row. `sixWayFailsUnderTheDiffersFromOneRule` is built so that rule
 * would pass a per-row check and still leave the user stuck — three records at
 * Acme and three at Borden, every organisation "differing from someone", two
 * indistinguishable triples. That case is the reason this module separates the
 * WHOLE GROUP instead.
 */

import { buildRowDisambiguators, type DisambiguableRow } from "../contactRowDisambiguation";

function row(
  id: string,
  name: string,
  extra: Partial<DisambiguableRow> = {},
): DisambiguableRow {
  return { id, display_name: name, ...extra };
}

/** Every disambiguator produced, in the order the rows were given. */
function linesFor(rows: DisambiguableRow[]): (string | undefined)[] {
  const map = buildRowDisambiguators(rows);
  return rows.map((r) => map.get(r.id));
}

describe("buildRowDisambiguators", () => {
  /**
   * CONTROL 6 — THE REGRESSION GUARD FOR BACKLOG-2356.
   *
   * A unique name gets NOTHING. Asserted as absence from the map, not as an
   * empty string, so a caller cannot render a blank element. This is the half of
   * the feature that keeps the picker quiet, and it must stay green when the
   * collision check is reverted.
   */
  it("says nothing about rows whose names are unique [CONTROL 6]", () => {
    const rows = [
      row("a", "Dana Whitlock", { company: "Acme", phone: "5550130" }),
      row("b", "Robin Marsh", { company: "Borden", phone: "5550131" }),
      row("c", "Pat Riverton", { company: "Cole", phone: "5550132" }),
    ];

    expect(buildRowDisambiguators(rows).size).toBe(0);
    expect(linesFor(rows)).toEqual([undefined, undefined, undefined]);
  });

  /**
   * CONTROL 5 — THE PAIRWISE CASE.
   *
   * Two Danas, distinguishable. The organisation differs, so the organisation is
   * what is shown — the phone is never reached.
   *
   * CONTROL RUN: delete the `if (group.length < 2) continue;` guard's effect by
   * making every group disambiguate. OBSERVED: the unique-name test above goes
   * red, this one stays green — which is how the two halves are told apart.
   */
  it("gives two same-named rows the field that differs [CONTROL 5]", () => {
    const rows = [
      row("a", "Dana Whitlock", { company: "Acme Realty", phone: "5550130" }),
      row("b", "Dana Whitlock", { company: "Borden Group", phone: "5550131" }),
    ];

    expect(linesFor(rows)).toEqual(["Acme Realty", "Borden Group"]);
  });

  /**
   * CONTROL 7 — SIX RECORDS SHARING ONE NAME, ALL DISTINGUISHABLE FROM EACH
   * OTHER.
   *
   * The founder's harder case. All six are at the SAME firm, so the organisation
   * separates nothing and must be dropped — a row reading "Dana Whitlock / Acme
   * Realty" six times is the bug with an extra line. The phone separates all six
   * and is what shows.
   *
   * The assertion is the SET, so six identical lines fail even though six lines
   * exist.
   *
   * MEASURED: this case PASSES under BACKLOG-2625's own predicate too — with the
   * organisation shared by all six, 2625 falls through to the phone and gets the
   * right answer for the wrong reason. It is recorded here so nobody reads it as
   * the discriminating case. The one that discriminates is the next test.
   */
  it("makes six rows sharing one name distinguishable FROM EACH OTHER [CONTROL 7]", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row(`d${i}`, "Dana Whitlock", {
        company: "Acme Realty",
        phone: `555013${i}`,
      }),
    );

    const lines = linesFor(rows);

    expect(new Set(lines).size).toBe(6);
    expect(lines).toEqual([
      "555-0130",
      "555-0131",
      "555-0132",
      "555-0133",
      "555-0134",
      "555-0135",
    ]);
    // The shared organisation contributes nothing and is not shown.
    expect(lines.some((l) => l?.includes("Acme Realty"))).toBe(false);
  });

  /**
   * CONTROL 7, THE VARIANT THAT BREAKS BACKLOG-2625'S PREDICATE.
   *
   * Three at Acme, three at Borden, six distinct phones. Under "show a field
   * that differs from at least one colliding row" every row shows its
   * organisation, and the result is two groups of three identical lines —
   * `Set(lines).size === 2`. Under whole-group separation the organisation is
   * kept (it splits 1 -> 2) and the phone is added on top (2 -> 6).
   *
   * CONTROL RUN: replaced `separatingFields` with 2625's `differsFromAColliding`
   * predicate. OBSERVED: this test fails with
   *   Expected: 6   Received: 2
   * while the pairwise case above stays green — which is exactly the trap this
   * item warned about.
   */
  it("separates six rows when NO single field separates them [CONTROL 7]", () => {
    const rows = [
      row("a1", "Dana Whitlock", { company: "Acme Realty", phone: "5550130" }),
      row("a2", "Dana Whitlock", { company: "Acme Realty", phone: "5550131" }),
      row("a3", "Dana Whitlock", { company: "Acme Realty", phone: "5550132" }),
      row("b1", "Dana Whitlock", { company: "Borden Group", phone: "5550133" }),
      row("b2", "Dana Whitlock", { company: "Borden Group", phone: "5550134" }),
      row("b3", "Dana Whitlock", { company: "Borden Group", phone: "5550135" }),
    ];

    const lines = linesFor(rows);

    expect(new Set(lines).size).toBe(6);
    expect(lines[0]).toBe("Acme Realty · 555-0130");
    expect(lines[5]).toBe("Borden Group · 555-0135");
  });

  /**
   * The founder's blocked instruction, run end to end: "import the Dana with
   * phone 555-0130". Three Danas, none with an organisation, so the phone is the
   * first field that separates them and the row reads the number he was given.
   */
  it("shows the phone the founder was told to pick when only phones differ", () => {
    const rows = [
      row("a", "Dana Whitlock", { phone: "5550130", email: "d@acme.test" }),
      row("b", "Dana Whitlock", { phone: "5550131", email: "d@acme.test" }),
      row("c", "Dana Whitlock", { phone: "5550132", email: "d@acme.test" }),
    ];

    expect(linesFor(rows)).toEqual(["555-0130", "555-0131", "555-0132"]);
  });

  /** Falls through to email when organisation and phone are shared or absent. */
  it("falls through to email when nothing earlier separates the group", () => {
    const rows = [
      row("a", "Dana Whitlock", { company: "Acme", email: "dana.w@acme.test" }),
      row("b", "Dana Whitlock", { company: "Acme", email: "dana.whitlock@acme.test" }),
    ];

    expect(linesFor(rows)).toEqual(["dana.w@acme.test", "dana.whitlock@acme.test"]);
  });

  /**
   * THE HONEST LIMIT, STATED AS A TEST.
   *
   * Two records identical in every field this module can read get NO line. That
   * is not a silent failure being papered over — there is nothing true to say,
   * and inventing a difference (an index, an id fragment) would put a
   * distinction on screen that does not exist in the data. Duplicates are the
   * review/dedup path's problem.
   */
  it("adds nothing when two records are identical in every field it reads", () => {
    const rows = [
      row("a", "Dana Whitlock", { company: "Acme", phone: "5550130", email: "d@acme.test" }),
      row("b", "Dana Whitlock", { company: "Acme", phone: "5550130", email: "d@acme.test" }),
    ];

    expect(buildRowDisambiguators(rows).size).toBe(0);
  });

  /**
   * Ambiguity is what the user SEES, so it is keyed on the rendered label and
   * normalised — `labelForContact` trims, and casing is not a distinction a user
   * can act on. Two rows reading "dana whitlock" and "Dana Whitlock" collide.
   */
  it("treats names differing only in case or padding as the same name", () => {
    const rows = [
      row("a", "Dana Whitlock", { company: "Acme" }),
      row("b", "  dana whitlock ", { company: "Borden" }),
    ];

    expect(linesFor(rows)).toEqual(["Acme", "Borden"]);
  });

  /**
   * `labelForContact` falls back name -> organisation -> phone -> email, so two
   * contacts with no name can collide on a rendered ORGANISATION. The
   * disambiguator must then not simply repeat the organisation back.
   */
  it("does not repeat the label back when rows collide on a fallback label", () => {
    const rows = [
      row("a", "", { company: "Acme Realty", phone: "5550130" }),
      row("b", "", { company: "Acme Realty", phone: "5550131" }),
    ];

    expect(linesFor(rows)).toEqual(["555-0130", "555-0131"]);
  });

  /**
   * A row holding none of the separating fields is omitted rather than given a
   * blank line — and it is still distinguishable, because every other row in the
   * group carries a line and it does not.
   */
  it("omits a row that holds none of the separating fields", () => {
    const rows = [
      row("a", "Dana Whitlock", { company: "Acme Realty" }),
      row("b", "Dana Whitlock"),
    ];

    expect(linesFor(rows)).toEqual(["Acme Realty", undefined]);
  });

  it("returns nothing for an empty list", () => {
    expect(buildRowDisambiguators([]).size).toBe(0);
  });
});
