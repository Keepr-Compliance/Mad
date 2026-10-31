/**
 * BACKLOG-4050 C2 / C2s / C8 (breadcrumb half).
 *
 * child_process breadcrumb shapes transcribed from
 * @sentry/node-core build/cjs/integrations/childProcess.js:
 *   exit  -> { category: "child_process", message: "Child process exited with code '<code>'", level: "warning", data: { spawnfile } }
 *   error -> { category: "child_process", message: "Child process errored with '<error.message>'", level: "error", data }
 * For a spawn ENOENT, error.message is "spawn <full path> ENOENT" and `data`
 * is undefined (the "spawn" event never fired). Synthetic data only.
 */
import { scrubBreadcrumb, scrubBreadcrumbOrThrow } from "../sentryBreadcrumbScrub";

const EXE_RAW = String.raw`C:\Users\Jane Doe\AppData\Local\Programs\keepr\resources\win\libimobiledevice\idevice_id.exe`;
const EXE_SCRUBBED = String.raw`C:\Users\[user]\AppData\Local\Programs\keepr\resources\win\libimobiledevice\idevice_id.exe`;
const OPTIONS = {
  homeDir: String.raw`C:\Users\Jane Doe`,
  appRoots: [String.raw`C:\Users\Jane Doe\AppData\Local\Programs\keepr\resources`],
};
// pii-allow-uuid: invented all-zero fixture id, not from any live row
const T = "00000000-0000-4000-8000-000000000001";
// pii-allow-uuid: invented all-zero fixture id, not from any live row
const C = "00000000-0000-4000-8000-000000000002";

describe("BACKLOG-4050 C2: child_process breadcrumbs lose the profile name", () => {
  it("exit shape: spawnfile and message", () => {
    const out = scrubBreadcrumb(
      { category: "child_process", message: "Child process exited with code '1'", level: "warning", data: { spawnfile: EXE_RAW } },
      OPTIONS,
    );
    expect(JSON.stringify(out)).not.toMatch(/Jane|Doe/);
  });

  it("error shape: the path inside the message", () => {
    const out = scrubBreadcrumb(
      { category: "child_process", message: `Child process errored with 'spawn ${EXE_RAW} ENOENT'`, level: "error", data: undefined },
      OPTIONS,
    );
    expect(JSON.stringify(out)).not.toMatch(/Jane|Doe/);
  });

  it("without host options (the pattern rules alone) the name still goes", () => {
    const out = scrubBreadcrumb({ category: "child_process", message: "x", data: { spawnfile: EXE_RAW } });
    expect(JSON.stringify(out)).not.toMatch(/Jane|Doe/);
  });
});

describe("BACKLOG-4050 C2s: what support needs from them survives", () => {
  it("exit: spawnfile keeps the full path minus the profile name", () => {
    const out = scrubBreadcrumb(
      { category: "child_process", message: "Child process exited with code '1'", level: "warning", data: { spawnfile: EXE_RAW } },
      OPTIONS,
    );
    expect(out.data).toEqual({ spawnfile: EXE_SCRUBBED });
    expect(out.message).toBe("Child process exited with code '1'");
    expect(out.level).toBe("warning");
  });

  it("error: the code and the tool path are kept", () => {
    const out = scrubBreadcrumb(
      { category: "child_process", message: `Child process errored with 'spawn ${EXE_RAW} ENOENT'`, level: "error" },
      OPTIONS,
    );
    expect(out.message).toBe(`Child process errored with 'spawn ${EXE_SCRUBBED} ENOENT'`);
  });
});

describe("BACKLOG-4050 C8 (breadcrumb half): record ids pass unchanged", () => {
  it("transactionId and contactId in data", () => {
    const out = scrubBreadcrumb(
      { category: "auto_link.start", message: "m", data: { transactionId: T, contactId: C, normalizedAddress: "[address]", stage: "s" } },
      OPTIONS,
    );
    expect(out.data).toEqual({ transactionId: T, contactId: C, normalizedAddress: "[address]", stage: "s" });
  });
});

describe("BACKLOG-4050 A7: the in-event variant throws, beforeBreadcrumb's does not", () => {
  const hostile = {
    category: "x",
    get message(): string {
      throw new Error("getter throws");
    },
  };

  it("scrubBreadcrumbOrThrow throws", () => {
    expect(() => scrubBreadcrumbOrThrow(hostile as unknown as { message?: string })).toThrow("getter throws");
  });

  it("scrubBreadcrumb does not", () => {
    expect(() => scrubBreadcrumb(hostile as unknown as { message?: string })).not.toThrow();
  });
});
