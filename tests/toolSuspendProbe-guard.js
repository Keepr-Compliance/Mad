/**
 * BACKLOG-4002 (SR R10): no jest run ever starts a real powershell.exe.
 *
 * BackupService asks electron/services/toolSuspendProbe for the backup tool's thread
 * states on Windows, after a minute with no output. On the Windows CI runner every
 * `new BackupService()` has toolHoldHandling = true, so any suite that advances fake
 * timers past that minute would spawn powershell.exe against a FAKE pid — and the
 * network guard (tests/net-guard) does not cover child_process.
 *
 * So the probe is stubbed for EVERY suite here, rather than per suite (a per-suite mock
 * fails open for every suite written later). The stub answers "unknown", which the
 * service never reads as suspended, and records each call on
 * globalThis.__toolSuspendProbeCalls. A suite that needs samples injects its own probe
 * on the service (`service.threadStateProbe = ...`). The probe module's own test uses
 * jest.requireActual.
 */
jest.mock("../electron/services/toolSuspendProbe", () => {
  const actual = jest.requireActual("../electron/services/toolSuspendProbe");
  return {
    ...actual,
    probeToolThreadState: (pid) => {
      globalThis.__toolSuspendProbeCalls = globalThis.__toolSuspendProbeCalls || [];
      globalThis.__toolSuspendProbeCalls.push(pid);
      return Promise.resolve({ kind: "unknown", reason: "jest-stub" });
    },
  };
});
