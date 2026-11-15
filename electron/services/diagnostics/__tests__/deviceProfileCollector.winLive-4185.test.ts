/**
 * @jest-environment node
 */
/**
 * BACKLOG-4185 B6: the REAL Windows probe, on a real Windows machine.
 * Env-gated (KEEPR_WIN_PROFILE_PROBE=1) and run only by the manual
 * workflow_dispatch job "Windows device-profile probe" (win-profile-probe.yml),
 * never inside the required Windows Test & Lint job. Windows Server has no
 * root/SecurityCenter2, so CI sees av "unavailable"; real AV is covered by
 * the transcribed client fixture and founder PC QA.
 */
import os from "os";
import { collectHardwareProfile, defaultCollectorDeps, WINDOWS_PROBE_TIMEOUT_MS } from "../deviceProfileCollector";
import { AV_PRODUCTS } from "../../deviceProfile/buildDeviceProfile";

const live = process.platform === "win32" && process.env.KEEPR_WIN_PROFILE_PROBE === "1";
const maybe = live ? describe : describe.skip;

maybe("B6 Windows probe (live)", () => {
  it(
    "parses within the timeout, the event loop keeps ticking, every field is in its vocabulary",
    async () => {
      let ticks = 0;
      const timer = setInterval(() => (ticks += 1), 5);
      const started = Date.now();
      let out;
      try {
        out = await collectHardwareProfile(defaultCollectorDeps(null, process.env.LOCALAPPDATA ?? os.tmpdir()));
      } finally {
        clearInterval(timer);
      }
      const ms = Date.now() - started;
      const summary = { av: out.av, diskType: out.diskType, diskBus: out.diskBus, osBuild: out.osBuild, osDisplayVersion: out.osDisplayVersion };
      process.stdout.write(`[4185 B6] probe ms=${ms} ticks=${ticks} ${JSON.stringify(summary)}\n`);
      expect(ms).toBeLessThan(WINDOWS_PROBE_TIMEOUT_MS);
      expect(ticks).toBeGreaterThan(20);
      if (Array.isArray(out.av)) for (const p of out.av) expect(AV_PRODUCTS).toContain(p);
      else expect(["unavailable", "unknown"]).toContain(out.av);
      expect(out.diskType).not.toBe("unknown");
    },
    WINDOWS_PROBE_TIMEOUT_MS + 5_000,
  );
});
