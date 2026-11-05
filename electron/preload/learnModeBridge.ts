/**
 * Learn mode bridge — BACKLOG-4120 PR2.
 *
 * `window.api.learn`. Every method is one `ipcRenderer.invoke` of one channel
 * (or one listener on the progress event) and nothing else: the gate, the
 * membership checks and what is stored are all decided in main.
 */
import { ipcRenderer } from "electron";

import type {
  LearnPreviewArgs,
  LearnRunProgressEvent,
  WindowApiLearn,
} from "../types/ipc/window-api-learn";

export const learnModeBridge: WindowApiLearn = {
  /** Available (strict autodetect_eval read) and the user's own toggle. */
  getState: () => ipcRenderer.invoke("learn:get-state"),

  /** Turn Learn mode on or off for this user. Refused when not available. */
  setEnabled: (args: { enabled: boolean }) => ipcRenderer.invoke("learn:set-enabled", args),

  /** Run the old rules over local mail. Returns ids and counts only. */
  run: (args: { windowMonths: number }) => ipcRenderer.invoke("learn:run", args),

  /** Progress of a running check: ids and counts only. Returns an unsubscribe. */
  onRunProgress: (callback: (progress: LearnRunProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: LearnRunProgressEvent) => {
      callback(progress);
    };
    ipcRenderer.on("learn:run-progress", listener);
    return () => {
      ipcRenderer.removeListener("learn:run-progress", listener);
    };
  },

  cleanupNext: (args?: { exclude: string[] }) =>
    args === undefined ? ipcRenderer.invoke("learn:cleanup-next") : ipcRenderer.invoke("learn:cleanup-next", args),
  cleanupAnswer: (args) => ipcRenderer.invoke("learn:cleanup-answer", args),
  sampleDraw: (args: { windowMonths: number }) => ipcRenderer.invoke("learn:sample-draw", args),
  sampleNext: () => ipcRenderer.invoke("learn:sample-next"),
  sampleAnswer: (args) => ipcRenderer.invoke("learn:sample-answer", args),
  score: () => ipcRenderer.invoke("learn:score"),
  deleteAnswers: () => ipcRenderer.invoke("learn:delete-answers"),
  preview: (args: LearnPreviewArgs) => ipcRenderer.invoke("learn:preview", args),
  /** Open (downloading first if needed) the one attachment the question is about. */
  attachmentOpen: (args: { detectionId: string; attachmentId: string }) =>
    ipcRenderer.invoke("learn:attachment-open", args),
};
