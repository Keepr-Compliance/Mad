/**
 * SHARED PHONE-NUMBER FIXTURE CORPORA — BACKLOG-2798
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS: area code 555 is not a test number, it is a BLIND SPOT
 * ===========================================================================
 * NANP area code 555 is not assignable, so libphonenumber-js reports
 * `isValid() === false` for every `(555) 555-01xx` value. `toLookupKey` accepts
 * the library's answer ONLY when `isValid()`, so a 555 fixture never reaches the
 * parsed branch — it falls to `legacyDigitKey` and produces a key byte-identical
 * to the rule that shipped before the library arrived.
 *
 * Measured on libphonenumber-js 1.13.11, the version `package.json` pins:
 *
 * | raw                | isValid() | toLookupKey    | legacyDigitKey | branch   |
 * |--------------------|-----------|----------------|----------------|----------|
 * | `(555) 555-0112`   | false     | `5555550112`   | `5555550112`   | fallback |
 * | `+15555550112`     | false     | `5555550112`   | `5555550112`   | fallback |
 * | `(415) 555-0109`   | **true**  | `14155550109`  | `4155550109`   | parsed   |
 * | `+44 20 7946 0958` | **true**  | `442079460958` | `2079460958`   | parsed   |
 *
 * A suite built solely on 555 numbers therefore cannot distinguish the parsed
 * path from the fallback path — the two agree on every input it owns. That is
 * what let a real blocker stay green through 22/22 passing tests on PR #2346,
 * and it is the defect BACKLOG-2798 was filed to remove. Nine suites are in that
 * state; this corpus is the shared thing they migrate onto.
 *
 * ===========================================================================
 * FIXTURE PROVENANCE — read before adding a row
 * ===========================================================================
 * **Every `lookupKey` and `matchingKey` below is a TRANSCRIBED STRING LITERAL,
 * produced by running libphonenumber-js 1.13.11 against the live
 * `phoneNormalization` module and pasting the output.** They are deliberately
 * NOT computed here by importing `toLookupKey`. A corpus that derives its own
 * expectations from the function under test proves only that a function equals
 * itself — the rule PR #2346's repaired corpora established, kept here.
 *
 * `phoneCorpora.invariant-2798.test.ts` re-derives all four declared columns
 * against the live library on every run, so a corpus that drifts out of date
 * fails loudly instead of quietly agreeing with whatever the code now does.
 *
 * ===========================================================================
 * THIS REPOSITORY IS PUBLIC. WHERE EACH NUMBER COMES FROM
 * ===========================================================================
 * | region | range used | status |
 * |---|---|---|
 * | US / CA | `<real area code> 555-01xx` | reserved for fiction — NANP / ATIS-0300115 |
 * | GB | `020 7946 0xxx`, `0113 496 0xxx` | reserved for drama — Ofcom |
 * | FR | `01 99 00 xx xx` | reserved for fiction — ARCEP |
 * | AU | `(02) 5550 xxxx`, `0491 570 xxx` | reserved for drama — ACMA |
 * | IL | `+972 3 555 0142`, `+972 52 555 0123` | **SYNTHETIC — Israel publishes no reserved range** |
 *
 * The Israeli rows are labelled synthetic rather than dressed as reserved,
 * because claiming a reservation that does not exist is a false provenance
 * claim and the next reader would inherit it. They are carried anyway: the
 * Israeli domestic/E.164 split is the exact corpus BACKLOG-2635 measured on a
 * real address book, and a corpus without it cannot exercise that class.
 *
 * `+50664103686` is deliberately ABSENT. It appears in `phoneNormalization.ts`
 * annotated "(Costa Rica, real data)" and must not be propagated into a fixture.
 *
 * The US and CA rows satisfy `scripts/ci/check-fixture-pii.mjs`'s
 * `RESERVED_PHONE_RE` (`^\d{3}55501\d{2}$`) by construction; the international
 * rows are not US-shaped and are not matched by that guard's patterns at all,
 * which is why their provenance is documented here instead.
 *
 * ===========================================================================
 * SCOPE — KEYS ONLY (BACKLOG-2754)
 * ===========================================================================
 * These fixtures describe what the KEY FUNCTIONS return. They say nothing about
 * lookup, search or candidate SQL. BACKLOG-2754 is explicit that the digit floor
 * lives over the matcher and not over the key layer, and that a floor pushed
 * into `toLookupKey` would drop short codes from `phone_last_message`
 * (undoing BACKLOG-1493) and turn the contact-search needle into `'%%'`. A
 * corpus that mixed the two layers would make that distinction harder to hold,
 * so it does not.
 */

