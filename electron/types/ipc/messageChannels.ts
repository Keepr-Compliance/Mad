/**
 * Message-import IPC channel names.
 *
 * BACKLOG-2748 / PR-SOP §6.2e: a channel name typed out on both sides of the
 * bridge is a rule kept by hand. `ipcMain.on("messages:import-cancel")` and
 * `ipcRenderer.send("messages:import-cancel")` must agree exactly, and nothing
 * fails if they stop agreeing — the send lands on no listener, the Cancel button
 * does nothing, and every type check, test and CI leg stays green. The failure
 * mode here is a WRONG name (not a missing one), so a single exported constant
 * imported by both sides is enough: a typo becomes a compile error.
 *
 * Runtime constants only — this module is imported by the preload bundle, so it
 * must not pull in type-only modules with heavy dependency graphs.
 *
 * @module types/ipc/messageChannels
 */

/** One-way event: stop the running macOS Messages import. */
export const MESSAGES_IMPORT_CANCEL_CHANNEL = "messages:import-cancel";
