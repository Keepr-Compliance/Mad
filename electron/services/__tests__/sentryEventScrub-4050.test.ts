/**
 * BACKLOG-4050 C3 / C3s / C6 / C8 (event half): scrubMainEvent.
 *
 * Event shape: a main-process exception event as @sentry/core builds it
 * (exception.values[] with type / value / stacktrace / mechanism), the leak in
 * values[1] so a scrub of values[0] only is caught, and a renderer-shaped
 * second fixture (the same beforeSend sees renderer events re-captured over
 * IPC). Synthetic data only.
 */
import { scrubMainEvent } from "../sentryEventScrub";

// pii-allow-uuid: invented all-zero fixture id, not from any live row
const T = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented all-zero fixture id, not from any live row
const C = "00000000-0000-4000-8000-000000000002";
const OPTIONS = { homeDir: "/Users/Jane Doe", appRoots: ["/Users/Jane Doe/Library/Application Support/keepr"] };

function makeEvent(): Record<string, unknown> {
  return {
    event_id: "0".repeat(32),
    release: "2.44.0",
    environment: "production",
    level: "error",
    fingerprint: ["{{ default }}", "export"],
    user: { id: "user-1" },
    contexts: { os: { name: "Windows", version: "10.0.26100" }, device: { arch: "x64" } },
    tags: { feature: "export", where: String.raw`C:\Users\Jane Doe\Desktop` },
    message: "export failed for jane.doe@example.com",
    logentry: { message: "export failed for %s", formatted: "export failed at /Users/Jane Doe/x/y", params: ["jane.doe@example.com"] },
    exception: {
      values: [
        {
          type: "Error",
          value: "wrapper",
          stacktrace: { frames: [{ filename: "app:///dist-electron/main.js", lineno: 10, colno: 5, function: "run" }] },
          mechanism: { type: "generic", handled: true },
        },
        {
          type: "Error",
          value:
            "EACCES: permission denied, open '/Users/Jane Doe/Downloads/Transaction_742_Evergreen_Terrace_1729800000000.pdf' for jane.doe@example.com",
          stacktrace: { frames: [{ filename: "app:///dist-electron/services/pdf.js", lineno: 42, colno: 1, function: "write" }] },
        },
      ],
    },
    extra: {
      transactionId: T,
      contactId: C,
      count: 3,
      error_message: String.raw`spawn C:\Users\Jane Doe\Desktop\Smith-tool.exe ENOENT`,
      nested: { path: "/Users/Jane Doe/Desktop/Smith deal.pdf" },
    },
    breadcrumbs: [
      { category: "child_process", message: "Child process exited with code '1'", data: { spawnfile: String.raw`C:\Users\Jane Doe\x\tool.exe` } },
      { category: "auto_link.start", message: "m", data: { transactionId: T, contactId: C } },
    ],
  };
}

describe("BACKLOG-4050 C3: every text field of every event is scrubbed", () => {
  it("no profile name, address, chosen file name or email anywhere in the output", () => {
    const out = JSON.stringify(scrubMainEvent(makeEvent(), OPTIONS));
    expect(out).not.toMatch(/Jane|Doe|Evergreen|Smith|742|jane\.doe@/);
  });

  it("the leak in exception.values[1] is scrubbed (not values[0] only)", () => {
    const out = scrubMainEvent(makeEvent(), OPTIONS) as { exception: { values: Array<{ value: string }> } };
    expect(out.exception.values[1].value).toBe(
      "EACCES: permission denied, open '/Users/[user]/Downloads/Transaction_[address]_1729800000000.pdf' for j***@example.com",
    );
  });

  it("an event with no tags at all is scrubbed too (no tag gate)", () => {
    const renderer = { message: "render failed at /Users/Jane Doe/Desktop/Smith.pdf", exception: { values: [{ type: "TypeError", value: "x jane.doe@example.com" }] } };
    expect(JSON.stringify(scrubMainEvent(renderer, OPTIONS))).not.toMatch(/Jane|Doe|Smith|jane\.doe@/);
  });

  it("does not mutate its input", () => {
    const event = makeEvent();
    const before = JSON.stringify(event);
    scrubMainEvent(event, OPTIONS);
    expect(JSON.stringify(event)).toBe(before);
  });
});

describe("BACKLOG-4050 C3s: what support needs is byte-identical", () => {
  it("type, stack frames, mechanism, release, environment, contexts, user, fingerprint, tag keys", () => {
    const input = makeEvent();
    const out = scrubMainEvent(makeEvent(), OPTIONS) as Record<string, unknown> & {
      exception: { values: Array<Record<string, unknown>> };
      tags: Record<string, unknown>;
    };
    const inEx = (input.exception as { values: Array<Record<string, unknown>> }).values;
    out.exception.values.forEach((v, i) => {
      expect(v.type).toBe(inEx[i].type);
      expect(v.stacktrace).toEqual(inEx[i].stacktrace);
      expect(v.mechanism).toEqual(inEx[i].mechanism);
    });
    for (const key of ["release", "environment", "level", "fingerprint", "user", "contexts", "event_id"]) {
      expect(out[key]).toEqual(input[key]);
    }
    expect(Object.keys(out.tags)).toEqual(Object.keys(input.tags as object));
    expect(out.tags.feature).toBe("export");
    expect(out.tags.where).toBe(String.raw`C:\Users\[user]\Desktop`);
  });

  it("the error code and directories stay in the message text", () => {
    const out = scrubMainEvent(makeEvent(), OPTIONS) as { extra: { error_message: string } };
    expect(out.extra.error_message).toBe(String.raw`spawn C:\Users\[user]\Desktop\[file] ENOENT`);
  });

  it("known residue: an UNQUOTED path with a space in a folder name keeps the text after the space", () => {
    const out = scrubMainEvent({ message: "spawn /Users/Jane Doe/Desktop/Deal Folder/tool ENOENT" }, OPTIONS) as { message: string };
    expect(out.message).toBe("spawn /Users/[user]/Desktop/[file] Folder/tool ENOENT");
  });
});

describe("BACKLOG-4050 C8 (event half): ids survive end to end", () => {
  it("extra and breadcrumb ids byte-identical", () => {
    const out = scrubMainEvent(makeEvent(), OPTIONS) as {
      extra: Record<string, unknown>;
      breadcrumbs: Array<{ data: Record<string, unknown> }>;
    };
    expect(out.extra.transactionId).toBe(T);
    expect(out.extra.contactId).toBe(C);
    expect(out.extra.count).toBe(3);
    expect(out.breadcrumbs[1].data).toEqual({ transactionId: T, contactId: C });
  });
});

describe("BACKLOG-4050 C6: a scrub failure throws (the caller drops the event)", () => {
  it("a hostile breadcrumb throws out of scrubMainEvent", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter throws");
      },
    };
    expect(() => scrubMainEvent({ breadcrumbs: [hostile] }, OPTIONS)).toThrow("getter throws");
  });
});
