/**
 * THE HEADER'S PARENTHETICAL IS A PARTITION, NOT A SECOND OPINION (BACKLOG-2662)
 *
 * ===========================================================================
 * WHAT WENT WRONG
 * ===========================================================================
 * `1173 contacts (1171 from Contacts App)` against a database holding 1,166
 * `macos` and 5 `outlook` records. Two independent defects produced it:
 *
 *   (a) "Contacts App" was typed into the JSX, so records of every source were
 *       credited to one provider — BACKLOG-2483's defect, one layer up.
 *   (b) The total and the parenthetical counted DIFFERENT POPULATIONS: the
 *       rendered rows (saved half + external half, post filter/search) against
 *       the raw `get-available` array. Nothing required them to reconcile, and
 *       the 2-record gap the founder spotted is exactly that.
 *
 * ===========================================================================
 * WHY (b) MAKES THE ASSERTIONS BELOW LOOK THE WAY THEY DO
 * ===========================================================================
 * A test that fixes (a) alone would assert "Outlook appears somewhere" and pass
 * while the numbers still failed to add up. So `sums to exactly the rows it was
 * given` is asserted DIRECTLY, over fixtures whose composition is stated in the
 * test, with no tolerance for a remainder. That is the assertion the founder's
 * two unexplained records would have failed.
 */

import {
  summariseContactSources,
  formatContactSourceSummary,
} from "../contactSourceBreakdown";
import { UNKNOWN_CONTACT_SOURCE_LABEL } from "../contactFilterModel";
import { ALL_CONTACT_SOURCE_VALUES } from "../../../electron/utils/contactSourceVocabulary";

/** `n` rows carrying one source. Only `source` is read by the partition. */
function rows(source: string | null | undefined, n: number): { source?: string | null }[] {
  return Array.from({ length: n }, () => ({ source }));
}

describe("summariseContactSources", () => {
  /**
   * THE FOUNDER'S EXACT NUMBERS, as the header's own inputs.
   *
   * 1,166 macOS records reach the renderer as `contacts_app` — the shadow table
   * spells the desktop address book `macos` and `toPersistedContactSource` folds
   * it (`contactHandlers.ts` applies that fold when it projects picker rows), so
   * `contacts_app` is what a row actually carries. 5 Outlook records pass through
   * as `outlook`. Plus the 2 saved rows that made up the 1173.
   *
   * CONTROL: restore the header's `(${externalContacts.length} from Contacts
   * App)` — see the component test, where that revert is observable.
   */
  it("names each source with its own count [CONTROL for the founder's reading]", () => {
    const segments = summariseContactSources([
      ...rows("contacts_app", 1166),
      ...rows("outlook", 5),
      ...rows("manual", 2),
    ]);

    expect(segments).toEqual([
      { label: "Contacts App", count: 1166 },
      { label: "Outlook", count: 5 },
      { label: "Manual", count: 2 },
    ]);
  });

  /**
   * THE ARITHMETIC, STATED AS ARITHMETIC.
   *
   * Not "the numbers look right" — the sum of the parts against the length of
   * the input array. A partition that dropped a row it could not name (the
   * obvious way to "fix" an unknown source) fails here, which is why unknown
   * sources are labelled rather than skipped.
   */
  it("partitions every row it is given — the counts sum to the input length", () => {
    const input = [
      ...rows("contacts_app", 1166),
      ...rows("outlook", 5),
      ...rows("manual", 1),
      ...rows("messages", 1),
      ...rows("wingdings_9000", 3),
      ...rows(null, 2),
    ];

    const segments = summariseContactSources(input);
    const summed = segments.reduce((n, s) => n + s.count, 0);

    expect(summed).toBe(input.length);
    expect(summed).toBe(1178);
  });

  /**
   * COVERAGE OVER THE SHARED VOCABULARY, not a list retyped here.
   *
   * Every value `contact.source` can hold must land on a NAMED segment. A source
   * added to the CHECK without a filter leaf would otherwise appear in the
   * header as "Other" silently; this states that today none of them do.
   */
  it("gives every value in the shared vocabulary a real name, never 'Other'", () => {
    const unnamed = ALL_CONTACT_SOURCE_VALUES.filter(
      (source) =>
        summariseContactSources([{ source }])[0].label === UNKNOWN_CONTACT_SOURCE_LABEL,
    );

    expect(unnamed).toEqual([]);
  });

  /**
   * Grouping is BY LABEL. `sms` and `messages` are both "From Texts"
   * (`contactSourceLabel.test.ts` asserts that mapping), and a header reading
   * "2 from From Texts, 1 from From Texts" would be a bug the user has no way to
   * interpret.
   */
  it("merges sources that share one label into one segment", () => {
    expect(summariseContactSources([...rows("sms", 2), ...rows("messages", 1)])).toEqual([
      { label: "From Texts", count: 3 },
    ]);
  });

  /** Unknown, empty and NULL sources are named "Other" — counted, never dropped. */
  it("counts a row whose source it cannot name rather than dropping it", () => {
    expect(
      summariseContactSources([{ source: null }, { source: "nonesuch" }, {}]),
    ).toEqual([{ label: UNKNOWN_CONTACT_SOURCE_LABEL, count: 3 }]);
  });

  /**
   * The order is a TOTAL order, so a re-render cannot reshuffle the header.
   * Count DESC first; the A-Z tiebreak is what makes equal counts deterministic,
   * and the three tied sources here test only that tiebreak.
   *
   * "iPhone" sorts before "Manual" because `localeCompare` collates
   * case-insensitively — i before m. Written out because the naive expectation
   * (ASCII order, where a lowercase "i" sorts after every capital) is wrong here
   * and was wrong in the first draft of this test.
   */
  it("orders by count DESC then label A-Z", () => {
    const segments = summariseContactSources([
      ...rows("outlook", 2),
      ...rows("manual", 2),
      ...rows("iphone", 2),
      ...rows("contacts_app", 9),
    ]);

    expect(segments.map((s) => s.label)).toEqual([
      "Contacts App",
      "iPhone",
      "Manual",
      "Outlook",
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(summariseContactSources([])).toEqual([]);
  });
});

describe("formatContactSourceSummary", () => {
  /**
   * THE REGRESSION GUARD FOR THE STATE THAT HID THE BUG.
   *
   * Minutes before the Outlook sync the header read `1168 contacts (1166 from
   * Contacts App)` and was, for that population, correct. One source must still
   * produce that string BYTE FOR BYTE — leading space, "from", the parentheses.
   * If a future change reformats the parenthetical, this is the test that says
   * the single-source case was never the thing that needed changing.
   */
  it("renders one source exactly as the header did before this change", () => {
    expect(formatContactSourceSummary([{ label: "Contacts App", count: 1166 }])).toBe(
      " (1166 from Contacts App)",
    );
  });

  /** The founder's post-sync state, with the two saved rows accounted for. */
  it("names every source when there is more than one", () => {
    expect(
      formatContactSourceSummary([
        { label: "Contacts App", count: 1166 },
        { label: "Outlook", count: 5 },
        { label: "Manual", count: 2 },
      ]),
    ).toBe(" (1166 from Contacts App, 5 from Outlook, 2 from Manual)");
  });

  it("says nothing when there are no contacts", () => {
    expect(formatContactSourceSummary([])).toBeNull();
  });
});
