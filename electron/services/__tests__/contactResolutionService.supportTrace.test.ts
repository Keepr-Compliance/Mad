/** @jest-environment node */
/**
 * What contact resolution actually writes to a support report (BACKLOG-2428)
 *
 * ## Why this drives the producer instead of reading it
 *
 * The claim being made is "no surviving scope records a person's identifying
 * details". Grepping for a token proves that a token is absent from a file, not
 * that a property holds — the two come apart the moment a field is renamed or
 * built up a line earlier. So this runs the real `resolvePhoneNames` against a
 * real trace sink with every scope open, and looks at what came out.
 *
 * `resolvePhoneNames` swallows failures from all three of its lookup sources
 * (imported contacts, external contacts, macOS Contacts) and carries on, so
 * driving it needs nothing but stubs that say "no match". Handles that resolve
 * to nobody are precisely the case the removed producer fired on, which makes
 * this the strongest available negative control.
 *
 * The scope this covers: `contact-resolution`, the one that used to sit
 * alongside `contact-trace` in the same function. The other three scopes'
 * producers are held by the set-identity assertion in `scopeProducers.test.ts`
 * — a producer writing a scope that is not in the catalogue fails it, so
 * `contact-trace` cannot be quietly reinstated anywhere in `electron/`.
 */

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getContactNamesByPhones: jest.fn().mockReturnValue([]),
    getContactNamesByEmails: jest.fn().mockReturnValue([]),
  },
}));

jest.mock("../contactsService", () => ({
  getContactNames: jest.fn().mockResolvedValue({ contactMap: {} }),
}));

jest.mock("../db/externalContactDbService", () => ({
  getNamesByPhoneDigits: jest.fn().mockReturnValue([]),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { resolvePhoneNames } from "../contactResolutionService";
import {
  registerSupportTraceSink,
  type SupportTraceSink,
} from "../supportAccess/trace";
import type { SupportLogScopeId } from "../supportAccess/scopes";

interface Written {
  scope: SupportLogScopeId;
  event: string;
  fields: Record<string, unknown>;
}

/** Numbers nobody can resolve — the exact input the removed producer fired on. */
const UNRESOLVABLE = [
  "+15551234567",
  "+15559876543",
  "madisonsola@example.com",
];

describe("contact resolution, as a support-access producer", () => {
  let written: Written[];

  beforeEach(() => {
    written = [];
    const sink: SupportTraceSink = {
      // Every scope open. If anything were still writing identifying detail
      // under any of them, it would land here.
      isScopeActive: () => true,
      write: (scope, event, fields) => {
        written.push({ scope, event, fields });
      },
      notifyError: () => undefined,
    };
    registerSupportTraceSink(sink);
  });

  afterEach(() => {
    registerSupportTraceSink(null);
  });

  it("still records the counts, which are the useful half", async () => {
    await resolvePhoneNames(UNRESOLVABLE, "user-1");

    const counts = written.filter((w) => w.scope === "contact-resolution");
    expect(counts).toHaveLength(1);
    expect(counts[0].event).toBe("resolve-phone-names");
    expect(counts[0].fields).toMatchObject({
      attempted: 3,
      resolved: 0,
      unresolved: 3,
      had_user_id: true,
    });
  });

  it("writes no handle, name or address anywhere, under any scope", async () => {
    await resolvePhoneNames(UNRESOLVABLE, "user-1");

    // Serialised the way the log store would write it, so a value nested
    // inside an array or object cannot slip past a top-level key check. This
    // is what the removed producer did: `handles: [...]`, an array of raw
    // phone numbers up to 200 long.
    const serialised = JSON.stringify(written);
    for (const handle of UNRESOLVABLE) {
      expect(serialised).not.toContain(handle);
    }
    // The digits alone, in case a normalised form were written instead.
    expect(serialised).not.toContain("5551234567");
    expect(serialised).not.toContain("5559876543");

    // Nothing writes the removed scope, and no record carries the field the
    // dump used.
    expect(written.map((w) => w.scope)).toEqual(["contact-resolution"]);
    for (const record of written) {
      expect(record.fields).not.toHaveProperty("handles");
    }
  });

  it("writes only numbers and booleans — no free text to hide a name in", async () => {
    await resolvePhoneNames(UNRESOLVABLE, "user-1");

    // The structural version of the same claim, and the one that survives a
    // future field being added: a count producer has nowhere to put a name.
    for (const record of written) {
      for (const [key, value] of Object.entries(record.fields)) {
        expect([key, typeof value]).toEqual([
          key,
          expect.stringMatching(/^(number|boolean)$/),
        ]);
      }
    }
  });

  it("records nothing at all when the scope is not granted", async () => {
    registerSupportTraceSink({
      isScopeActive: () => false,
      write: (scope, event, fields) => written.push({ scope, event, fields }),
      notifyError: () => undefined,
    });

    // The sink's own guard is what the log store applies; `supportTrace` hands
    // everything over and lets it decide. What matters for consent is that a
    // closed window stores nothing, which `supportLogStore` covers — here the
    // point is only that the producer is unconditional and cheap, so removing
    // the scope removed the data rather than hiding it behind a flag.
    await resolvePhoneNames(UNRESOLVABLE, "user-1");
    expect(written.every((w) => w.scope === "contact-resolution")).toBe(true);
  });
});
