/**
 * MMS participant mapping — who a message is with (BACKLOG-2975).
 *
 * An MMS has no sender field. `content://mms` has **no `address` column at
 * all** — querying it errors `no such column: address` (discriminated against a
 * bogus-column control on an API 36 emulator, BACKLOG-2973). Participants come
 * only from `content://mms/{id}/addr`, where each row carries a role code:
 *
 * ```
 * 137 = From    151 = To    130 = CC    129 = BCC
 * ```
 *
 * The tilde-separated `address="+1...~+1..."` attribute on SMS Backup &
 * Restore's `<mms>` element is **synthesised by that exporter** and does not
 * exist on the device. Nothing here reads or expects it.
 *
 * ## Why this is not simply "the From row"
 *
 * The device owner is in the addr rows too, and which row they occupy flips
 * with direction: on a SENT message the owner is the `137`, on a RECEIVED
 * message the owner is one of the `151`s. The desktop's `SyncMessage.sender`
 * means **the counterparty, not the author** —
 * `electron/services/localSyncService.ts` builds
 *
 * ```ts
 * { from: direction === "inbound" ? sender : "me",
 *   to:   direction === "inbound" ? ["me"] : [sender] }
 * ```
 *
 * so handing it the `137` of a sent message would file the broker's own words
 * under their client's name. {@link MmsParticipants.counterparties} is the
 * field that answers "who is this thread with"; {@link MmsParticipants.author}
 * is kept separately and is never a substitute for it.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not build a `SyncMessage`. `SyncMessage.sender` is a single `string`
 * and a group thread has several counterparties, so the participant SET has
 * nowhere to go without a wire-contract change plus the still-open founder
 * ruling on how a group thread appears on the desktop. The derivation is
 * complete here; the carriage is not this item's to invent.
 *
 * It also does not re-derive `direction` from `msg_box` — BACKLOG-2974's
 * mapper already resolves that, and a second implementation of a rule is the
 * same defect as a second phone normaliser.
 */

import type { RawMmsAddress } from "./mmsReader";
import { normalizePhoneNumber } from "./phoneNormalization";

/**
 * `content://mms/{id}/addr` role codes.
 *
 * Per SyncTech's documentation of the SMS Backup & Restore format. Seeding
 * these values and reading them back proves the provider STORES what it was
 * given; it does not prove the semantics. **Still unverified against a real
 * Google Messages write.** The cheap check on a real phone: a RECEIVED
 * message's `137` should be the counterparty and a SENT message's `137` should
 * be the owner's own number. If that inverts, every group thread here is
 * attributed backwards.
 */
export const MMS_ADDR_TYPE_FROM = 137;
export const MMS_ADDR_TYPE_TO = 151;
export const MMS_ADDR_TYPE_CC = 130;
export const MMS_ADDR_TYPE_BCC = 129;

/**
 * AOSP's placeholder for "the device's own number", which the platform writes
 * into an address column when it does not know the local MSISDN.
 *
 * The literal is present in this API 36 image's
 * `/system/priv-app/TelephonyProvider/TelephonyProvider.apk` and in
 * `/system/framework/framework.jar` (found with `strings`, the APK's copy
 * sitting among the other MMS insert diagnostics). **That establishes presence,
 * not behaviour** — whether a real sent MMS carries it in the `137` row is
 * still unobserved.
 *
 * It is guarded regardless, because `normalizePhoneNumber` returns it
 * UNCHANGED (its alphanumeric branch, the one that preserves "T-Mobile"), so
 * without this guard the token would flow onward as though it were a phone
 * number and could be written into an audit record as a participant nobody
 * ever messaged.
 */
export const MMS_SELF_ADDRESS_TOKEN = "insert-address-token";

/** The role an addr row declares, or `unknown` for a code we do not model. */
export type MmsParticipantRole = "from" | "to" | "cc" | "bcc" | "unknown";

/** One `content://mms/{id}/addr` row with its role and address resolved. */
export interface MmsParticipant {
  /** The address in the companion's normalised form. */
  address: string;
  /**
   * The provider's own string, trimmed and otherwise untouched.
   *
   * Kept beside the normalised value so a normalisation that mangles or fails
   * to canonicalise a number is VISIBLE rather than silently substituted — the
   * desktop matches contacts on the normalised form, so a mismatch is a
   * message that never links to anyone.
   */
  rawAddress: string;
  role: MmsParticipantRole;
}

/**
 * Why a row's participants could not be resolved.
 *
 * Every reason is direction-specific, because the two directions need
 * different rows to be attributable at all. An outbound message tolerates a
 * missing or ambiguous `137` — its counterparties are the recipients, so it
 * stays attributable and only {@link MmsParticipants.owner} goes null.
 * Dropping it would lose a real sent message over a field it does not need.
 */
