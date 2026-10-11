/**
 * BACKLOG-3903 — disconnecting a mailbox stops every in-flight fetch for it.
 *
 * THE DEFECT
 * ----------
 * `handleDisconnectMailbox` deleted the token row and returned. Nothing told
 * the fetch paths. A fetch that had already called `initialize()` kept paging
 * with the access token held in memory by the fetch service (Microsoft has no
 * revocation endpoint, so Graph keeps honouring it until it expires), and
 * `fetchStoreAndDedup` then wrote everything it got back. Emails from the
 * disconnected mailbox kept arriving after the user had disconnected it.
 *
 * THE SHAPE OF THE FIX
 * --------------------
 * One counter per provider. Disconnect bumps it and aborts every scope that
 * is open for that provider. A fetch path captures the counter BEFORE it calls
 * `initialize()` — the moment it binds to one mailbox's token — and the write
 * step refuses to write once the counter has moved. The abort only saves
 * bandwidth; the write-time check is what guarantees nothing is stored.
 *
 * Capturing at `initialize()`, not at the write step's entry, is the point: a
 * later round of the same run (sent items, all folders) still uses the token
 * loaded at `initialize()`, so a counter read at its own entry would already
 * hold the post-disconnect value and the check would pass.
 */

export type MailboxProvider = "microsoft" | "google";

const generations: Record<MailboxProvider, number> = {
  microsoft: 0,
  google: 0,
};

const openControllers: Record<MailboxProvider, Set<AbortController>> = {
  microsoft: new Set(),
  google: new Set(),
};

/** The provider's current generation. Capture it before `initialize()`. */
export function currentMailboxGeneration(provider: MailboxProvider): number {
  return generations[provider];
}

/** True once the provider was disconnected after `generation` was captured. */
export function isMailboxGenerationStale(
  provider: MailboxProvider,
  generation: number,
): boolean {
  return generations[provider] !== generation;
}

/**
 * Called by the disconnect handler, before anything else it does. Every write
 * bound to an earlier generation is refused from here on, and every open scope
 * for the provider is aborted.
 */
export function invalidateMailboxFetches(provider: MailboxProvider): void {
  generations[provider] += 1;
  for (const controller of openControllers[provider]) {
    controller.abort();
  }
  openControllers[provider].clear();
}

export interface MailboxFetchScope {
  readonly provider: MailboxProvider;
  readonly generation: number;
  /** Aborts on disconnect of this provider, or when `parent` aborts. */
  readonly signal: AbortSignal;
  isStale(): boolean;
  close(): void;
}

/**
 * Open a scope for one fetch of one provider. Call before `initialize()`;
 * `close()` in a `finally`.
 */
export function openMailboxFetchScope(
  provider: MailboxProvider,
  parent?: AbortSignal,
): MailboxFetchScope {
  const generation = generations[provider];
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  openControllers[provider].add(controller);
  return {
    provider,
    generation,
    signal: controller.signal,
    isStale: () => isMailboxGenerationStale(provider, generation),
    close: () => {
      openControllers[provider].delete(controller);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

/** Thrown by the write step when its mailbox was disconnected mid-fetch. */
export class MailboxDisconnectedError extends Error {
  constructor(provider: MailboxProvider) {
    super(`Mailbox disconnected during fetch (${provider})`);
    this.name = "MailboxDisconnectedError";
  }
}

export function isMailboxDisconnectedError(error: unknown): boolean {
  return error instanceof MailboxDisconnectedError;
}
