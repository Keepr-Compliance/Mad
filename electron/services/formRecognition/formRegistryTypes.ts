/**
 * BACKLOG-3941 — form registry types.
 *
 * The registry is DATA: one row per publisher (its header grammar) and one row per form.
 * The matcher (formMatcher.ts) is pure and reads only these rows.
 *
 * Not every publisher prints a form code (some print only title + publisher + revision).
 * So the code line is a per-publisher marker (`header.codeLine`, optional) and a form row's
 * `code` is optional.
 *
 * BACKLOG-4106 (v2): a publisher's header carries a marker KIND (`header.kind`). A form row takes
 * its kind from its publisher, so there is one source of truth; buildRegistry checks each row's
 * shape against it.
 *   code-line    v1 (`PublisherHeader`, `kind` absent or "code-line"). Unchanged.
 *   code-page    a page line that starts with the code (C.A.R., Oregon REALTORS, DRE).
 *   mid-line     a marker anywhere in a line, publisher token inside the match (OREF).
 *   title-keyed  a printed title is the anchor (BACKLOG-4106 PR 2). Placement "line": the title is
 *                one whole line or several consecutive whole lines. Placement "adjacent": the title
 *                starts a line and is followed on that line by the publisher's revision
 *                (`anchorTemplate`). Rows report registered titles only (formId never null).
 *
 * Publisher name, per kind:
 *   code-line    `PublisherRow.namePattern` is the R3 gate (inside the window).
 *   other kinds  `namePattern` is NOT read by the matcher. The publisher proof is in the header:
 *                `requiredMarkers` (in the window), `documentMarkers` (anywhere in the text) or
 *                `pairedToken` (C.A.R.'s per-page token). buildRegistry rejects a windowed
 *                publisher that has none of the three.
 *
 * Declared revision (windowed kinds): the revision is capture group 2 of the anchor match when the
 * anchor has one and it matched; otherwise the first match of `header.revision` (group 1) in the
 * window, or in the whole text when `revisionScope` is "document". Title-keyed adjacent: the
 * anchor's named group `rev`. The revision is a GATE: no revision found -> no match. Every
 * windowed header must set `revisionRequired: true` (founder ruling F4 on BACKLOG-4106: every match
 * carries its revision); buildRegistry rejects `false`, and rejects a header with no revision
 * source. A row whose blank source prints no reliable revision is held. Revision is never part of a
 * key.
 *
 * Known titles (`FormRow.knownTitles`, strength only) are tested against the WHOLE window,
 * including the part before the anchor (`windowBefore`). Harmless for the shipped rows: their
 * titles print next to the anchor.
 */

export type FormKind =
  | "purchase_agreement"
  | "buyer_agreement"
  | "listing_agreement"
  | "counteroffer"
  | "representation_termination"
  | "other";

export type MarkerKind = "code-line" | "code-page" | "mid-line" | "title-keyed";

/** v1 code-line header. `kind` is optional so every v1 row compiles unchanged. */
export interface PublisherHeader {
  kind?: "code-line";
  /**
   * The publisher's code line, as a WHOLE-LINE pattern (`^…$`, flag `m`). Capture group 1 is
   * the full code token, which is looked up EXACTLY in the registry (no prefix match).
   * Absent for a publisher whose forms carry no code.
   */
  codeLine?: RegExp;
  /** Markers that must each lie wholly inside the window (besides `namePattern` and `revision`). */
  requiredMarkers: RegExp[];
  /** Revision marker, required. Capture group 1 is the revision as printed, e.g. "8/24". */
  revision: RegExp;
  /** Window in characters, measured from the START of the code line. */
  windowChars: number;
}

/**
 * Shared by the windowed kinds. The window is [anchorStart - windowBefore, anchorStart + windowAfter],
 * anchorStart = `FormMatch.firstOffset`. A marker counts only when its match lies wholly inside.
 */
export interface WindowedHeader {
  /** Each must lie wholly inside the window. */
  requiredMarkers: RegExp[];
  /** Each must occur somewhere in the text (tested once per text). */
  documentMarkers?: RegExp[];
  /** Separate revision marker; group 1 = revision as printed. See "Declared revision" above. */
  revision?: RegExp;
  /** Where `revision` is looked for. Default "window". */
  revisionScope?: "window" | "document";
  /** Must be true (F4): the revision is a gate. `boolean` only so a false row fails at load. */
  revisionRequired: boolean;
  /** May be 0 (no marker before the anchor). */
  windowBefore: number;
  /** Must be positive. */
  windowAfter: number;
}

