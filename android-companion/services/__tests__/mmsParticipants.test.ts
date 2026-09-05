/**
 * BACKLOG-2975 — who an MMS is with.
 *
 * ## Fixture provenance — read this before trusting a fixture
 *
 * **The five named constants below are TRANSCRIBED** from rows read off a live
 * API 36 emulator (AVD `keepr_vc_check`) with `adb shell content query`. Each
 * one names the `content://mms/{id}/addr` it came from. What is transcribed is
 * the `address` and `type` of each row and their ORDER — the `addr()` helper
 * stamps a placeholder `_id: "1"` on every row, so the `_id`s here are NOT the
 * device's and nothing asserts on them.
 *
 * **Every fixture written inline inside a test is CONSTRUCTED** — cc/bcc roles,
 * the From-in-the-middle row, all of the self-token rows, the alphanumeric and
 * short-code senders, the null address, the unmodelled type code, the padded
 * `" 137 "`. The provider stores what it is given and the seed was written in
 * one format, so the device corpus cannot exercise any of them. They are
 * shapes the provider's column types permit, not shapes it was observed to
 * produce.
 *
 * All numbers are the reserved `+1 206 555-01xx` range.
 */

import type { RawMmsAddress } from "../mmsReader";
import {
  MMS_ADDR_TYPE_BCC,
  MMS_ADDR_TYPE_CC,
  MMS_ADDR_TYPE_FROM,
  MMS_ADDR_TYPE_TO,
  MMS_SELF_ADDRESS_TOKEN,
  addrRole,
  addrType,
  deriveMmsParticipants,
  type MmsParticipants,
  type MmsParticipantsOutcome,
} from "../mmsParticipants";

/** One addr row in the shape `mmsReader` attaches it. */
function addr(address: string | null, type: number | string | null): RawMmsAddress {
  return {
    _id: "1",
    address,
    type: type === null ? null : String(type),
    charset: "106",
  };
}

/**
 * Assert the outcome RESOLVED before anything is asserted about its contents.
 *
 * Without this every participant assertion below could be satisfied by a
 * failure outcome that produced no participants at all — a test that cannot
 * fail because nothing ran. That shape has appeared three times on this branch.
 */
function expectResolved(outcome: MmsParticipantsOutcome): MmsParticipants {
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error(
      `expected a resolved outcome, got failure: ${outcome.failure.reason}`
    );
  }
  return outcome.participants;
}

function expectFailure(outcome: MmsParticipantsOutcome) {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) {
    throw new Error("expected a failure outcome, got resolved participants");
  }
  return outcome.failure;
}

// ---------------------------------------------------------------------------
// Device-transcribed rows
// ---------------------------------------------------------------------------

/** `content://mms/3/addr` — thread 12, `msg_box=2` (SENT), a three-party group. */
const SENT_GROUP: RawMmsAddress[] = [
  addr("+12065550100", MMS_ADDR_TYPE_FROM), // the device owner
  addr("+12065550101", MMS_ADDR_TYPE_TO),
  addr("+12065550102", MMS_ADDR_TYPE_TO),
];

/** `content://mms/2/addr` — thread 11, `msg_box=1` (RECEIVED), one to one. */
const RECEIVED_ONE_TO_ONE: RawMmsAddress[] = [
  addr("+12065550111", MMS_ADDR_TYPE_FROM), // the counterparty
  addr("+12065550100", MMS_ADDR_TYPE_TO), // the device owner
];

/**
 * `content://mms/8/addr` — thread 15, `msg_box=1` (RECEIVED), a three-party
 * group, seeded with its two `151` rows FIRST so the provider returned the
 * `137` at index 2. This is the row that makes "take position 0" a real defect
 * rather than a hypothetical one.
 */
const RECEIVED_GROUP_FROM_LAST: RawMmsAddress[] = [
  addr("+12065550100", MMS_ADDR_TYPE_TO), // the device owner
  addr("+12065550112", MMS_ADDR_TYPE_TO), // a third party
  addr("+12065550111", MMS_ADDR_TYPE_FROM), // the counterparty, at index 2
];

/** `content://mms/9/addr` — the provider accepted TWO `137` rows. */
const TWO_FROM_ROWS: RawMmsAddress[] = [
  addr("+12065550111", MMS_ADDR_TYPE_FROM),
  addr("+12065550113", MMS_ADDR_TYPE_FROM),
  addr("+12065550100", MMS_ADDR_TYPE_TO),
];

