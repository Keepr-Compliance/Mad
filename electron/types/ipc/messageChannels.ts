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

/**
 * One-way events: a macOS Messages import that the RENDERER did not start has
 * begun / ended (BACKLOG-2772).
 *
 * The sync queue lives in the renderer (`SyncOrchestratorService`), so a
 * main-initiated import — the one the transaction trigger runs when a deal is
 * created or its start date moves earlier — cannot enqueue itself. It announces
 * itself instead, and the renderer mirrors it into the queue as an EXTERNAL
 * item, the same shape the iPhone sync already uses.
 *
 * Why it matters that it appears there at all: the queue item is what renders
 * the Cancel button. Before this, `messagesSyncTrigger` called the import
 * service directly and the run had no surface of any kind — the service's
 * cancel would have stopped it, but nothing ever offered the user the button.
 * On a large library, creating a deal started an unstoppable full-device scan.
 */
export const MESSAGES_BACKGROUND_IMPORT_STARTED_CHANNEL =
  "messages:background-import-started";
export const MESSAGES_BACKGROUND_IMPORT_FINISHED_CHANNEL =
  "messages:background-import-finished";
