/**
 * @jest-environment node
 *
 * BACKLOG-2280 — unit tests for the pure reaction/tapback utilities.
 *
 * Covers: normalizeAssociatedGuid (p:<n>/ and bp: prefixes), mapReactionType
 * (full add/remove table + 2006 "other" + out-of-band null), isReactionRow band,
 * partitionReactions (incl. orphan bucket), and aggregateReactions
 * (add→remove→re-add collapse; per-actor/kind latest-wins).
 *
 * The renderer mirror (src/utils/reactionUtils.ts) is asserted to be behaviorally
 * identical for the key entry points so the two copies cannot silently diverge.
 */

import {
  normalizeAssociatedGuid,
  mapReactionType,
  isReactionRow,
  partitionReactions,
  aggregateReactions,
  REACTION_TYPE_BAND_MIN,
  REACTION_TYPE_BAND_MAX,
} from "../reactionUtils";
import * as rendererMirror from "../../../src/utils/reactionUtils";

describe("normalizeAssociatedGuid (BACKLOG-2280 C3)", () => {
  it("strips a p:<index>/ prefix for any part index (not just p:0/)", () => {
    expect(normalizeAssociatedGuid("p:0/ABC-123")).toBe("ABC-123");
    expect(normalizeAssociatedGuid("p:1/ABC-123")).toBe("ABC-123");
    expect(normalizeAssociatedGuid("p:2/ABC-123")).toBe("ABC-123");
    expect(normalizeAssociatedGuid("p:57/ABC-123")).toBe("ABC-123");
  });

  it("strips a bp: prefix", () => {
    expect(normalizeAssociatedGuid("bp:ABC-123")).toBe("ABC-123");
  });

  it("leaves an already-bare guid unchanged", () => {
    expect(normalizeAssociatedGuid("ABC-123")).toBe("ABC-123");
  });

  it("returns null for empty / nullish input", () => {
    expect(normalizeAssociatedGuid(null)).toBeNull();
    expect(normalizeAssociatedGuid(undefined)).toBeNull();
    expect(normalizeAssociatedGuid("")).toBeNull();
    expect(normalizeAssociatedGuid("p:3/")).toBeNull();
  });
});

describe("mapReactionType (BACKLOG-2280)", () => {
  it("maps the add band 2000–2005 to kinds (isRemoval=false)", () => {
    expect(mapReactionType(2000)).toEqual({ kind: "heart", isRemoval: false });
    expect(mapReactionType(2001)).toEqual({ kind: "thumbs_up", isRemoval: false });
    expect(mapReactionType(2002)).toEqual({ kind: "thumbs_down", isRemoval: false });
    expect(mapReactionType(2003)).toEqual({ kind: "laugh", isRemoval: false });
    expect(mapReactionType(2004)).toEqual({ kind: "emphasize", isRemoval: false });
    expect(mapReactionType(2005)).toEqual({ kind: "question", isRemoval: false });
  });

  it("maps the remove band 3000–3005 to the same kinds (isRemoval=true)", () => {
    expect(mapReactionType(3000)).toEqual({ kind: "heart", isRemoval: true });
    expect(mapReactionType(3001)).toEqual({ kind: "thumbs_up", isRemoval: true });
    expect(mapReactionType(3002)).toEqual({ kind: "thumbs_down", isRemoval: true });
    expect(mapReactionType(3003)).toEqual({ kind: "laugh", isRemoval: true });
    expect(mapReactionType(3004)).toEqual({ kind: "emphasize", isRemoval: true });
    expect(mapReactionType(3005)).toEqual({ kind: "question", isRemoval: true });
  });

  it("maps in-band custom/sticker tapbacks 2006/2007 to 'other'", () => {
    expect(mapReactionType(2006)).toEqual({ kind: "other", isRemoval: false });
    expect(mapReactionType(2007)).toEqual({ kind: "other", isRemoval: false });
  });

  it("returns null for out-of-band / nullish values", () => {
    expect(mapReactionType(null)).toBeNull();
    expect(mapReactionType(undefined)).toBeNull();
    expect(mapReactionType(0)).toBeNull();
    expect(mapReactionType(1999)).toBeNull();
    expect(mapReactionType(3006)).toBeNull(); // removal of a sticker — outside band
    expect(mapReactionType(9999)).toBeNull();
  });
});

describe("isReactionRow (BACKLOG-2280 band)", () => {
  it("is true for the whole [2000,3005] band and false outside it", () => {
    expect(isReactionRow({ associated_message_type: REACTION_TYPE_BAND_MIN })).toBe(true);
    expect(isReactionRow({ associated_message_type: REACTION_TYPE_BAND_MAX })).toBe(true);
    expect(isReactionRow({ associated_message_type: 2500 })).toBe(true);
    expect(isReactionRow({ associated_message_type: null })).toBe(false);
    expect(isReactionRow({ associated_message_type: undefined })).toBe(false);
    expect(isReactionRow({ associated_message_type: 1999 })).toBe(false);
    expect(isReactionRow({ associated_message_type: 3006 })).toBe(false);
    expect(isReactionRow(null)).toBe(false);
  });
});

