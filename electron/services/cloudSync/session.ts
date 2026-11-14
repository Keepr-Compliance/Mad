/**
 * Who is signed in, for Keepr Cloud — BACKLOG-4243 PR-2 (plan §5.1).
 *
 * A user counts only when the session file loads (not expired) AND the session
 * was validated this launch (`getLastActivity` set). A cached answer is reused
 * only while the session epoch is unchanged; every session event bumps it.
 * The restart case needs no `saved` event (R1 of the plan check).
 */
export interface SessionDeps {
  loadSession(): Promise<{ user?: { id?: unknown } | null; sessionToken?: unknown } | null>;
  getLastActivity(sessionToken: string): number | null;
  onSessionChanged(listener: (change: { kind: "saved" | "cleared"; userId: string | null }) => void): () => void;
}

export interface SessionUser {
  userId: string;
  epoch: number;
}

export class SessionIdentity {
  private epochValue = 0;
  private cache: SessionUser | null = null;
  /** Set after `wrong_account`: no user until the next session event. */
  private suspended = false;
  private readonly unsubscribe: () => void;
  private readonly clearedListeners = new Set<() => void>();

  constructor(private readonly deps: SessionDeps) {
    this.unsubscribe = deps.onSessionChanged((change) => {
      this.epochValue++;
      this.cache = null;
      this.suspended = false;
      if (change.kind === "cleared") for (const l of Array.from(this.clearedListeners)) l();
    });
  }

  get epoch(): number {
    return this.epochValue;
  }

  onCleared(listener: () => void): () => void {
    this.clearedListeners.add(listener);
    return () => this.clearedListeners.delete(listener);
  }

  /** After `wrong_account`: drops the cache; no user until the next session event. */
  invalidate(): void {
    this.epochValue++;
    this.cache = null;
    this.suspended = true;
  }

  async current(): Promise<SessionUser | null> {
    if (this.suspended) return null;
    if (this.cache && this.cache.epoch === this.epochValue) return this.cache;
    const epoch = this.epochValue;
    let session: Awaited<ReturnType<SessionDeps["loadSession"]>>;
    try {
      session = await this.deps.loadSession();
    } catch {
      return null;
    }
    const userId = session?.user?.id;
    const token = session?.sessionToken;
    if (typeof userId !== "string" || !userId || typeof token !== "string" || !token) return null;
    if (this.deps.getLastActivity(token) === null) return null;
    if (epoch !== this.epochValue) return null;
    this.cache = { userId, epoch };
    return this.cache;
  }

  dispose(): void {
    this.unsubscribe();
  }
}
