/**
 * BACKLOG-3941 — form registry types.
 *
 * The registry is DATA: one row per publisher (its header grammar) and one row per form.
 * The matcher (formMatcher.ts) is pure and reads only these rows.
 *
 * Not every publisher prints a form code (some print only title + publisher + revision).
 * So the code line is a per-publisher marker (`header.codeLine`, optional) and a form row's
 * `code` is optional. Only code-line publishers are matched today; no title-keyed rows ship.
 */

export type FormKind =
  | "purchase_agreement"
  | "buyer_agreement"
  | "listing_agreement"
  | "counteroffer"
  | "representation_termination"
  | "other";

export interface PublisherHeader {
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

export interface PublisherRow {
  /** Stable key, e.g. "nwmls". */
  id: string;
  name: string;
  /** Required marker: the publisher's name, whitespace-tolerant. */
  namePattern: RegExp;
  region: { country: "US"; state: string };
  header: PublisherHeader;
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
}

export interface Registry {
  publishers: readonly PublisherRow[];
  forms: readonly FormRow[];
  /** `${publisherId}\u0000${code}` -> row. Built and validated by buildRegistry. */
  byCode: ReadonlyMap<string, FormRow>;
}

export type MatchStrength = "footer" | "footer+title";

export interface FormMatch {
  /** null = the header grammar matched a code that is not in the registry. */
  formId: string | null;
  publisherId: string;
  /** null only for a future title-keyed publisher. */
  code: string | null;
  kind: FormKind | null;
  strength: MatchStrength;
  /** Header hits for this form (about one per page for a born-digital form). */
  occurrences: number;
  /** Offset into the ORIGINAL text of the first code line. */
  firstOffset: number;
  /**
   * The matched header block, verbatim from the original text, at most `windowChars` long.
   * It is document content: never log it, print it, or send it anywhere.
   */
  evidence: string;
  /** Revision as printed at the first hit, e.g. "8/24". Display only. */
  revisionSeen: string | null;
}
