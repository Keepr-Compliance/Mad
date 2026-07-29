/**
 * Unit tests for Address Normalization Utility
 *
 * Tests address normalization and content matching used by auto-link services
 * to filter emails to the correct transaction.
 *
 * TASK-2087: Address filtering applies to EMAILS ONLY, not text messages.
 *
 * BACKLOG-2311: Rewritten for canonicalization-aware matching. Street suffixes
 * and directionals fold to ONE canonical token in BOTH directions, and only the
 * street number + distinctive name word(s) are REQUIRED (suffix + directional
 * are OPTIONAL). Assertions compare IDENTITY / SETS, not counts.
 *
 * @see TASK-2087
 * @see BACKLOG-2311
 */

import {
  normalizeAddress,
  contentContainsAddress,
  countOptionalWordMatches,
  withAddressFallback,
  type NormalizedAddress,
} from "../addressNormalization";

/** Order-independent comparison helper for word sets. */
const asSet = (words: string[]): string[] => [...words].sort();

describe("addressNormalization", () => {
  describe("normalizeAddress", () => {
    it("splits number, distinctive name, and optional suffix+directional", () => {
      const result = normalizeAddress("3414 Sapp Road Southwest, Atlanta, GA 30331");
      expect(result?.streetNumber).toBe("3414");
      expect(asSet(result!.requiredNameWords)).toEqual(["sapp"]);
      expect(asSet(result!.optionalWords)).toEqual(["road", "southwest"]);
    });

    it("treats the trailing suffix as OPTIONAL, not part of the required name", () => {
      const result = normalizeAddress("123 Oak Street, Portland, OR 97201");
      expect(result?.streetNumber).toBe("123");
      expect(asSet(result!.requiredNameWords)).toEqual(["oak"]);
      expect(asSet(result!.optionalWords)).toEqual(["street"]);
    });

    it("treats a leading directional as OPTIONAL", () => {
      const result = normalizeAddress("7890 NW Johnson Blvd, Suite 200");
      expect(result?.streetNumber).toBe("7890");
      expect(asSet(result!.requiredNameWords)).toEqual(["johnson"]);
      expect(asSet(result!.optionalWords)).toEqual(["boulevard", "northwest"]);
    });

    it("keeps multi-word distinctive names as required words", () => {
      const result = normalizeAddress("250 Martin Luther King Blvd");
      expect(asSet(result!.requiredNameWords)).toEqual(["king", "luther", "martin"]);
      expect(asSet(result!.optionalWords)).toEqual(["boulevard"]);
    });

    it("keeps an address with no suffix (empty optional set)", () => {
      const result = normalizeAddress("100 Main");
      expect(result?.streetNumber).toBe("100");
      expect(asSet(result!.requiredNameWords)).toEqual(["main"]);
      expect(result!.optionalWords).toEqual([]);
    });

    it("strips a suffix with a trailing period", () => {
      const result = normalizeAddress("123 Oak St.");
      expect(asSet(result!.requiredNameWords)).toEqual(["oak"]);
      expect(asSet(result!.optionalWords)).toEqual(["street"]);
    });

    it("is case-insensitive", () => {
      const result = normalizeAddress("123 OAK STREET");
      expect(result?.streetNumber).toBe("123");
      expect(asSet(result!.requiredNameWords)).toEqual(["oak"]);
    });

    it("tolerates extra whitespace", () => {
      const result = normalizeAddress("  3414   Sapp   Rd   SW  ");
      expect(result?.streetNumber).toBe("3414");
      expect(asSet(result!.requiredNameWords)).toEqual(["sapp"]);
      expect(asSet(result!.optionalWords)).toEqual(["road", "southwest"]);
    });

    it.each([
      ["empty string", ""],
      ["whitespace only", "   "],
      ["null", null],
      ["undefined", undefined],
      ["no street number", "Oak Street"],
      ["number only", "123"],
    ])("returns null for %s", (_label, input) => {
      expect(normalizeAddress(input)).toBeNull();
    });

    // BACKLOG-2311: CHANGED from the old over-strict behavior. Previously
    // "1200 Highway" / "99 St" returned null (name was entirely a suffix). We
    // now fall back to REQUIRING the canonical suffix token so matching stays
    // bounded instead of returning null (which upstream treated as "no address").
    it("falls back to requiring the canonical token when the name is only a suffix", () => {
      const highway = normalizeAddress("1200 Highway");
      expect(highway?.streetNumber).toBe("1200");
      expect(asSet(highway!.requiredNameWords)).toEqual(["highway"]);
      expect(highway!.optionalWords).toEqual([]);

      const st = normalizeAddress("99 St");
      expect(st?.streetNumber).toBe("99");
      expect(asSet(st!.requiredNameWords)).toEqual(["street"]);
      expect(st!.optionalWords).toEqual([]);
    });

    describe("variant equivalence — abbreviation and full form produce IDENTICAL parts", () => {
      const equivalent = (a: string, b: string) => {
        const x = normalizeAddress(a);
        const y = normalizeAddress(b);
        expect(x).not.toBeNull();
        expect(y).not.toBeNull();
        expect(x!.streetNumber).toBe(y!.streetNumber);
        expect(asSet(x!.requiredNameWords)).toEqual(asSet(y!.requiredNameWords));
        expect(asSet(x!.optionalWords)).toEqual(asSet(y!.optionalWords));
        // Canonical `full` string is identical too.
        expect(x!.full).toBe(y!.full);
      };

      it("Sapp Rd SW ≡ Sapp Road Southwest", () => {
        equivalent("3414 Sapp Rd SW", "3414 Sapp Road Southwest");
      });
      it("NW Johnson ≡ Northwest Johnson", () => {
        equivalent("7890 NW Johnson Blvd", "7890 Northwest Johnson Boulevard");
      });
      it("Oak St ≡ Oak Street", () => {
        equivalent("123 Oak St", "123 Oak Street");
      });
      it("Maple Ave ≡ Maple Avenue", () => {
        equivalent("200 Maple Ave", "200 Maple Avenue");
      });
    });
  });

  describe("contentContainsAddress", () => {
    // Build the NormalizedAddress the real way (via normalizeAddress) so the
    // test exercises canonicalization end to end.
    const addrOf = (s: string): NormalizedAddress => {
      const a = normalizeAddress(s);
      if (!a) throw new Error(`test address did not normalize: ${s}`);
      return a;
    };

    describe("variant equivalence (abbreviation ↔ full form, both directions)", () => {
      it("stored 'Sapp Road Southwest' matches email 'Sapp Rd SW'", () => {
        expect(
          contentContainsAddress(
            "Docs for 3414 Sapp Rd SW closing next week",
            addrOf("3414 Sapp Road Southwest")
          )
        ).toBe(true);
      });

      it("stored 'Sapp Rd SW' matches email 'Sapp Road Southwest'", () => {
        expect(
          contentContainsAddress(
            "Re: 3414 Sapp Road Southwest offer",
            addrOf("3414 Sapp Rd SW")
          )
        ).toBe(true);
      });

      it("'NW Johnson' ↔ 'Northwest Johnson' both directions", () => {
        expect(
          contentContainsAddress("Offer on 7890 NW Johnson St", addrOf("7890 Northwest Johnson Blvd"))
        ).toBe(true);
        expect(
          contentContainsAddress("Offer on 7890 Northwest Johnson Blvd", addrOf("7890 NW Johnson St"))
        ).toBe(true);
      });

      it("'Oak St' ↔ 'Oak Street'", () => {
        expect(contentContainsAddress("closing at 123 Oak St", addrOf("123 Oak Street"))).toBe(true);
        expect(contentContainsAddress("closing at 123 Oak Street", addrOf("123 Oak St"))).toBe(true);
      });

      it("'Ave' ↔ 'Avenue'", () => {
        expect(contentContainsAddress("200 Maple Avenue", addrOf("200 Maple Ave"))).toBe(true);
        expect(contentContainsAddress("200 Maple Ave", addrOf("200 Maple Avenue"))).toBe(true);
      });
    });

    describe("distinctive-word matching (suffix/directional differ or absent)", () => {
      it("matches on number + distinctive name even with NO suffix/directional in content", () => {
        expect(
          contentContainsAddress("payment for 3414 Sapp received", addrOf("3414 Sapp Road Southwest"))
        ).toBe(true);
      });

      it("matches when suffix present but directional absent", () => {
        expect(
          contentContainsAddress("3414 Sapp Road walkthrough", addrOf("3414 Sapp Rd SW"))
        ).toBe(true);
      });

      it("matches number and name in different parts / reversed order", () => {
        expect(contentContainsAddress("The Sapp property, unit 3414", addrOf("3414 Sapp Rd SW"))).toBe(
          true
        );
      });

      it("requires ALL words of a multi-word distinctive name", () => {
        const addr = addrOf("250 Martin Luther King Blvd");
        expect(contentContainsAddress("250 Martin Luther King Jr Blvd", addr)).toBe(true);
        expect(contentContainsAddress("250 Martin King closing", addr)).toBe(false); // missing "luther"
      });
    });

    describe("false-positive guards", () => {
      it("does NOT match the street number alone — '$3,414' (comma-broken digits)", () => {
        expect(contentContainsAddress("Invoice $3,414 for the deal", addrOf("3414 Sapp Rd SW"))).toBe(
          false
        );
      });

      it("does NOT match the street number alone — '3414 sq ft' (no name word)", () => {
        expect(contentContainsAddress("Great 3414 sq ft loft", addrOf("3414 Sapp Rd SW"))).toBe(false);
      });

      it("does NOT match a single common word alone (no number present)", () => {
        expect(contentContainsAddress("main street discussion thread", addrOf("100 Main"))).toBe(false);
      });

      it("does NOT match number-only content (name word missing)", () => {
        expect(contentContainsAddress("please review unit 100 paperwork", addrOf("100 Main"))).toBe(
          false
        );
      });

      it("does NOT match a number embedded in a larger number (word boundary)", () => {
        expect(contentContainsAddress("Account 34141 Sapp", addrOf("3414 Sapp Rd SW"))).toBe(false);
      });

      it("does NOT match a name word embedded in a larger word (word boundary)", () => {
        expect(contentContainsAddress("Oakland office at 123 Main", addrOf("123 Oak St"))).toBe(false);
      });
    });

    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty", ""],
    ])("returns false for %s content", (_label, content) => {
      expect(contentContainsAddress(content, addrOf("123 Oak St"))).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(contentContainsAddress("DOCS FOR 123 OAK STREET", addrOf("123 Oak St"))).toBe(true);
    });
  });

  describe("countOptionalWordMatches", () => {
    const addr = normalizeAddress("3414 Sapp Road Southwest")!; // optional: road, southwest

    it("counts all optional tokens when both present (any spelling)", () => {
      expect(countOptionalWordMatches("3414 Sapp Rd SW", addr)).toBe(2);
      expect(countOptionalWordMatches("3414 Sapp Road Southwest", addr)).toBe(2);
    });

    it("counts a partial optional match", () => {
      expect(countOptionalWordMatches("3414 Sapp Road", addr)).toBe(1);
    });

    it("returns 0 when no optional token appears", () => {
      expect(countOptionalWordMatches("3414 Sapp only", addr)).toBe(0);
    });
  });

  describe("withAddressFallback", () => {
    const testAddr: NormalizedAddress = {
      streetNumber: "123",
      requiredNameWords: ["oak"],
      optionalWords: [],
      full: "123 oak",
    };

    it("should return filtered results when address filter produces results", async () => {
      const queryFn = jest.fn().mockResolvedValueOnce(["a", "b"]);
      const debugLog = jest.fn();

      const result = await withAddressFallback(queryFn, testAddr, debugLog, "items");

      expect(result).toEqual(["a", "b"]);
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(queryFn).toHaveBeenCalledWith(testAddr);
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining("Address filter applied"));
    });

    it("should fall back to unfiltered when address filter returns empty", async () => {
      const queryFn = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(["x", "y"]);
      const debugLog = jest.fn();

      const result = await withAddressFallback(queryFn, testAddr, debugLog, "items");

      expect(result).toEqual(["x", "y"]);
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(queryFn).toHaveBeenNthCalledWith(1, testAddr);
      expect(queryFn).toHaveBeenNthCalledWith(2, null);
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining("Address filter fallback"));
    });

    it("should return empty when both filtered and unfiltered are empty", async () => {
      const queryFn = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const debugLog = jest.fn();

      const result = await withAddressFallback(queryFn, testAddr, debugLog, "items");

      expect(result).toEqual([]);
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining("even without filter"));
    });

    it("should skip fallback logic when no address is provided", async () => {
      const queryFn = jest.fn().mockResolvedValueOnce(["a", "b"]);
      const debugLog = jest.fn();

      const result = await withAddressFallback(queryFn, null, debugLog, "items");

      expect(result).toEqual(["a", "b"]);
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(queryFn).toHaveBeenCalledWith(null);
      expect(debugLog).not.toHaveBeenCalled();
    });

    it("should STILL fall back when countWithFilter reports matching items exist (BACKLOG-1340)", async () => {
      const queryFn = jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(["x", "y"]);
      const debugLog = jest.fn();
      const countWithFilter = jest.fn().mockResolvedValueOnce(2);

      const result = await withAddressFallback(queryFn, testAddr, debugLog, "items", countWithFilter);

      expect(result).toEqual(["x", "y"]);
      expect(queryFn).toHaveBeenCalledTimes(2);
      expect(countWithFilter).toHaveBeenCalledWith(testAddr);
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining("all are already linked"));
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining("Address filter fallback"));
    });

    it("should not call countWithFilter when filtered results are non-empty", async () => {
      const queryFn = jest.fn().mockResolvedValueOnce(["a", "b"]);
      const debugLog = jest.fn();
      const countWithFilter = jest.fn();

      const result = await withAddressFallback(queryFn, testAddr, debugLog, "items", countWithFilter);

      expect(result).toEqual(["a", "b"]);
      expect(countWithFilter).not.toHaveBeenCalled();
    });
  });
});