export interface CodePageHeader extends WindowedHeader {
  kind: "code-page";
  /**
   * Page line that STARTS with the code (flag `m`; `g` is added by the matcher). Group 1 = the
   * code; optional group 2 = the revision. No `$`: initials and stamps can be glued after it.
   * The page total is matched and discarded, never captured into a key.
   */
  codePage: RegExp;
  /**
   * What may precede the code inside the match (line-start spaces, a glued watermark). Used to
   * find the code's offset. Default: line-start spaces only.
   */
  leadingNoise?: RegExp;
  /** The code must be printed in upper case (for a `codePage` with the `i` flag). */
  codeUpperCase?: boolean;
  /** Per-code second marker that must lie wholly inside the window (C.A.R. "(RPA PAGE n OF N)"). */
  pairedToken?: (code: string) => RegExp;
  /** false = a code that is not registered is dropped, not reported as `?code`. */
  reportUnregistered: boolean;
}

export interface MidLineHeader extends WindowedHeader {
  kind: "mid-line";
  /**
   * Marker anywhere in a line: no `^`, no `$`. The publisher token is INSIDE the match.
   * Group 1 = the code; group 2 = the revision.
   */
  marker: RegExp;
  reportUnregistered: boolean;
}

/**
 * Title-keyed (BACKLOG-4106 PR 2). The anchor is a row's `titleKey`, matched case-sensitively on
 * normalised text and always at the START of a line (after line-start spaces):
 *   line      the title is one whole line, or consecutive whole lines joined by \n.
 *   adjacent  `anchorTemplate` with "{title}" replaced by the title source; it must carry the
 *             named group (?<rev>…), which is the revision.
 * firstOffset is the start of the title. Where two rows' title spans overlap in one place, the
 * longer span wins there (a 2-line title that contains another row's 1-line title); elsewhere in
 * the same text the shorter row still matches.
 */
export interface TitleKeyedHeader extends WindowedHeader {
  kind: "title-keyed";
  placement: "adjacent" | "line";
  /** adjacent only: regex source containing "{title}" and the named group (?<rev>…). */
  anchorTemplate?: string;
}

export type Header = PublisherHeader | CodePageHeader | MidLineHeader | TitleKeyedHeader;

export interface PublisherRow {
  /** Stable key, e.g. "nwmls". */
  id: string;
  name: string;
  /**
   * The publisher's name, whitespace-tolerant. code-line: the R3 gate. Other kinds: not read by
   * the matcher (see the file header).
   */
  namePattern: RegExp;
  region: { country: "US"; state: string };
  header: Header;
}

export interface FormRow {
  /** Stable key, e.g. "nwmls-41". */
  id: string;
  publisherId: string;
  /**
   * Exact code token as printed ("41", "1A-SWF") — never a prefix. Required for a publisher
   * with a `codeLine`; absent for a title-keyed row, whose `knownTitles` then identify it.
   */
  code?: string;
  kind: FormKind;
  /** Raises match strength; never a gate for a coded row. Written against NORMALISED text. */
  knownTitles: RegExp[];
  /** Documentation only — the matcher never keys on revision. */
  observedRevisions: string[];
  /** Fixture ids (in __tests__/fixtures) that prove this row matches real producer output. */
  sampleProvenance: string[];
  /**
   * title-keyed rows only: regex source of the printed title (for placement "line", one whole line
   * or several consecutive whole lines joined by \n). Matched case-sensitively on normalised text.
   */
  titleKey?: RegExp[];
}

export interface Registry {
  publishers: readonly PublisherRow[];
  forms: readonly FormRow[];
  /** `${publisherId}\u0000${code}` -> row. Built and validated by buildRegistry. */
  byCode: ReadonlyMap<string, FormRow>;
  /** publisherId -> its title-keyed rows. */
  byTitle: ReadonlyMap<string, readonly FormRow[]>;
}

/** Title-keyed matches are always "footer+title": the title is the anchor. */
export type MatchStrength = "footer" | "footer+title";

export interface FormMatch {
  /** null = the header grammar matched a code that is not in the registry. */
  formId: string | null;
  publisherId: string;
  /** Title-keyed rows: the row's printed number when it has one (display only), else null. */
  code: string | null;
  kind: FormKind | null;
  strength: MatchStrength;
  /** Header hits for this form (about one per page for a born-digital form). */
  occurrences: number;
  /** Offset into the ORIGINAL text of the first code line (windowed kinds: of the anchor). */
  firstOffset: number;
  /**
   * The matched header block, verbatim from the original text, at most `windowChars` long
   * (windowed kinds: at most EVIDENCE_CAP = 400 chars, starting at `firstOffset`).
   * It is document content: never log it, print it, or send it anywhere.
   */
  evidence: string;
  /** Revision as printed at the first hit, e.g. "8/24". Display only. */
  revisionSeen: string | null;
}
