/**
 * Per-email deal signals — BACKLOG-4257 (M3), PR1.
 *
 * `EmailSignals` is the record that leaves the extractor. It holds counts,
 * booleans and closed enums ONLY: no address, no subject, no sender, no
 * filename, no document text. The one string-typed field is
 * `forms.matches[].formId`, which is a bundled registry id (e.g. "nwmls-21"),
 * never document content; the tests assert every emitted id is in the
 * registry.
 *
 * Address keys are returned beside the record (`ExtractedSignals.addressKeys`),
 * for in-memory grouping only. They must never be serialized, logged or sent.
 *
 * Reserved for a later version (not built here): a signed client-agreement
 * signal under `forms`. Adding it bumps `EMAIL_SIGNALS_VERSION`.
 */
import type { FormKind, Registry } from "../formRecognition/formRegistryTypes";
import type { SenderRuleSet } from "../../utils/senderFilter/bundledRules";
import type { KeepSets } from "../../utils/senderFilter/senderFilter";

/** Version of the EmailSignals shape. Bump on any field change. */
export const EMAIL_SIGNALS_VERSION = 1 as const;

/**
 * Where the strongest address occurrence sits, strongest first:
 * subject > bodyTop > bodyMid > afterSignature > footer. `none` = no address
 * in the subject or the sender's own text.
 */
export type AnchorPlacement = "subject" | "bodyTop" | "bodyMid" | "afterSignature" | "footer" | "none";

/**
 * Sender tier, evaluated in this order (first match wins):
 *   dealContact        the From address is a contact on a non-rejected deal (K1)
 *   vendorRoleDomain   the From host is a domain of a lender / mortgage broker /
 *                      title / escrow contact on the user's deals (per user)
 *   dealContactDomain  the From host is a non-free-mail domain of a deal contact (K3)
 *   platform           a deal-platform host or address (rule set keep.platform*)
 *   freeMail           a free-mail / ISP domain (rule set freeMailDomains)
 *   other              anything else, including no parsable From address
 */
export type SenderTier = "dealContact" | "vendorRoleDomain" | "dealContactDomain" | "platform" | "freeMail" | "other";

/** The strongest class any attachment filename falls in (see signalTerms FILENAME_CLASSES). */
export type FilenameClass =
  | "purchaseAgreement"
  | "counteroffer"
  | "addendum"
  | "inspection"
  | "appraisal"
  | "closing"
  | "disclosure"
  | "listing"
  | "other"
  | "none";

export interface AnchorSignals {
  /** Distinct accepted addresses in the subject + own text. */
  count: number;
  placement: AnchorPlacement;
  /** A footer cue (unsubscribe, copyright, ...) sits within a few lines of an address occurrence. */
  nearFooterCue: boolean;
  /** No address in subject / own text, but at least one in the quoted part. */
  inQuoteOnly: boolean;
}

export interface StageSignals {
  offer: boolean;
  counter: boolean;
  underContract: boolean;
  inspection: boolean;
  appraisal: boolean;
  closing: boolean;
  /** Some stage term is in the subject. */
  inSubject: boolean;
  /**
   * Every stage found anywhere in the message (quotes included) is also found
   * in the subject or own text. False when the quoted part carries a stage
   * the sender's own words do not.
   */
  ownTextOnly: boolean;
}

export interface SenderSignals {
  tier: SenderTier;
  /** Some To / Cc recipient is a deal contact (K1). */
  recipientIsDealContact: boolean;
  /** The message carries bulk-mail headers (rule set suppress.bulkHeaders). */
  bulk: boolean;
}

export interface FormSignalMatch {
  /** Bundled registry id; never document text. */
  formId: string;
  kind: FormKind;
  occurrences: number;
}

export interface FormSignals {
  attachments: number;
  /** Attachments with extracted text; form matches are only possible on these. */
  attachmentsWithText: number;
  matches: FormSignalMatch[];
  filenameClass: FilenameClass;
}

export interface EmailSignals {
  v: typeof EMAIL_SIGNALS_VERSION;
  anchor: AnchorSignals;
  stage: StageSignals;
  sender: SenderSignals;
  forms: FormSignals;
}

/** One message as the extractor reads it. */
export interface EmailSignalInput {
  subject: string | null | undefined;
  /** Raw HTML body (emails.body_html). Preferred when present. */
  bodyHtml: string | null | undefined;
  /** Plain body (emails.body_plain). Used only when there is no HTML body. */
  bodyPlain: string | null | undefined;
  /** From header text. */
  sender: string | null | undefined;
  /** To + Cc header text. */
  recipients?: string | null;
  /** Stored bulk-mail header JSON (emails.bulk_mail_headers) or the parsed object. */
  bulkMailHeaders?: string | Readonly<Record<string, unknown>> | null;
  attachments?: ReadonlyArray<{ filename: string | null | undefined; textContent: string | null | undefined }>;
}

/** Per-user context, supplied by the caller. */
export interface SignalContext {
  rules: SenderRuleSet;
  keep: KeepSets;
  /** Lowercased hosts of the user's lender / mortgage broker / title / escrow deal contacts. */
  vendorRoleDomains: ReadonlySet<string>;
  /** Form registry; defaults to the bundled one. */
  registry?: Registry;
}

export interface ExtractedSignals {
  signals: EmailSignals;
  /** In-memory only. Never serialize, log or send. */
  addressKeys: readonly string[];
  /** The body was longer than MAX_BODY_CHARS and its tail was not read. */
  bodyTruncated: boolean;
}
