/**
 * Settings > Troubleshooting > "Save diagnostic log…" (BACKLOG-3819).
 *
 * Desktop logs are encrypted at rest. This channel writes a decrypted, redacted
 * copy to a location the user picks — the supported way to send a log to support.
 */
import { ipcMain, dialog, BrowserWindow, app } from "electron";
import fs from "fs";
import path from "path";

import { wrapHandler } from "../utils/wrapHandler";
import logService from "../services/logService";
import { getConfiguredLogDirectory } from "../services/logScrub";
import { getLogSink } from "../services/sealedLogSink";
import { buildDiagnosticLogText } from "../services/diagnosticLogExport";
import { getDataKeyService } from "../services/atRest/dataKeyService";

export const SAVE_DIAGNOSTIC_LOG_CHANNEL = "system:save-diagnostic-log";

export interface SaveDiagnosticLogResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  /** Files that could not be decrypted on this computer (named, never their bytes). */
  unreadable?: string[];
  error?: string;
}

/** Resolve a data key by id: the sink's copy first, then the key service. */
async function keyLookup(): Promise<(keyId: string) => Buffer | null> {
  const sink = getLogSink();
  const held = new Map<string, Buffer>();
  try {
    const current = await getDataKeyService().currentKey();
    held.set(current.keyId, current.key);
  } catch {
    // Key unavailable: sealed files are reported as unreadable in the export.
  }
  return (id) => sink.keyFor(id) ?? held.get(id) ?? null;
}

export function registerDiagnosticLogHandlers(): void {
  ipcMain.handle(
    SAVE_DIAGNOSTIC_LOG_CHANNEL,
    wrapHandler(async (event): Promise<SaveDiagnosticLogResult> => {
      const logDir = getConfiguredLogDirectory();
      if (!logDir) return { success: false, error: "The log location is not known" };

      const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
      const dateStr = new Date().toISOString().split("T")[0];
      const options = {
        title: "Save diagnostic log",
        defaultPath: path.join(app.getPath("downloads"), `keepr-diagnostic-log-${dateStr}.txt`),
        filters: [{ name: "Text Files", extensions: ["txt"] }],
      };
      const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return { success: false, canceled: true };

      const built = buildDiagnosticLogText(logDir, {
        keyFor: await keyLookup(),
        pending: getLogSink().pendingLines,
      });
      // User-chosen export: plaintext by design (it is what support reads).
      await fs.promises.writeFile(choice.filePath, built.text, { encoding: "utf8", mode: 0o600 });
      const unreadable = built.files.filter((f) => f.status === "unreadable").map((f) => f.name);
      logService.info(
        `[DiagnosticLog] saved (${built.files.length} file(s), ${unreadable.length} unreadable)`,
        "DiagnosticLogHandlers",
      );
      return { success: true, filePath: choice.filePath, unreadable };
    }, { module: "DiagnosticLog" }),
  );
}