describe("partitionReactions (BACKLOG-2280)", () => {
  const parentA = { id: "mA", external_id: "GUID-A", associated_message_type: null };
  const parentB = { id: "mB", external_id: "GUID-B", associated_message_type: null };
  const reactOnA = {
    id: "rA1",
    external_id: "R1",
    associated_message_type: 2000,
    associated_message_guid: "GUID-A",
  };
  const orphan = {
    id: "rOrphan",
    external_id: "R2",
    associated_message_type: 2001,
    associated_message_guid: "GUID-MISSING",
  };

  it("separates real messages from reactions and buckets reactions by parent guid", () => {
    const { messages, reactionsByParentGuid } = partitionReactions([
      parentA,
      reactOnA,
      parentB,
      orphan,
    ]);

    expect(messages.map((m) => m.id)).toEqual(["mA", "mB"]);
    expect(reactionsByParentGuid.get("GUID-A")?.map((r) => r.id)).toEqual(["rA1"]);
  });

  it("keeps an orphan reaction in the map (never looked up → renders nothing)", () => {
    const { messages, reactionsByParentGuid } = partitionReactions([parentA, orphan]);
    // Orphan is NOT a displayable message...
    expect(messages.map((m) => m.id)).toEqual(["mA"]);
    // ...but it is bucketed under its (unmatched) parent guid.
    expect(reactionsByParentGuid.get("GUID-MISSING")?.map((r) => r.id)).toEqual(["rOrphan"]);
    // Its guid is absent from the message set, so no bubble will ever look it up.
    expect(messages.some((m) => m.external_id === "GUID-MISSING")).toBe(false);
  });

  it("drops a reaction with no parent guid (cannot attach)", () => {
    const noGuid = { id: "rX", associated_message_type: 2000, associated_message_guid: null };
    const { messages, reactionsByParentGuid } = partitionReactions([parentA, noGuid]);
    expect(messages.map((m) => m.id)).toEqual(["mA"]);
    expect(reactionsByParentGuid.size).toBe(0);
  });
});

describe("aggregateReactions (BACKLOG-2280)", () => {
  it("collapses add→remove→re-add per (actor,kind): latest wins → active", () => {
    const result = aggregateReactions([
      { actor: "+1555", sentAt: "2026-01-01T00:00:01Z", associatedType: 2000 }, // add heart
      { actor: "+1555", sentAt: "2026-01-01T00:00:02Z", associatedType: 3000 }, // remove heart
      { actor: "+1555", sentAt: "2026-01-01T00:00:03Z", associatedType: 2000 }, // re-add heart
    ]);
    expect(result).toEqual([{ kind: "heart", count: 1, actors: ["+1555"] }]);
  });

  it("treats a trailing removal as inactive (no pill)", () => {
    const result = aggregateReactions([
      { actor: "+1555", sentAt: "2026-01-01T00:00:01Z", associatedType: 2001 }, // add like
      { actor: "+1555", sentAt: "2026-01-01T00:00:05Z", associatedType: 3001 }, // remove like
    ]);
    expect(result).toEqual([]);
  });

  it("is order-independent for distinct timestamps (max sentAt wins)", () => {
    const result = aggregateReactions([
      { actor: "me", sentAt: "2026-01-01T00:00:03Z", associatedType: 2000 }, // re-add (latest)
      { actor: "me", sentAt: "2026-01-01T00:00:01Z", associatedType: 2000 }, // add
      { actor: "me", sentAt: "2026-01-01T00:00:02Z", associatedType: 3000 }, // remove (middle)
    ]);
    expect(result).toEqual([{ kind: "heart", count: 1, actors: ["me"] }]);
  });

  it("groups multiple actors of the same kind with a count", () => {
    const result = aggregateReactions([
      { actor: "me", sentAt: "2026-01-01T00:00:01Z", associatedType: 2001 },
      { actor: "+1555", sentAt: "2026-01-01T00:00:02Z", associatedType: 2001 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("thumbs_up");
    expect(result[0].count).toBe(2);
    expect(new Set(result[0].actors)).toEqual(new Set(["me", "+1555"]));
  });

  it("ignores out-of-band events", () => {
    expect(
      aggregateReactions([
        { actor: "me", sentAt: "2026-01-01T00:00:01Z", associatedType: 42 },
      ]),
    ).toEqual([]);
  });
});

describe("renderer mirror parity (electron vs src)", () => {
  it("normalizeAssociatedGuid behaves identically", () => {
    for (const raw of ["p:0/G", "p:9/G", "bp:G", "G", ""]) {
      expect(rendererMirror.normalizeAssociatedGuid(raw)).toBe(normalizeAssociatedGuid(raw));
    }
  });

  it("mapReactionType behaves identically across the band", () => {
    for (const t of [2000, 2005, 2006, 3000, 3005, 3006, null, 1999]) {
      expect(rendererMirror.mapReactionType(t)).toEqual(mapReactionType(t));
    }
  });

  it("exposes the same band constants", () => {
    expect(rendererMirror.REACTION_TYPE_BAND_MIN).toBe(REACTION_TYPE_BAND_MIN);
    expect(rendererMirror.REACTION_TYPE_BAND_MAX).toBe(REACTION_TYPE_BAND_MAX);
  });
});