export type MmsParticipantsFailureReason =
  /**
   * The row has no addr rows at all. Observed on the emulator: `_id=7` is a
   * real provider row with zero addresses.
   */
  | "no_addr_rows"
  /**
   * INBOUND only — no `137` row exists, so there is no counterparty. Observed
   * representable: the provider accepted a row with only a `151`.
   */
  | "no_from_row"
  /**
   * INBOUND only — more than one `137` row, so the counterparty is ambiguous.
   * The provider enforces no uniqueness on `type`; a two-`137` row was
   * inserted and read back on the emulator. Picking one would be a coin flip
   * recorded as evidence.
   */
  | "multiple_from_rows"
  /**
   * INBOUND only — the `137` row exists but its address cannot name a person:
   * it is empty, or it is {@link MMS_SELF_ADDRESS_TOKEN}.
   */
  | "unusable_from_address"
  /** OUTBOUND only — no usable to/cc/bcc row, so there is nobody to attribute to. */
  | "no_recipients";

export interface MmsParticipantsFailure {
  reason: MmsParticipantsFailureReason;
  /**
   * Enough to log and count the failure. Provider metadata only — role codes
   * and counts, never an address, because a diagnostic is not worth a PII path.
   */
  detail: string;
}

/** Who an MMS is with, resolved. */
export interface MmsParticipants {
  /**
   * The `137` row's address, normalised — who WROTE the message.
   *
   * `null` when there is no `137` row, when there is more than one, or when
   * its address is unusable. Only an outbound message can be resolved with a
   * null author; on an inbound message the author IS the counterparty, so its
   * absence is a failure instead.
   *
   * **Never pass this to `SyncMessage.sender`.** On a sent message it is the
   * device owner. Use {@link counterparties}.
   */
  author: string | null;
  /**
   * The `151`/`130`/`129` rows, normalised, de-duplicated by normalised form,
   * in the order the provider returned them.
   *
   * On an INBOUND message this includes the device owner — they were one of
   * the recipients — and the owner is not subtracted, because the phone does
   * not reliably know its own MSISDN.
   */
  recipients: string[];
  /**
   * **Who the thread is with, from the device owner's point of view.** This is
   * the field a `SyncMessage.sender` would be drawn from.
   *
   * - inbound  -> `[author]`, the person who wrote to us
   * - outbound -> `recipients`, the people we wrote to
   *
   * Never empty in a successful outcome. More than one element means a group,
   * which `SyncMessage` cannot currently carry — see the module docblock.
   */
  counterparties: string[];
  /**
   * The device owner's own number, when THIS message reveals it.
   *
   * Non-null only for an outbound message whose `137` is a dialable number:
   * the author of a sent message is the owner. This is the one place the
   * owner's MSISDN can be learned without a permission or a pairing field, and
   * it is null whenever the `137` is absent, ambiguous, the self-token, or any
   * non-dialable string (a short code or an alphanumeric sender is not an
   * owner).
   *
   * Nothing here accumulates it across messages — that is state, and state is
   * a decision for whoever wires this up.
   */
  owner: string | null;
  /**
   * More than one recipient — a group thread.
   *
   * Deliberately `recipients.length > 1` in BOTH directions rather than
   * "distinct parties > 2". On an inbound group the owner is one of the
   * recipients, so the count is the same either way; but the distinct-parties
   * form reads FALSE on an outbound group whose `137` is the self-token,
   * because the owner then contributes no address. This form needs neither the
   * owner's identity nor a usable `137`.
   *
   * Note the consequence: an inbound group has exactly ONE counterparty (its
   * author), so a group cannot be detected from `counterparties` alone. That
   * is precisely what a single `sender: string` loses.
   */
  isGroup: boolean;
  /**
   * Every addr row, role-resolved and in provider order — including rows with
   * an unmodelled `type`, and including duplicates that {@link recipients}
   * collapses. Nothing the provider returned is dropped from here.
   */
  all: MmsParticipant[];
}

export type MmsParticipantsOutcome =
  | { ok: true; participants: MmsParticipants }
  | { ok: false; failure: MmsParticipantsFailure };

/**
 * The addr row's `type` as a number, or null when it does not have a usable one.
 *
 * Guarded rather than passed straight to `Number()`: `Number(null)` is 0 and
 * `Number("")` is 0, and 0 is not a role code — an untyped row would silently
 * become one.
 */
