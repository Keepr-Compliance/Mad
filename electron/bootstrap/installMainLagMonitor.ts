/**
 * BACKLOG-3884 follow-up: start the main-process event-loop lag log (see
 * electron/services/mainLagMonitor.ts). Side-effect module imported from
 * main.ts. Always on; a sleep/resume resets the baseline so time asleep is not
 * reported as a block.
 */
import { app, powerMonitor } from "electron";
import log from "electron-log";
import { performance } from "perf_hooks";
import { createMainLagMonitor } from "../services/mainLagMonitor";
import { currentIpcReplySizePhase, ipcActivitySnapshot } from "../services/ipcReplySize";

const monitor = createMainLagMonitor({
  // Monotonic: a wall-clock adjustment is not a block.
  now: () => performance.now(),
  log: (line) => log.warn(line),
  context: () => {
    const ipc = ipcActivitySnapshot();
    let syncPhase: string | null = null;
    try {
      syncPhase = currentIpcReplySizePhase();
    } catch {
      syncPhase = null;
    }
    return { ...ipc, syncPhase };
  },
});

monitor.start();

// powerMonitor is only usable once the app is ready.
void app
  .whenReady()
  .then(() => {
    powerMonitor.on("suspend", () => monitor.resetBaseline());
    powerMonitor.on("resume", () => monitor.resetBaseline());
  })
  .catch(() => {
    // Telemetry only.
  });
