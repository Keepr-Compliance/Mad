/**
 * @jest-environment node
 *
 * BACKLOG-2463 — what a text thread is called, and what that name is allowed to
 * look like once it becomes a filename inside the audit package.
 *
 * Two properties are under test and they are not the same property:
 *
 *  1. The LABEL comes from the BACKLOG-2461 chain — the one shared function —
 *     not from a second copy of the fallback order living in the export.
 *  2. The FILENAME derived from that label is legal on Windows and still
 *     recognisably the same person. CI runs on Windows; macOS accepts filenames
 *     Windows refuses outright, so the reserved set is asserted explicitly here
 *     rather than inferred from a green run on a Mac.
 */

jest.mock("../../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: jest.fn() },
}));

import {
  threadContactLabel,
  threadContactIsUnresolved,
  fileSafeContactLabel,
  GROUP_CHAT_LABEL,
} from "../threadContactLabel";
import {
  contactDisplayLabel,
  NO_NAME_PLACEHOLDER,
} from "../../../utils/contactDisplayLabel";

describe("threadContactLabel — the shared chain, called not copied (BACKLOG-2463)", () => {
  it("delegates to contactDisplayLabel rather than re-deriving the order", () => {
    // The guard that matters. If someone reimplements the fallback order inside
    // the export — which is exactly how the two paths diverged the first time —
    // this fails even if every string below still happens to match.
    // ts-jest emits CommonJS, so a named import compiles to a property read on
    // the module object — spying on it intercepts the real call.
    const chain = require("../../../utils/contactDisplayLabel");
    const spy = jest.spyOn(chain, "contactDisplayLabel");
    try {
      threadContactLabel({ phone: "+12065550103", name: "Jane Rivera" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ name: "Jane Rivera", phone: "+12065550103" });
    } finally {
      spy.mockRestore();
    }
  });

  it("agrees with the shared chain for every shape a thread contact can take", () => {
    const cases: Array<{ phone: string | null; name: string | null }> = [
      { phone: "+12065550103", name: "Jane Rivera" },
      { phone: "+12065550103", name: null },
      { phone: "2065550103", name: null },
      { phone: "+50664103686", name: null },
      { phone: "jane@icloud.com", name: null },
      { phone: "", name: null },
      { phone: null, name: null },
      { phone: "+12065550103", name: "Unknown" },
      { phone: "+12065550103", name: "Unknown Contact" },
    ];
    for (const c of cases) {
      expect(threadContactLabel(c)).toBe(
        contactDisplayLabel({ name: c.name, phone: c.phone }),
      );
    }
  });

  it("names a nameless party by their formatted number, not by a placeholder", () => {
    expect(threadContactLabel({ phone: "+12065550103", name: null })).toBe("+1 (206) 555-0103");
    expect(threadContactLabel({ phone: "2065550103", name: null })).toBe("(206) 555-0103");
    // BACKLOG-2461's international branch: the "+" survives, digits are not regrouped.
    expect(threadContactLabel({ phone: "+50664103686", name: null })).toBe("+50664103686");
  });

  it("returns an iMessage email handle untouched", () => {
    expect(threadContactLabel({ phone: "jane@icloud.com", name: null })).toBe("jane@icloud.com");
  });

  it("reads the legacy 'Unknown' sentinels as an EMPTY name and falls to the number", () => {
    // The phone→name map is built from `contacts.display_name`, and live import
    // paths still write these literals into that column. Printing them verbatim
    // is the original defect wearing a different hat.
    expect(threadContactLabel({ phone: "+12065550103", name: "Unknown" })).toBe("+1 (206) 555-0103");
    expect(threadContactLabel({ phone: "+12065550103", name: "Unknown Contact" })).toBe(
      "+1 (206) 555-0103",
    );
  });

  it("keeps a real person called 'Unknown Records LLC'", () => {
    expect(threadContactLabel({ phone: "+12065550103", name: "Unknown Records LLC" })).toBe(
      "Unknown Records LLC",
    );
  });

  it("uses the chain's terminal fallback — and only when there is nothing at all", () => {
    expect(threadContactLabel({ phone: "", name: null })).toBe(NO_NAME_PLACEHOLDER);
    expect(threadContactLabel({ phone: null, name: null })).toBe(NO_NAME_PLACEHOLDER);
    expect(threadContactLabel({ phone: "   ", name: "  " })).toBe(NO_NAME_PLACEHOLDER);
    expect(NO_NAME_PLACEHOLDER).toBe("No name");
    // One field present is enough to escape it.
    expect(threadContactLabel({ phone: "+12065550103", name: null })).not.toBe(NO_NAME_PLACEHOLDER);
    expect(threadContactLabel({ phone: "", name: "Jane" })).not.toBe(NO_NAME_PLACEHOLDER);
  });

  it("never emits the word 'Unknown' for any input", () => {
    const inputs = [
      { phone: "", name: null },
      { phone: null, name: null },
      { phone: "+12065550103", name: null },
      { phone: "+12065550103", name: "Unknown" },
      { phone: "+12065550103", name: "Unknown Contact" },
      { phone: "jane@icloud.com", name: "unknown" },
    ];
    for (const input of inputs) {
      expect(threadContactLabel(input).toLowerCase()).not.toContain("unknown");
    }
  });
});