/** Which branch of `toLookupKey` a value takes. */
export type PhoneParseClass =
  /** `parsePhoneNumberFromString(raw, "US").isValid()` — the library's E.164 digits are used. */
  | "parsed"
  /** Not valid to the library — `legacyDigitKey` (the pre-library rule) produces the key. */
  | "fallback";

export interface PhoneFixture {
  /** The value exactly as a user, a provider or an import would supply it. */
  readonly raw: string;
  /** The branch `toLookupKey` takes. Re-derived against the live library by the invariant suite. */
  readonly parseClass: PhoneParseClass;
  /**
   * Digit count of the RAW value — the number `toMatchingKey`'s floor counts.
   * It counts the raw and not the key on purpose, so the floor verdict cannot
   * hinge on whether the library happened to parse the value.
   */
  readonly digits: number;
  /** Transcribed `toLookupKey(raw)`. */
  readonly lookupKey: string;
  /** Transcribed `toMatchingKey(raw)`. `""` means "may not be used to match". */
  readonly matchingKey: string;
  /** Why this row is in the corpus, where it is not self-evident. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// PARSEABLE — the branch no 555 fixture can reach
// ---------------------------------------------------------------------------

/**
 * US numbers on real, assignable area codes with the reserved `555-01xx` line.
 *
 * The spellings of `(415) 555-0109` are grouped first on purpose: they are one
 * number written eight ways, and under the parsed rule they must produce ONE
 * key. Under the pre-library rule they also collapsed — by amputation — so this
 * group alone does not discriminate the branches; the international group and
 * the `parsedKey !== legacyKey` teeth check do.
 */
export const US_PARSEABLE: readonly PhoneFixture[] = [
  { raw: "+14155550109", parseClass: "parsed", digits: 11, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "14155550109", parseClass: "parsed", digits: 11, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "4155550109", parseClass: "parsed", digits: 10, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "(415) 555-0109", parseClass: "parsed", digits: 10, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "415-555-0109", parseClass: "parsed", digits: 10, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "415.555.0109", parseClass: "parsed", digits: 10, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "+1 415 555 0109", parseClass: "parsed", digits: 11, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "1 (415) 555-0109", parseClass: "parsed", digits: 11, lookupKey: "14155550109", matchingKey: "14155550109" },
  {
    raw: " (415) 555-0109 ",
    parseClass: "parsed",
    digits: 10,
    lookupKey: "14155550109",
    matchingKey: "14155550109",
    note: "Surrounding whitespace. Both key functions trim before parsing; a provider that pads a CSV cell must not produce a different key.",
  },
  { raw: "(206) 555-0142", parseClass: "parsed", digits: 10, lookupKey: "12065550142", matchingKey: "12065550142" },
  { raw: "+12065550142", parseClass: "parsed", digits: 11, lookupKey: "12065550142", matchingKey: "12065550142" },
  { raw: "206-555-0142", parseClass: "parsed", digits: 10, lookupKey: "12065550142", matchingKey: "12065550142" },
  { raw: "(312) 555-0187", parseClass: "parsed", digits: 10, lookupKey: "13125550187", matchingKey: "13125550187" },
  { raw: "(646) 555-0133", parseClass: "parsed", digits: 10, lookupKey: "16465550133", matchingKey: "16465550133" },
  { raw: "(503) 555-0121", parseClass: "parsed", digits: 10, lookupKey: "15035550121", matchingKey: "15035550121" },
  { raw: "(305) 555-0164", parseClass: "parsed", digits: 10, lookupKey: "13055550164", matchingKey: "13055550164" },
];

/**
 * Canada — the same `+1` country code as the US, a different country.
 *
 * Present because `DEFAULT_PHONE_REGION` is `"US"` and a reader could reasonably
 * assume that means "only US numbers parse without a `+`". It does not: `604` is
 * a Canadian area code inside the shared NANP, so `(604) 555-0109` parses
 * without a country code and keys to `16045550109`, with `country === "CA"`.
 */
export const CA_PARSEABLE: readonly PhoneFixture[] = [
  { raw: "+16045550109", parseClass: "parsed", digits: 11, lookupKey: "16045550109", matchingKey: "16045550109" },
  { raw: "(604) 555-0109", parseClass: "parsed", digits: 10, lookupKey: "16045550109", matchingKey: "16045550109" },
  { raw: "1 604 555 0109", parseClass: "parsed", digits: 11, lookupKey: "16045550109", matchingKey: "16045550109" },
];

/**
 * `+`-prefixed numbers outside the NANP.
 *
 * **This is the group that actually discriminates the two branches.** Under the
 * pre-library rule every one of these was cut to its last ten digits — the
 * second defect BACKLOG-2635 measured — producing a key that corresponds to no
 * real number and can collide with an unrelated NANP number. `+972 3 555 0142`
 * is the worked example: the old rule yielded `7235550142`, which reads as area
 * code 723. The `legacy` column below is what each value used to key to, and no
 * fixture here agrees with its own legacy key.
 *
 * Country-code lengths 2 and 3, and key lengths 11 and 12, are both represented
 * so the corpus is not a single shape wearing several flags.
 */
export const INTERNATIONAL_PARSEABLE: readonly PhoneFixture[] = [
  {
    raw: "+44 20 7946 0958",
    parseClass: "parsed",
    digits: 12,
    lookupKey: "442079460958",
    matchingKey: "442079460958",
    note: "GB, Ofcom drama range. legacy key was 2079460958.",
  },
  { raw: "+442079460958", parseClass: "parsed", digits: 12, lookupKey: "442079460958", matchingKey: "442079460958" },
  {
    raw: "+44 113 496 0109",
    parseClass: "parsed",
    digits: 12,
    lookupKey: "441134960109",
    matchingKey: "441134960109",
    note: "GB, Ofcom Leeds drama range. legacy key was 1134960109.",
  },
  {
    raw: "+33 1 99 00 12 34",
    parseClass: "parsed",
    digits: 11,
    lookupKey: "33199001234",
    matchingKey: "33199001234",
    note: "FR, ARCEP fiction range. legacy key was 3199001234.",
  },
  { raw: "+33199001234", parseClass: "parsed", digits: 11, lookupKey: "33199001234", matchingKey: "33199001234" },
  {
    raw: "+61 2 5550 1099",
    parseClass: "parsed",
    digits: 11,
    lookupKey: "61255501099",
    matchingKey: "61255501099",
    note: "AU, ACMA drama landline range. legacy key was 1255501099.",
  },
  {
    raw: "+61491570156",
    parseClass: "parsed",
    digits: 11,
    lookupKey: "61491570156",
    matchingKey: "61491570156",
    note: "AU, ACMA drama mobile range. legacy key was 1491570156.",
  },
  {
    raw: "+972 3 555 0142",
    parseClass: "parsed",
    digits: 11,
    lookupKey: "97235550142",
    matchingKey: "97235550142",
    note: "IL, SYNTHETIC (no reserved range exists). The BACKLOG-2635 collision case: the legacy key 7235550142 reads as NANP area code 723.",
  },
  {
    raw: "+972 52 555 0123",
    parseClass: "parsed",
    digits: 12,
    lookupKey: "972525550123",
    matchingKey: "972525550123",
    note: "IL mobile, SYNTHETIC. Its domestic twin 0525550123 is in UNPARSEABLE_OTHER and keys differently — the pair BACKLOG-2635 is about.",
  },
];

/**
 * A PARSE THAT SILENTLY DROPS DIGITS — the case no one would think to write.
 *
 * This group exists because it is the reason shared corpora are worth having:
 * a suite inherits the surprising input it would never have invented.
 *
 * `+861234567890123` is a malformed 15-digit run. It is not a phone number, and
 * the obvious expectation is that it falls to the legacy rule like every other
 * malformed run. It does not. libphonenumber-js 1.13.11 reads the leading
 * digits as a Chinese carrier-selection prefix, strips SEVEN of them, and
 * returns `+8667890123` with `isValid() === true`, `country === "CN"`,
 * `nationalNumber === "67890123"`.
 *
 * So `toLookupKey` accepts it and stores `8667890123` — a key that belongs to a
 * DIFFERENT number from the one the column holds, and a plausible key for a real
 * Chinese subscriber. In a product whose whole job is attaching a message thread
 * to the right human, a value that keys onto someone else is the false-merge
 * direction, not the missed-duplicate direction.
 *
 * Recorded here as measured behaviour, NOT asserted to be correct. Nothing in
 * BACKLOG-2798 changes production code; this is filed on the item for triage.
 * The fixture is pinned so that if the shape ever changes — a metadata update,
 * a library bump past the exact pin in `package.json` — a test says so.
 *
 * The input is a synthetic digit run and refers to no one.
 */
export const PARSED_WITH_DIGITS_DROPPED: readonly PhoneFixture[] = [
  {
    raw: "+861234567890123",
    parseClass: "parsed",
    digits: 15,
    lookupKey: "8667890123",
    matchingKey: "8667890123",
    note: "isValid() === true, and the key has SEVEN fewer digits than the input. See this group's docblock.",
  },
];

/** Every value that reaches the library's parsed branch. */
export const PARSEABLE: readonly PhoneFixture[] = [
  ...US_PARSEABLE,
  ...CA_PARSEABLE,
  ...INTERNATIONAL_PARSEABLE,
  ...PARSED_WITH_DIGITS_DROPPED,
];

// ---------------------------------------------------------------------------
// FALLBACK — the only branch the pre-2798 fixtures ever reached
// ---------------------------------------------------------------------------

/**
 * Area code 555 itself, kept and LABELLED.
 *
 * These are not being removed from the codebase and should not be: they are a
 * legitimate unparseable class, and a corpus that dropped them would stop
 * testing the fallback. What was wrong was never that 555 appeared — it was
 * that 555 appeared ALONE. Every row here is `parseClass: "fallback"`, stated
 * rather than discovered, so a suite reading this corpus can see at a glance
 * which of its fixtures prove nothing about the parser.
 */
export const UNPARSEABLE_555: readonly PhoneFixture[] = [
  { raw: "+15555550112", parseClass: "fallback", digits: 11, lookupKey: "5555550112", matchingKey: "5555550112" },
  { raw: "15555550112", parseClass: "fallback", digits: 11, lookupKey: "5555550112", matchingKey: "5555550112" },
  { raw: "5555550112", parseClass: "fallback", digits: 10, lookupKey: "5555550112", matchingKey: "5555550112" },
  { raw: "(555) 555-0112", parseClass: "fallback", digits: 10, lookupKey: "5555550112", matchingKey: "5555550112" },
  { raw: "555-555-0112", parseClass: "fallback", digits: 10, lookupKey: "5555550112", matchingKey: "5555550112" },
  { raw: "555.555.0100", parseClass: "fallback", digits: 10, lookupKey: "5555550100", matchingKey: "5555550100" },
  { raw: "1 (555) 555-0199", parseClass: "fallback", digits: 11, lookupKey: "5555550199", matchingKey: "5555550199" },
  { raw: "+1-555-555-0199", parseClass: "fallback", digits: 11, lookupKey: "5555550199", matchingKey: "5555550199" },
  { raw: "555 555 0199", parseClass: "fallback", digits: 10, lookupKey: "5555550199", matchingKey: "5555550199" },
];

/**
 * Everything else the library will not validate — the classes a phone column
 * really carries in this product.
 */
export const UNPARSEABLE_OTHER: readonly PhoneFixture[] = [
  {
    raw: "020794609",
    parseClass: "fallback",
    digits: 9,
    lookupKey: "020794609",
    matchingKey: "020794609",
    note: "SR finding D on the dropped PR #2333: a hand-rolled rule declared every 9-digit leading-zero number Israeli. The library invents no country and this key asserts nothing about origin.",
  },
  {
    raw: "0525550123",
    parseClass: "fallback",
    digits: 10,
    lookupKey: "0525550123",
    matchingKey: "0525550123",
    note: "isPossible() true, isValid() false — the measured pair that decided the gate. Its E.164 twin +972 52 555 0123 keys differently; they do not meet, and that is the honest answer rather than a guess.",
  },
  {
    raw: "1115550109",
    parseClass: "fallback",
    digits: 10,
    lookupKey: "1115550109",
    matchingKey: "1115550109",
    note: "Right length, invalid pattern (NANP area codes cannot start with 1). Length alone is not validity.",
  },
  { raw: "9995550123", parseClass: "fallback", digits: 10, lookupKey: "9995550123", matchingKey: "9995550123" },
  {
    raw: "+44 7700 900123",
    parseClass: "fallback",
    digits: 12,
    lookupKey: "7700900123",
    matchingKey: "7700900123",
    note: "Ofcom's drama MOBILE range, and isValid() === false in libphonenumber-js 1.13.11. Validity is metadata-dependent, which is why package.json pins the version exactly. A '+' prefix does not imply a parse.",
  },
  {
    raw: "12345",
    parseClass: "fallback",
    digits: 5,
    lookupKey: "12345",
    matchingKey: "",
    note: "Short code. It keeps a lookup key — phone_last_message is keyed BY that key and BACKLOG-1493's rows live there — while emitting no match candidate.",
  },
  { raw: "262966", parseClass: "fallback", digits: 6, lookupKey: "262966", matchingKey: "" },
  { raw: "911", parseClass: "fallback", digits: 3, lookupKey: "911", matchingKey: "" },
  {
    raw: "4021",
    parseClass: "fallback",
    digits: 4,
    lookupKey: "4021",
    matchingKey: "",
    note: "An extension. Two unrelated colleagues share it, which is why it may not propose them as one person.",
  },
  { raw: "11", parseClass: "fallback", digits: 2, lookupKey: "11", matchingKey: "", note: "A typo." },
  { raw: "9", parseClass: "fallback", digits: 1, lookupKey: "9", matchingKey: "" },
  {
    raw: "VERIZON",
    parseClass: "fallback",
    digits: 0,
    lookupKey: "VERIZON",
    matchingKey: "",
    note: "Alphanumeric sender: no digits at all, so legacyDigitKey returns the trimmed original rather than an empty string.",
  },
  { raw: "TXT-ALERT", parseClass: "fallback", digits: 0, lookupKey: "TXT-ALERT", matchingKey: "" },
  {
    raw: "ext. 302",
    parseClass: "fallback",
    digits: 3,
    lookupKey: "302",
    matchingKey: "",
    note: "Digits are extracted from around the words; the label does not survive into the key.",
  },
  {
    raw: "12345678901234",
    parseClass: "fallback",
    digits: 14,
    lookupKey: "5678901234",
    matchingKey: "5678901234",
    note: "A malformed long run. The fallback still amputates to the last ten — 'never keyed WORSE than today', not 'keyed well'.",
  },
  { raw: "+12345678901234", parseClass: "fallback", digits: 14, lookupKey: "5678901234", matchingKey: "5678901234" },
  {
    raw: "chat123456789@example.test",
    parseClass: "fallback",
    digits: 9,
    lookupKey: "123456789",
    matchingKey: "123456789",
    note: "An Apple-ID-shaped handle living in a phone column. Recorded because the digits inside it clear the floor of 7 and it becomes a match CANDIDATE — see the invariant suite's note on this row.",
  },
  {
    raw: "dana.reyes@example.test",
    parseClass: "fallback",
    digits: 0,
    lookupKey: "dana.reyes@example.test",
    matchingKey: "",
    note: "An email handle with no digits: it survives as a lookup key and is barred from matching.",
  },
  { raw: "", parseClass: "fallback", digits: 0, lookupKey: "", matchingKey: "" },
  { raw: "   ", parseClass: "fallback", digits: 0, lookupKey: "", matchingKey: "" },
];

/** Every value that falls through to the pre-library rule. */
export const UNPARSEABLE: readonly PhoneFixture[] = [...UNPARSEABLE_555, ...UNPARSEABLE_OTHER];

// ---------------------------------------------------------------------------
// THE FLOOR-7 BOUNDARY
// ---------------------------------------------------------------------------

/**
 * A rung at every digit count from 1 to 12, crossing `MATCHING_DIGIT_FLOOR`.
 *
 * The floor is selected by digit count, so one input per side cannot catch an
 * off-by-one: 6, 7 and 8 are all present, 6 and 7 in bare and punctuated forms
 * so the verdict is visibly a function of digits rather than of shape. The
 * 10-digit rung appears TWICE — once parseable (`4155550109` → an 11-digit key)
 * and once not (`0525550123` → itself) — because the floor must not depend on
 * which branch produced the key.
 */
export const FLOOR_BOUNDARY: readonly PhoneFixture[] = [
  { raw: "9", parseClass: "fallback", digits: 1, lookupKey: "9", matchingKey: "" },
  { raw: "11", parseClass: "fallback", digits: 2, lookupKey: "11", matchingKey: "" },
  { raw: "555", parseClass: "fallback", digits: 3, lookupKey: "555", matchingKey: "" },
  { raw: "4021", parseClass: "fallback", digits: 4, lookupKey: "4021", matchingKey: "" },
  { raw: "12345", parseClass: "fallback", digits: 5, lookupKey: "12345", matchingKey: "" },
  { raw: "555010", parseClass: "fallback", digits: 6, lookupKey: "555010", matchingKey: "", note: "floor - 1" },
  { raw: "(555) 010", parseClass: "fallback", digits: 6, lookupKey: "555010", matchingKey: "", note: "floor - 1, punctuated" },
  { raw: "555-010", parseClass: "fallback", digits: 6, lookupKey: "555010", matchingKey: "", note: "floor - 1, punctuated" },
  { raw: "5550109", parseClass: "fallback", digits: 7, lookupKey: "5550109", matchingKey: "5550109", note: "AT the floor" },
  { raw: "555-0109", parseClass: "fallback", digits: 7, lookupKey: "5550109", matchingKey: "5550109", note: "AT the floor, punctuated" },
  { raw: "(555) 0109", parseClass: "fallback", digits: 7, lookupKey: "5550109", matchingKey: "5550109", note: "AT the floor, punctuated" },
  { raw: "15550109", parseClass: "fallback", digits: 8, lookupKey: "15550109", matchingKey: "15550109", note: "floor + 1" },
  { raw: "020794609", parseClass: "fallback", digits: 9, lookupKey: "020794609", matchingKey: "020794609" },
  { raw: "4155550109", parseClass: "parsed", digits: 10, lookupKey: "14155550109", matchingKey: "14155550109", note: "10 raw digits, 11-digit key — the floor counts the RAW value" },
  { raw: "0525550123", parseClass: "fallback", digits: 10, lookupKey: "0525550123", matchingKey: "0525550123", note: "same digit count, other branch" },
  { raw: "14155550109", parseClass: "parsed", digits: 11, lookupKey: "14155550109", matchingKey: "14155550109" },
  { raw: "+442079460958", parseClass: "parsed", digits: 12, lookupKey: "442079460958", matchingKey: "442079460958" },
];

/**
 * Everything. `FLOOR_BOUNDARY` overlaps the groups above by design — a corpus
 * consumer wanting each value once should read the group it needs, not this.
 */
export const ALL_PHONE_FIXTURES: readonly PhoneFixture[] = [
  ...PARSEABLE,
  ...UNPARSEABLE,
  ...FLOOR_BOUNDARY,
];

// ---------------------------------------------------------------------------
// THE CONTROL
// ---------------------------------------------------------------------------

/**
 * THE 555 FIXTURES OF THE PRE-BACKLOG-2798 CORPUS — kept so the blindness can be
 * ASSERTED rather than described.
 *
 * Transcribed verbatim from the three phone-shaped groups of
 * `phoneNormalization.formatPhoneNumber.lookupKeyInvariant-2620.test.ts` as that
 * file stood at `develop@36f67e629`. The invariant suite runs the live library
 * over this list and requires the parsed count to be exactly ZERO, and requires
 * `toLookupKey` and `legacyDigitKey` to agree on every one of them — the
 * falsifiable form of "this fixture set cannot tell the two branches apart".
 *
 * ===========================================================================
 * A CORRECTION TO BACKLOG-2798's OWN CENSUS. Measured, 2026-08-22.
 * ===========================================================================
 * The item states that nine suites have "no non-555 parseable fixture at all",
 * naming this one. **For this file that is not true, and the difference is worth
 * stating precisely rather than inheriting.** Running libphonenumber-js 1.13.11
 * over the file's entire pre-2798 fixture set — 37 listed values plus the 60
 * generated digit runs, 97 in total — **3 values parse**:
 *
 *   `+50664103686` · `+44 20 7946 0958` · `+861234567890123`
 *
 * All three carry a leading `+`, and all three were put there for
 * `formatPhoneNumber`'s international DISPLAY branch, not for the parser.
 *
 * What is exactly true, and is the sharper claim, is this: **of the 71 values in
 * that file that carry no `+` — every 555 fixture and all 60 digit runs — ZERO
 * reach the parsed branch.** That is the branch `DEFAULT_PHONE_REGION` governs;
 * it is the branch a bare ten-digit number typed by a US user takes; and it is
 * the branch this product's own data overwhelmingly takes. A corpus blind to it
 * is blind to the default path, which is the defect worth fixing whether or not
 * three incidental `+` values happened to parse.
 *
 * Do not "fix" the numbers in this list. Its value is that it is the old one.
 */
export const LEGACY_555_FIXTURES: readonly string[] = [
  "+15555550112",
  "15555550112",
  "1 (555) 555-0112",
  "+1-555-555-0199",
  "5555550112",
  "(555) 555-0112",
  "555.555.0100",
  "555 555 0199",
  "5550112",
  "555-0112",
  "555 0199",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The digits of a raw value — what `toMatchingKey`'s floor counts. */
export function digitCount(raw: string): number {
  return (raw.match(/\d/g) || []).length;
}

/** Just the raw strings, for suites that want values rather than expectations. */
export function rawValues(fixtures: readonly PhoneFixture[]): string[] {
  return fixtures.map((f) => f.raw);
}

/** The subset on one branch. */
export function ofClass(
  fixtures: readonly PhoneFixture[],
  parseClass: PhoneParseClass,
): PhoneFixture[] {
  return fixtures.filter((f) => f.parseClass === parseClass);
}
