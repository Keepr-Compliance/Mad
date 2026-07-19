/**
 * Tests for formatLastExported (BACKLOG-2109).
 *
 * Verifies the "Exported <Mon D>" affordance reads the field the export handlers
 * actually write (last_exported_on), falls back to last_exported_at, and returns
 * null (⇒ "never exported") when neither is set or the value is unparseable.
 */
import { formatLastExported } from "../formatUtils";

describe("formatLastExported", () => {
  it("formats last_exported_on as 'Exported <Mon D>' (no year)", () => {
    expect(formatLastExported({ last_exported_on: "2026-07-12T10:00:00Z" })).toBe(
      "Exported Jul 12",
    );
  });

  it("prefers last_exported_on over last_exported_at", () => {
    expect(
      formatLastExported({
        last_exported_on: "2026-07-12T10:00:00Z",
        last_exported_at: "2026-01-01T10:00:00Z",
      }),
    ).toBe("Exported Jul 12");
  });

  it("falls back to last_exported_at when last_exported_on is absent", () => {
    expect(formatLastExported({ last_exported_at: "2026-03-05T10:00:00Z" })).toBe(
      "Exported Mar 5",
    );
  });

  it("returns null when the transaction has never been exported", () => {
    expect(formatLastExported({})).toBeNull();
    expect(
      formatLastExported({ last_exported_on: undefined, last_exported_at: undefined }),
    ).toBeNull();
  });

  it("returns null for an unparseable timestamp (treated as never exported)", () => {
    expect(formatLastExported({ last_exported_on: "not-a-date" })).toBeNull();
  });
});