describe("threadContactIsUnresolved", () => {
  it("is true only when the thread yielded neither a name nor a handle", () => {
    expect(threadContactIsUnresolved({ phone: "", name: null })).toBe(true);
    expect(threadContactIsUnresolved({ phone: "   ", name: "  " })).toBe(true);
    expect(threadContactIsUnresolved({ phone: null, name: null })).toBe(true);
    expect(threadContactIsUnresolved({ phone: "+12065550103", name: null })).toBe(false);
    expect(threadContactIsUnresolved({ phone: "", name: "Jane" })).toBe(false);
  });
});

describe("fileSafeContactLabel — the name that lands on disk (BACKLOG-2463)", () => {
  it("files a nameless party under their number, exactly", () => {
    expect(fileSafeContactLabel(threadContactLabel({ phone: "+12065550103", name: null }))).toBe(
      "1_206_555-0103",
    );
    expect(fileSafeContactLabel(threadContactLabel({ phone: "2065550103", name: null }))).toBe(
      "206_555-0103",
    );
    expect(fileSafeContactLabel(threadContactLabel({ phone: "+50664103686", name: null }))).toBe(
      "50664103686",
    );
  });

  it("keeps every digit of the number, in order", () => {
    // "Recognisably that person" is not a vibe: the digits must survive intact.
    const label = fileSafeContactLabel(threadContactLabel({ phone: "+12065550103", name: null }));
    expect(label.replace(/\D/g, "")).toBe("12065550103");
  });

  it("files an organisation-only party under the organisation", () => {
    // A contact with no personal name but a company reaches the text export as a
    // resolved name (`resolveHandles` returns one string), and through the chain
    // as the organisation tier. Both routes must land on the same file name.
    expect(fileSafeContactLabel(threadContactLabel({ phone: "+12065550103", name: "Acme Title Co." }))).toBe(
      "Acme_Title_Co",
    );
    expect(fileSafeContactLabel(contactDisplayLabel({ organization: "Acme Title Co." }))).toBe(
      "Acme_Title_Co",
    );
  });

  it("uses the chain's terminal fallback when there is genuinely nothing — never 'Unknown'", () => {
    expect(fileSafeContactLabel(threadContactLabel({ phone: "", name: null }))).toBe("No_name");
    expect(fileSafeContactLabel("")).toBe("No_name");
    // Everything sanitised away to punctuation is the same condition.
    expect(fileSafeContactLabel("!!!")).toBe("No_name");
    expect(fileSafeContactLabel("   ")).toBe("No_name");
    expect(fileSafeContactLabel("No_name").toLowerCase()).not.toContain("unknown");
  });

  it("still sanitises the group-chat label to the name shipped before this change", () => {
    // The one string that must NOT move: existing exports are named Group_Chat.
    expect(fileSafeContactLabel(GROUP_CHAT_LABEL)).toBe("Group_Chat");
  });

  // -------------------------------------------------------------------------
  // Windows. Asserted, not assumed.
  // -------------------------------------------------------------------------

  it("replaces each character Windows forbids in a filename — one at a time", () => {
    // <>:"/\|?* are rejected by the Win32 API outright. Asserted individually so
    // a failure names the offending character instead of the whole set.
    expect(fileSafeContactLabel("Jane<Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane>Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane:Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel('Jane"Doe')).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane/Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane\\Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane|Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane?Doe")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane*Doe")).toBe("Jane_Doe");
  });

  it("emits nothing outside [A-Za-z0-9_.-] for any hostile input", () => {
    const hostile = [
      'Jane <>:"/\\|?* Doe',
      "..\\..\\..\\Windows\\System32",
      "../../etc/passwd",
      "Jane Doe",
      "Jane\tDoe\nSmith",
      "+1 (206) 555-0103",
      "José Álvarez",
      "田中 太郎",
      "🙂 emoji person",
    ];
    for (const input of hostile) {
      const safe = fileSafeContactLabel(input);
      expect(safe).toMatch(/^[A-Za-z0-9_.-]+$/);
      // Every Windows-illegal character, plus the C0 control range.
      expect(safe).not.toMatch(/[<>:"/\\|?* -]/);
      expect(safe.toLowerCase()).not.toContain("unknown");
    }
  });

  it("never contains a path separator, so the name cannot escape its directory", () => {
    expect(fileSafeContactLabel("..\\..\\Windows\\System32\\config")).toBe(
      "Windows_System32_config",
    );
    expect(fileSafeContactLabel("../../etc/passwd")).toBe("etc_passwd");
  });

  it("defuses every reserved Windows DEVICE name — the exact set", () => {
    const reserved = [
      "CON", "PRN", "AUX", "NUL",
      "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    for (const name of reserved) {
      // Case-insensitive on Windows: `con`, `Con` and `CON` are all the device.
      expect(fileSafeContactLabel(name)).toBe(`${name}_`);
      expect(fileSafeContactLabel(name.toLowerCase())).toBe(`${name.toLowerCase()}_`);
      // An extension does not make it legal — `CON.pdf` is still the device.
      expect(fileSafeContactLabel(`${name}.pdf`)).toBe(`${name}_.pdf`);
    }
    // A name that merely STARTS with one is a real name and is left alone.
    expect(fileSafeContactLabel("Connie")).toBe("Connie");
    expect(fileSafeContactLabel("Aux Marine LLC")).toBe("Aux_Marine_LLC");
  });

  it("never ends in a dot or a space — Windows strips those silently", () => {
    // A trailing dot/space is discarded by the filesystem, so the file would be
    // written under a name that is not the name we asked for.
    expect(fileSafeContactLabel("Jane Doe.")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane Doe ")).toBe("Jane_Doe");
    expect(fileSafeContactLabel("Jane Doe...")).toBe("Jane_Doe");
    for (const input of ["Jane Doe.", "Jane Doe ", "Acme Title Co.", "..Jane.."]) {
      const safe = fileSafeContactLabel(input);
      expect(safe).not.toMatch(/[. _-]$/);
      expect(safe).not.toMatch(/^[. _-]/);
    }
  });

  it("caps the contact segment so the full path stays inside Windows MAX_PATH", () => {
    const long = "Bartholomew Fitzwilliam Montgomery ".repeat(20);
    const safe = fileSafeContactLabel(long);
    expect(safe.length).toBeLessThanOrEqual(60);
    // Truncation must not re-expose a trailing separator at the cut point.
    expect(safe).not.toMatch(/[. _-]$/);
    // `text_001_` + segment + `_YYYY-MM-DD.pdf`
    expect(`text_001_${safe}_2026-01-15.pdf`.length).toBeLessThanOrEqual(84);
  });
});
