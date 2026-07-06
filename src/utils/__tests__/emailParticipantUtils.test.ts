/**
 * Unit tests for emailParticipantUtils.
 * BACKLOG-1762: Contact display-name resolution when the email header has no name.
 */
import {
  parseParticipant,
  hasRealHeaderName,
  resolveContactName,
  resolveDisplayName,
  formatParticipantLine,
  formatParticipantListLine,
  formatParticipants,
  filterSelfFromParticipants,
} from "../emailParticipantUtils";

const nameMap: ReadonlyMap<string, string> = new Map([
  ["emily.patt@gmail.com", "Emily Patterson"],
  ["sarah.mitchell@example.com", "Sarah Mitchell"],
]);

describe("parseParticipant", () => {
  it("parses 'Name <email>' format", () => {
    expect(parseParticipant("Emily Patterson <emily.patt@gmail.com>")).toEqual({
      name: "Emily Patterson",
      email: "emily.patt@gmail.com",
    });
  });

  it("parses a bare email address (no header name)", () => {
    expect(parseParticipant("emily.patt@gmail.com")).toEqual({
      name: null,
      email: "emily.patt@gmail.com",
    });
  });

  it("strips surrounding quotes from the name", () => {
    expect(parseParticipant('"Sarah Mitchell" <sarah.mitchell@example.com>')).toEqual({
      name: "Sarah Mitchell",
      email: "sarah.mitchell@example.com",
    });
  });

  it("keeps the degenerate email-in-name-slot as the parsed name", () => {
    expect(
      parseParticipant("sarah.mitchell@example.com <sarah.mitchell@example.com>"),
    ).toEqual({
      name: "sarah.mitchell@example.com",
      email: "sarah.mitchell@example.com",
    });
  });
});

describe("hasRealHeaderName", () => {
  it("is true for a genuine display name", () => {
    expect(hasRealHeaderName("Emily Patterson", "emily.patt@gmail.com")).toBe(true);
  });

  it("is false when the name is missing", () => {
    expect(hasRealHeaderName(null, "emily.patt@gmail.com")).toBe(false);
    expect(hasRealHeaderName("", "emily.patt@gmail.com")).toBe(false);
  });

  it("is false for the degenerate 'email === name' case (case-insensitive)", () => {
    expect(
      hasRealHeaderName("Sarah.Mitchell@example.com", "sarah.mitchell@example.com"),
    ).toBe(false);
  });
});

describe("resolveContactName", () => {
  it("returns the real header name (header truth wins over contacts)", () => {
    // Header says "Emmy" even though contacts say "Emily Patterson" -> header wins.
    expect(resolveContactName("Emmy <emily.patt@gmail.com>", nameMap)).toBe("Emmy");
  });

  it("resolves the contact name when the header has no name", () => {
    expect(resolveContactName("emily.patt@gmail.com", nameMap)).toBe("Emily Patterson");
  });

  it("resolves the contact name for the degenerate 'email <email>' case", () => {
    expect(
      resolveContactName(
        "sarah.mitchell@example.com <sarah.mitchell@example.com>",
        nameMap,
      ),
    ).toBe("Sarah Mitchell");
  });

  it("is case-insensitive on the address lookup", () => {
    expect(resolveContactName("EMILY.PATT@GMAIL.COM", nameMap)).toBe("Emily Patterson");
  });

  it("returns null when no contact matches and there is no header name", () => {
    expect(resolveContactName("nobody@nowhere.com", nameMap)).toBeNull();
  });

  it("returns null when no nameMap is provided and the header has no name", () => {
    expect(resolveContactName("emily.patt@gmail.com")).toBeNull();
  });
});

describe("resolveDisplayName", () => {
  it("falls back to the bare address when no contact matches", () => {
    expect(resolveDisplayName("nobody@nowhere.com", nameMap)).toBe("nobody@nowhere.com");
  });

  it("returns the contact name when matched", () => {
    expect(resolveDisplayName("emily.patt@gmail.com", nameMap)).toBe("Emily Patterson");
  });
});

describe("formatParticipantLine", () => {
  it("renders 'Name <email>' when a contact resolves", () => {
    expect(formatParticipantLine("emily.patt@gmail.com", nameMap)).toBe(
      "Emily Patterson <emily.patt@gmail.com>",
    );
  });

  it("collapses the degenerate 'email <email>' to a single address when no contact", () => {
    expect(
      formatParticipantLine("nobody@nowhere.com <nobody@nowhere.com>", nameMap),
    ).toBe("nobody@nowhere.com");
  });

  it("keeps a genuine header name (header truth wins)", () => {
    expect(formatParticipantLine("Bob Jones <bob@x.com>", nameMap)).toBe(
      "Bob Jones <bob@x.com>",
    );
  });
});

describe("formatParticipantListLine", () => {
  it("resolves each comma-separated recipient", () => {
    const result = formatParticipantListLine(
      "emily.patt@gmail.com, bob@x.com",
      nameMap,
    );
    expect(result).toBe("Emily Patterson <emily.patt@gmail.com>, bob@x.com");
  });

  it("returns empty string for empty input", () => {
    expect(formatParticipantListLine("", nameMap)).toBe("");
    expect(formatParticipantListLine(null, nameMap)).toBe("");
  });
});

describe("formatParticipants", () => {
  it("resolves contact names for bare addresses", () => {
    expect(formatParticipants(["emily.patt@gmail.com"], 2, nameMap)).toBe(
      "Emily Patterson",
    );
  });

  it("keeps a genuine header name over the contact name", () => {
    expect(formatParticipants(["Emmy <emily.patt@gmail.com>"], 2, nameMap)).toBe("Emmy");
  });

  it("prettifies the email prefix when no contact matches (existing fallback)", () => {
    expect(formatParticipants(["madison.delvigo@x.com"], 2)).toBe("Madison Delvigo");
  });

  it("shows '+X more' beyond maxShow", () => {
    const participants = ["a@x.com", "b@x.com", "c@x.com", "d@x.com"];
    expect(formatParticipants(participants, 2)).toBe("A, B +2");
  });

  it("returns 'Unknown' for an empty list", () => {
    expect(formatParticipants([])).toBe("Unknown");
  });
});

describe("filterSelfFromParticipants", () => {
  it("removes the current user by address", () => {
    const result = filterSelfFromParticipants(
      ["me@x.com", "Emily <emily.patt@gmail.com>"],
      "me@x.com",
    );
    expect(result).toEqual(["Emily <emily.patt@gmail.com>"]);
  });
});
