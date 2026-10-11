/**
 * BACKLOG-3837: a list was answered without its message-derived people (the dedicated
 * read was not ready). When that read lands, tell the renderer so the open screen
 * re-reads (a cache hit) and fills them in. Used by the contact lists
 * (contactHandlers.ts) and the Attach Messages roster (emailLinkingHandlers.ts).
 *
 * Joins the read already running and never starts one (a failed read is not running:
 * nothing to wait for, and the renderer's 15 s backstop retries it); nothing is read
 * on main; a failed read sends nothing.
 */
import { sendToMainWindow } from "../windowRegistry";
import { joinMessageDerivedRead } from "./db/messageDerivedContactsCache";

export const MESSAGE_DERIVED_READY_CHANNEL = "contacts:message-derived-ready";

export function notifyWhenMessageDerivedReady(userId: string): void {
  notifyWhenReadLands(userId, joinMessageDerivedRead(userId));
}

/**
 * The same notice for any pending off-main read the renderer re-reads on (the Attach
 * Messages roster uses it too: the modal re-reads both on this one channel). `running`
 * is a read already in flight, or null (nothing to wait for: nothing sent).
 */
export function notifyWhenReadLands(userId: string, running: Promise<unknown[] | null> | null): void {
  if (!running) return;
  void running
    .then((rows) => {
      if (rows) sendToMainWindow(MESSAGE_DERIVED_READY_CHANNEL, { userId });
    })
    .catch(() => undefined);
}
