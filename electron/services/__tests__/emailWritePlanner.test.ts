/**
 * Unit tests for the email write planner (BACKLOG-1769).
 *
 * Focus: the ghost-resurrection root-fix (BACKLOG-1764). A re-delivered message
 * keeps its RFC Message-ID but gets a NEW provider id, so external-id dedup misses
 * it and a second (ghost) row would be created. planEmailWrites must instead remap
 * the existing row's external_id in place.
 *
 * Pure function — no DB, no mocks required.
 */

import {
  planEmailWrites,
  type ExistingByMessageId,
  type PlannableEmail,
} from "../emailWritePlanner";

type Fetched = PlannableEmail & { subject?: string };

function makeExisting(
  externalIds: string[],
  byMessageId: Array<[string, ExistingByMessageId]> = [],
): { externalIds: Set<string>; byMessageId: Map<string, ExistingByMessageId> } {
  return {
    externalIds: new Set(externalIds),
    byMessageId: new Map(byMessageId),
  };
}

describe("planEmailWrites (BACKLOG-1769)", () => {
  it("inserts a genuinely new email (no external_id match, no Message-ID match)", () => {
    const emails: Fetched[] = [{ id: "prov-1", messageIdHeader: "<a@x.com>" }];
    const plan = planEmailWrites(emails, makeExisting([]));

    expect(plan.toInsert).toEqual(emails);
    expect(plan.resurrections).toHaveLength(0);
    expect(plan.duplicates).toBe(0);
  });

  it("skips an exact duplicate already stored under the same provider id", () => {
    const emails: Fetched[] = [{ id: "prov-1", messageIdHeader: "<a@x.com>" }];
    const plan = planEmailWrites(emails, makeExisting(["prov-1"]));

    expect(plan.toInsert).toHaveLength(0);
    expect(plan.resurrections).toHaveLength(0);
    expect(plan.duplicates).toBe(1);
  });

  it("RESURRECTION: same Message-ID stored under a DIFFERENT provider id → remap in place, no insert", () => {
    // The exact ghost scenario: message re-delivered, new provider id, same Message-ID.
    const emails: Fetched[] = [{ id: "prov-NEW", messageIdHeader: "<ghost@example.com>" }];
    const existing = makeExisting(
      [], // external_id "prov-NEW" is NOT known (that's why external-id dedup missed it)
      [["<ghost@example.com>", { id: "local-uuid-1", externalId: "prov-OLD" }]],
    );

    const plan = planEmailWrites(emails, existing);

    expect(plan.toInsert).toHaveLength(0); // NO ghost row inserted
    expect(plan.resurrections).toEqual([
      {
        existingId: "local-uuid-1",
        newExternalId: "prov-NEW",
        messageIdHeader: "<ghost@example.com>",
      },
    ]);
    expect(plan.duplicates).toBe(0);
  });

  it("treats a Message-ID match with the SAME provider id as an exact duplicate (defensive)", () => {
    const emails: Fetched[] = [{ id: "prov-1", messageIdHeader: "<a@x.com>" }];
    const existing = makeExisting(
      [], // external_id lookup didn't catch it this pass
      [["<a@x.com>", { id: "local-1", externalId: "prov-1" }]],
    );

    const plan = planEmailWrites(emails, existing);

    expect(plan.toInsert).toHaveLength(0);
    expect(plan.resurrections).toHaveLength(0);
    expect(plan.duplicates).toBe(1);
  });

  it("collapses two rows sharing a Message-ID within the SAME batch (inbox + sent) to one insert", () => {
    const emails: Fetched[] = [
      { id: "prov-inbox", messageIdHeader: "<same@x.com>" },
      { id: "prov-sent", messageIdHeader: "<same@x.com>" },
    ];
    const plan = planEmailWrites(emails, makeExisting([]));

    expect(plan.toInsert.map((e) => e.id)).toEqual(["prov-inbox"]);
    expect(plan.duplicates).toBe(1); // the second one skipped
    expect(plan.resurrections).toHaveLength(0);
  });

  it("inserts emails with a NULL/absent Message-ID without header dedup", () => {
    const emails: Fetched[] = [
      { id: "prov-1", messageIdHeader: null },
      { id: "prov-2" }, // undefined header
      { id: "prov-3", messageIdHeader: "" }, // empty string treated as absent
    ];
    const plan = planEmailWrites(emails, makeExisting([]));

    expect(plan.toInsert.map((e) => e.id)).toEqual(["prov-1", "prov-2", "prov-3"]);
    expect(plan.resurrections).toHaveLength(0);
    expect(plan.duplicates).toBe(0);
  });

  it("does NOT remap when the resurrected provider id equals the stored one under a different header lookup", () => {
    // Two distinct headers, one resurrection, one brand new — mixed batch.
    const emails: Fetched[] = [
      { id: "prov-new", messageIdHeader: "<ghost@x.com>" }, // resurrection
      { id: "prov-fresh", messageIdHeader: "<brand-new@x.com>" }, // new
      { id: "prov-dupe", messageIdHeader: "<known@x.com>" }, // exact external_id dup
    ];
    const existing = makeExisting(
      ["prov-dupe"],
      [["<ghost@x.com>", { id: "local-ghost", externalId: "prov-old" }]],
    );

    const plan = planEmailWrites(emails, existing);

    expect(plan.toInsert.map((e) => e.id)).toEqual(["prov-fresh"]);
    expect(plan.resurrections).toEqual([
      { existingId: "local-ghost", newExternalId: "prov-new", messageIdHeader: "<ghost@x.com>" },
    ]);
    expect(plan.duplicates).toBe(1);
  });

  it("handles an empty batch", () => {
    const plan = planEmailWrites([], makeExisting([]));
    expect(plan.toInsert).toHaveLength(0);
    expect(plan.resurrections).toHaveLength(0);
    expect(plan.duplicates).toBe(0);
  });
});
