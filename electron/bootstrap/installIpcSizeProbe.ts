/**
 * BACKLOG-3785 repro probe — DEV ONLY, double-gated (!app.isPackaged && KEEPR_IPC_PROBE=1).
 *
 * Wraps ipcMain.handle so every invoke reply is timed and sized (v8 structured-clone bytes, the
 * same encoding Electron uses to ship the reply to the renderer). Logs one line per reply that is
 * slow (>= 200 ms) or large (>= 256 KB), with the channel name only — never the payload.
 * Must be imported before any handler registers (main.ts, right after installAppDataPaths).
 */
import { app, ipcMain } from "electron";
import v8 from "v8";

const SLOW_MS = 200;
const LARGE_BYTES = 256 * 1024;

if (!app.isPackaged && process.env.KEEPR_IPC_PROBE === "1") {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    original(channel, async (event, ...args) => {
      const t0 = performance.now();
      const result = await listener(event, ...args);
      const ms = performance.now() - t0;
      let bytes = -1;
      try {
        bytes = v8.serialize(result).byteLength;
      } catch {
        /* non-cloneable — Electron will throw on its own */
      }
      if (ms >= SLOW_MS || bytes >= LARGE_BYTES) {
        // eslint-disable-next-line no-console
        console.log(
          `[IPC_PROBE] ${new Date().toISOString()} channel=${channel} handlerMs=${ms.toFixed(0)} replyBytes=${bytes}`,
        );
      }
      return result;
    })) as typeof ipcMain.handle;
}