export function addrType(addr: RawMmsAddress): number | null {
  const raw = addr.type;
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Map a provider role code to a role. Unmodelled codes are named, not guessed. */
export function addrRole(addr: RawMmsAddress): MmsParticipantRole {
  switch (addrType(addr)) {
    case MMS_ADDR_TYPE_FROM:
      return "from";
    case MMS_ADDR_TYPE_TO:
      return "to";
    case MMS_ADDR_TYPE_CC:
      return "cc";
    case MMS_ADDR_TYPE_BCC:
      return "bcc";
    default:
      return "unknown";
  }
}

/**
 * True when an address can stand for a person in an audit record.
 *
 * Rejects the empty string and {@link MMS_SELF_ADDRESS_TOKEN}. It does NOT
 * reject alphanumeric senders or short codes — those are real counterparties
 * for SMS today (`phoneNormalization` preserves them on purpose) and an MMS
 * from a short-code sender is a message that happened.
 */
function isUsableAddress(raw: string): boolean {
  if (raw.length === 0) return false;
  return raw.toLowerCase() !== MMS_SELF_ADDRESS_TOKEN;
}

/**
 * True when an address is a dialable number rather than a short code or a name.
 *
 * Used only for {@link MmsParticipants.owner}: the owner's number has to be a
 * real MSISDN, because its whole purpose is to be matched against the same
 * number appearing as a `151` elsewhere. `normalizePhoneNumber` emits a leading
 * `+` for exactly the inputs it resolved to a full international number, so
 * that prefix is the discriminator — and it is a second, independent reason
 * {@link MMS_SELF_ADDRESS_TOKEN} can never become an owner.
 */
function isDialable(normalized: string): boolean {
  return normalized.startsWith("+");
}

/**
 * Resolve who an MMS is with from its `content://mms/{id}/addr` rows.
 *
 * @param addrs - The row's addr rows, exactly as `mmsReader` attached them.
 * @param direction - Already resolved from `msg_box` by BACKLOG-2974's mapper
 *   (1 -> inbound, 2 -> outbound). Passed in rather than re-derived so there
 *   is one implementation of that rule, not two.
 */
export function deriveMmsParticipants(
  addrs: RawMmsAddress[],
  direction: "inbound" | "outbound"
): MmsParticipantsOutcome {
  if (addrs.length === 0) {
    return {
      ok: false,
      failure: {
        reason: "no_addr_rows",
        detail: `direction=${direction} addrs=0`,
      },
    };
  }

  // Every row, role-resolved, in provider order. Built first and never
  // filtered, so `all` can answer "what did the provider actually return".
  const all: MmsParticipant[] = addrs.map((addr) => {
    const rawAddress = (addr.address ?? "").trim();
    return {
      address: normalizePhoneNumber(rawAddress),
      rawAddress,
      role: addrRole(addr),
    };
  });

  // The From rows are selected BY ROLE, never by position. The provider
  // returns addr rows in `_id` (insertion) order, not sorted by type — an
  // inbound group seeded with its `151`s first came back with the `137` at
  // index 2. Taking position 0 hands back a recipient and calls it the sender.
  const fromRows = all.filter((p) => p.role === "from");
  const recipientRows = all.filter(
    (p) => p.role === "to" || p.role === "cc" || p.role === "bcc"
  );

  // De-duplicate by NORMALISED form, keeping provider order. Two spellings of
  // one number ("(206) 555-0101" and "+12065550101") are one participant; the
  // raw rows both survive in `all`.
  const recipients: string[] = [];
  for (const row of recipientRows) {
    if (!isUsableAddress(row.rawAddress)) continue;
    if (!recipients.includes(row.address)) recipients.push(row.address);
  }

  const usableFrom =
    fromRows.length === 1 && isUsableAddress(fromRows[0].rawAddress)
      ? fromRows[0]
      : null;
  const author = usableFrom ? usableFrom.address : null;

  // A sent message's author IS the device owner — the one place that number
  // can be learned without a permission.
  const owner =
    direction === "outbound" && author !== null && isDialable(author)
      ? author
      : null;

  const isGroup = recipients.length > 1;

  if (direction === "inbound") {
    // The From is the counterparty, so its absence or ambiguity is fatal here
    // and only here.
    if (fromRows.length === 0) {
      return {
        ok: false,
        failure: {
          reason: "no_from_row",
          detail: `direction=inbound addrs=${addrs.length} from=0 recipients=${recipientRows.length}`,
        },
      };
    }
    if (fromRows.length > 1) {
      return {
        ok: false,
        failure: {
          reason: "multiple_from_rows",
          detail: `direction=inbound addrs=${addrs.length} from=${fromRows.length}`,
        },
      };
    }
    if (author === null) {
      return {
        ok: false,
        failure: {
          reason: "unusable_from_address",
          detail: `direction=inbound addrs=${addrs.length} from=1 usable=false`,
        },
      };
    }
    return {
      ok: true,
      participants: {
        author,
        recipients,
        counterparties: [author],
        owner,
        isGroup,
        all,
      },
    };
  }

  // Outbound: the counterparties are the recipients. A missing or ambiguous
  // `137` costs us `owner`, not the message.
  if (recipients.length === 0) {
    return {
      ok: false,
      failure: {
        reason: "no_recipients",
        detail: `direction=outbound addrs=${addrs.length} from=${fromRows.length} recipients=0`,
      },
    };
  }
  return {
    ok: true,
    participants: {
      author,
      recipients,
      // A copy, not the same array: `counterparties` and `recipients` are the
      // same VALUE here but not the same field, and a caller mutating one must
      // not silently rewrite the other.
      counterparties: [...recipients],
      owner,
      isGroup,
      all,
    },
  };
}