/** `content://mms/10/addr` — the provider accepted a row with NO `137`. */
const NO_FROM_ROW: RawMmsAddress[] = [addr("+12065550100", MMS_ADDR_TYPE_TO)];

describe("BACKLOG-2975 — deriveMmsParticipants", () => {
  // -------------------------------------------------------------------------
  // CONTROL 1 — a group thread's participants are all present
  // Mutation: take only the first `151` row.
  // -------------------------------------------------------------------------
  describe("a group thread keeps every participant (device rows mms/3 and mms/8)", () => {
    it("a SENT group carries both recipients, as an exact set", () => {
      const p = expectResolved(deriveMmsParticipants(SENT_GROUP, "outbound"));

      // Exact set, not a count: a count is satisfied by a drop and a
      // substitution cancelling out.
      expect(p.recipients).toEqual(["+12065550101", "+12065550102"]);
      expect(p.counterparties).toEqual(["+12065550101", "+12065550102"]);
      expect(p.isGroup).toBe(true);
    });

    it("a RECEIVED group carries both of the To rows even though only one is the counterparty", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_GROUP_FROM_LAST, "inbound")
      );

      expect(p.recipients).toEqual(["+12065550100", "+12065550112"]);
      expect(p.isGroup).toBe(true);
    });

    it("an inbound group has exactly ONE counterparty — which is why a single `sender` loses it", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_GROUP_FROM_LAST, "inbound")
      );

      // The finding this item reports: `isGroup` cannot be recovered from
      // `counterparties` on an inbound message. A `SyncMessage` carrying only
      // `sender` would render this three-party thread as a two-party one.
      expect(p.counterparties).toEqual(["+12065550111"]);
      expect(p.counterparties).toHaveLength(1);
      expect(p.isGroup).toBe(true);
    });

    it("a one-to-one thread is NOT a group", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_ONE_TO_ONE, "inbound")
      );

      expect(p.isGroup).toBe(false);
      expect(p.recipients).toEqual(["+12065550100"]);
    });

    it("cc and bcc rows are recipients too, not silently dropped", () => {
      const rows = [
        addr("+12065550100", MMS_ADDR_TYPE_FROM),
        addr("+12065550101", MMS_ADDR_TYPE_TO),
        addr("+12065550102", MMS_ADDR_TYPE_CC),
        addr("+12065550103", MMS_ADDR_TYPE_BCC),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "outbound"));

      expect(p.recipients).toEqual([
        "+12065550101",
        "+12065550102",
        "+12065550103",
      ]);
      expect(p.isGroup).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 2 — direction. The one that misattributes evidence.
  // Mutation: swap the inbound/outbound branch.
  // -------------------------------------------------------------------------
  describe("direction decides which rows are the counterparty", () => {
    it("a SENT message is attributed to its recipients, NEVER to its `137`", () => {
      const p = expectResolved(deriveMmsParticipants(SENT_GROUP, "outbound"));

      expect(p.counterparties).toEqual(["+12065550101", "+12065550102"]);
      // The `137` of a sent message is the broker themself. If it ever reaches
      // `SyncMessage.sender` the desktop files the broker's own words under
      // their client's name.
      expect(p.counterparties).not.toContain("+12065550100");
      expect(p.author).toBe("+12065550100");
    });

    it("a RECEIVED message is attributed to its `137`, NEVER to its To rows", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_ONE_TO_ONE, "inbound")
      );

      expect(p.counterparties).toEqual(["+12065550111"]);
      // The owner is the To row on a received message and must not be the
      // counterparty — that would make every inbound thread appear to be with
      // the broker themself.
      expect(p.counterparties).not.toContain("+12065550100");
    });

    it("the SAME rows resolve to DIFFERENT counterparties in the two directions", () => {
      // A single fixture read both ways: this is the assertion the direction
      // mutation cannot satisfy in both halves at once.
      const inbound = expectResolved(
        deriveMmsParticipants(RECEIVED_ONE_TO_ONE, "inbound")
      );
      const outbound = expectResolved(
        deriveMmsParticipants(RECEIVED_ONE_TO_ONE, "outbound")
      );

      expect(inbound.counterparties).toEqual(["+12065550111"]);
      expect(outbound.counterparties).toEqual(["+12065550100"]);
      expect(inbound.counterparties).not.toEqual(outbound.counterparties);
    });

    it("the owner's own number is learned from a SENT `137`, and never from a received one", () => {
      const sent = expectResolved(deriveMmsParticipants(SENT_GROUP, "outbound"));
      const received = expectResolved(
        deriveMmsParticipants(RECEIVED_ONE_TO_ONE, "inbound")
      );

      expect(sent.owner).toBe("+12065550100");
      // On a received message the `137` is the counterparty. Reading it as the
      // owner would poison every later owner-exclusion with a client's number.
      expect(received.owner).toBeNull();
      expect(received.author).toBe("+12065550111");
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 3 — the `137` row is the sender, not position 0.
  // Mutation: select the From by index instead of by role.
  // -------------------------------------------------------------------------
  describe("the From row is selected by role, never by position", () => {
    it("finds the `137` when the provider returns it LAST (device row mms/8)", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_GROUP_FROM_LAST, "inbound")
      );

      // Index 0 of this row is +12065550100, the device owner. A positional
      // reader reports the broker as the person who messaged them.
      expect(p.author).toBe("+12065550111");
      expect(p.counterparties).toEqual(["+12065550111"]);
      expect(p.author).not.toBe(RECEIVED_GROUP_FROM_LAST[0].address);
    });

    it("finds the `137` when it is in the MIDDLE", () => {
      const rows = [
        addr("+12065550101", MMS_ADDR_TYPE_TO),
        addr("+12065550111", MMS_ADDR_TYPE_FROM),
        addr("+12065550102", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      expect(p.author).toBe("+12065550111");
      expect(p.recipients).toEqual(["+12065550101", "+12065550102"]);
    });

    it("a recipient at index 0 never becomes the author", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_GROUP_FROM_LAST, "inbound")
      );

      expect(p.recipients).toContain("+12065550100");
      expect(p.author).not.toBe("+12065550100");
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 4 — normalisation matches the form the desktop matches contacts on.
  // Mutation: bypass `normalizePhoneNumber`.
  // -------------------------------------------------------------------------
  describe("addresses are normalised through the existing normaliser", () => {
    it("three spellings of ONE number collapse to one participant", () => {
      // Constructed, like every inline fixture here — the emulator seed was
      // written in a single format, so the device corpus cannot exercise this.
      // The shapes are the ones `phoneNormalization` documents as reaching the
      // SMS path.
      const rows = [
        addr("+12065550100", MMS_ADDR_TYPE_FROM),
        addr("(206) 555-0101", MMS_ADDR_TYPE_TO),
        addr("2065550101", MMS_ADDR_TYPE_TO),
        addr("+12065550101", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "outbound"));

      // One person, not three. Un-normalised, the desktop matches a contact on
      // "+12065550101" and the other two spellings link to nobody.
      expect(p.recipients).toEqual(["+12065550101"]);
      expect(p.isGroup).toBe(false);
    });

    it("emits the E.164 form the desktop matches on, not the provider's spelling", () => {
      const rows = [
        addr("206-555-0111", MMS_ADDR_TYPE_FROM),
        addr("(206) 555-0100", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      expect(p.author).toBe("+12065550111");
      expect(p.counterparties).toEqual(["+12065550111"]);
      expect(p.recipients).toEqual(["+12065550100"]);
    });

    it("keeps the provider's own spelling beside the normalised one", () => {
      const rows = [
        addr("206-555-0111", MMS_ADDR_TYPE_FROM),
        addr("(206) 555-0100", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      // A normalisation that mangles a number has to stay VISIBLE — otherwise
      // a message that links to nobody looks identical to one that links.
      expect(p.all.map((a) => a.rawAddress)).toEqual([
        "206-555-0111",
        "(206) 555-0100",
      ]);
      expect(p.all.map((a) => a.address)).toEqual([
        "+12065550111",
        "+12065550100",
      ]);
    });

    it("preserves an alphanumeric sender rather than normalising it away", () => {
      // `phoneNormalization` keeps these on purpose: stripping non-digits would
      // produce an empty string and hide the message entirely.
      const rows = [
        addr("T-Mobile", MMS_ADDR_TYPE_FROM),
        addr("+12065550100", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      expect(p.author).toBe("T-Mobile");
      expect(p.counterparties).toEqual(["T-Mobile"]);
    });

    it("an alphanumeric or short-code `137` is a counterparty but never an OWNER", () => {
      const shortCode = [
        addr("72645", MMS_ADDR_TYPE_FROM),
        addr("+12065550100", MMS_ADDR_TYPE_TO),
      ];
      const outbound = expectResolved(
        deriveMmsParticipants(shortCode, "outbound")
      );

      expect(outbound.author).toBe("72645");
      // A short code is not a phone the broker owns. Recording it as the owner
      // would exclude a real short-code counterparty from every later thread.
      expect(outbound.owner).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CONTROL 5 — the platform's self-address placeholder is not a person.
  // Mutation: drop the token guard.
  // -------------------------------------------------------------------------
  describe("the platform self-address token is never treated as a participant", () => {
    it("a SENT message whose `137` is the token still resolves — with no owner", () => {
      const rows = [
        addr(MMS_SELF_ADDRESS_TOKEN, MMS_ADDR_TYPE_FROM),
        addr("+12065550101", MMS_ADDR_TYPE_TO),
        addr("+12065550102", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "outbound"));

      // The message is still fully attributable: its counterparties are the
      // recipients. Only the owner is unknown.
      expect(p.counterparties).toEqual(["+12065550101", "+12065550102"]);
      expect(p.owner).toBeNull();
      expect(p.author).toBeNull();
      // And the group is still a group — this is why `isGroup` is
      // `recipients.length > 1` and not a distinct-party count.
      expect(p.isGroup).toBe(true);
    });

    it("the token never reaches `counterparties` on a RECEIVED message", () => {
      const rows = [
        addr(MMS_SELF_ADDRESS_TOKEN, MMS_ADDR_TYPE_FROM),
        addr("+12065550100", MMS_ADDR_TYPE_TO),
      ];
      const failure = expectFailure(deriveMmsParticipants(rows, "inbound"));

      // Resolving this would write the literal string "insert-address-token"
      // into an audit record as the person who sent the message.
      expect(failure.reason).toBe("unusable_from_address");
    });

    it("the token is excluded from recipients", () => {
      const rows = [
        addr("+12065550111", MMS_ADDR_TYPE_FROM),
        addr(MMS_SELF_ADDRESS_TOKEN, MMS_ADDR_TYPE_TO),
        addr("+12065550112", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      expect(p.recipients).toEqual(["+12065550112"]);
      expect(p.recipients).not.toContain(MMS_SELF_ADDRESS_TOKEN);
      // Still carried in `all`, because the provider did return it.
      expect(p.all.map((a) => a.rawAddress)).toContain(MMS_SELF_ADDRESS_TOKEN);
    });

    it("is matched case-insensitively", () => {
      const rows = [
        addr("INSERT-ADDRESS-TOKEN", MMS_ADDR_TYPE_FROM),
        addr("+12065550101", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "outbound"));

      expect(p.owner).toBeNull();
      expect(p.author).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The `137` edge cases the brief asked to be ESTABLISHED, not assumed.
  // Both shapes were inserted into the provider and read back on API 36.
  // -------------------------------------------------------------------------
  describe("zero and multiple `137` rows — both are representable in the provider", () => {
    it("a RECEIVED message with no `137` is a named failure, not a guess (device row mms/10)", () => {
      const failure = expectFailure(
        deriveMmsParticipants(NO_FROM_ROW, "inbound")
      );

      expect(failure.reason).toBe("no_from_row");
      expect(failure.detail).toContain("from=0");
    });

    it("a RECEIVED message with TWO `137` rows is ambiguous, not a coin flip (device row mms/9)", () => {
      const failure = expectFailure(
        deriveMmsParticipants(TWO_FROM_ROWS, "inbound")
      );

      expect(failure.reason).toBe("multiple_from_rows");
      expect(failure.detail).toContain("from=2");
    });

    it("a SENT message SURVIVES a missing `137` — its counterparties are the recipients", () => {
      const p = expectResolved(deriveMmsParticipants(NO_FROM_ROW, "outbound"));

      // Failing this would discard a real sent message over a field it does
      // not need. The `137` only ever told us the owner.
      expect(p.counterparties).toEqual(["+12065550100"]);
      expect(p.author).toBeNull();
      expect(p.owner).toBeNull();
    });

    it("a SENT message SURVIVES two `137` rows, with an unknown owner", () => {
      const p = expectResolved(deriveMmsParticipants(TWO_FROM_ROWS, "outbound"));

      expect(p.counterparties).toEqual(["+12065550100"]);
      expect(p.author).toBeNull();
      expect(p.owner).toBeNull();
    });

    it("no addr rows at all is a named failure in either direction (device row mms/7)", () => {
      expect(expectFailure(deriveMmsParticipants([], "inbound")).reason).toBe(
        "no_addr_rows"
      );
      expect(expectFailure(deriveMmsParticipants([], "outbound")).reason).toBe(
        "no_addr_rows"
      );
    });

    it("a SENT message with nothing to send to is a named failure", () => {
      const rows = [addr("+12065550100", MMS_ADDR_TYPE_FROM)];
      const failure = expectFailure(deriveMmsParticipants(rows, "outbound"));

      expect(failure.reason).toBe("no_recipients");
    });

    it("an empty `137` address fails rather than naming nobody", () => {
      const rows = [addr("", MMS_ADDR_TYPE_FROM), addr("+12065550100", MMS_ADDR_TYPE_TO)];

      expect(expectFailure(deriveMmsParticipants(rows, "inbound")).reason).toBe(
        "unusable_from_address"
      );
    });

    it("a null address is not a participant", () => {
      const rows = [
        addr("+12065550111", MMS_ADDR_TYPE_FROM),
        addr(null, MMS_ADDR_TYPE_TO),
        addr("+12065550112", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      expect(p.recipients).toEqual(["+12065550112"]);
      expect(p.isGroup).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Role codes
  // -------------------------------------------------------------------------
  describe("role codes are read from `type`, and an unmodelled code is named", () => {
    it("maps the four documented codes", () => {
      expect(addrRole(addr("+12065550100", MMS_ADDR_TYPE_FROM))).toBe("from");
      expect(addrRole(addr("+12065550100", MMS_ADDR_TYPE_TO))).toBe("to");
      expect(addrRole(addr("+12065550100", MMS_ADDR_TYPE_CC))).toBe("cc");
      expect(addrRole(addr("+12065550100", MMS_ADDR_TYPE_BCC))).toBe("bcc");
    });

    it("an unmodelled code is `unknown`, never folded into a recipient", () => {
      expect(addrRole(addr("+12065550100", 999))).toBe("unknown");

      const rows = [
        addr("+12065550111", MMS_ADDR_TYPE_FROM),
        addr("+12065550199", 999),
        addr("+12065550100", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "inbound"));

      expect(p.recipients).toEqual(["+12065550100"]);
      // Nothing is dropped: the unmodelled row is still visible in `all`.
      expect(p.all.map((a) => a.role)).toEqual(["from", "unknown", "to"]);
    });

    it("a missing or unparseable `type` is not silently role 0", () => {
      // `Number(null)` and `Number("")` are both 0, so an untyped row would
      // otherwise be given a role it never declared.
      expect(addrType(addr("+12065550100", null))).toBeNull();
      expect(addrType(addr("+12065550100", ""))).toBeNull();
      expect(addrType(addr("+12065550100", "not-a-number"))).toBeNull();
      expect(addrRole(addr("+12065550100", null))).toBe("unknown");
    });

    it("parses a `type` the provider returned as a padded string", () => {
      expect(addrType(addr("+12065550100", " 137 "))).toBe(137);
      expect(addrRole(addr("+12065550100", " 137 "))).toBe("from");
    });
  });

  // -------------------------------------------------------------------------
  // `all` is the complete record of what the provider returned
  // -------------------------------------------------------------------------
  describe("`all` drops nothing", () => {
    it("keeps duplicate spellings that `recipients` collapses", () => {
      const rows = [
        addr("+12065550100", MMS_ADDR_TYPE_FROM),
        addr("(206) 555-0101", MMS_ADDR_TYPE_TO),
        addr("+12065550101", MMS_ADDR_TYPE_TO),
      ];
      const p = expectResolved(deriveMmsParticipants(rows, "outbound"));

      expect(p.recipients).toHaveLength(1);
      expect(p.all).toHaveLength(3);
    });

    it("preserves the provider's row order", () => {
      const p = expectResolved(
        deriveMmsParticipants(RECEIVED_GROUP_FROM_LAST, "inbound")
      );

      expect(p.all.map((a) => a.role)).toEqual(["to", "to", "from"]);
    });
  });
});
