/**
 * @jest-environment node
 *
 * BACKLOG-3884 follow-up — the IPC wrapper records which channel is running,
 * logs handlers that THROW after >= 1 s, and measures a reply once when it is
 * both slow and inside a sync.
 */
import {
  ipcActivitySnapshot,
  lastIpcChannelStarted,
  resetIpcActivityForTests,
  wrapHandleForReplySize,
  SLOW_HANDLER_MS,
  LARGE_REPLY_BYTES,
  type HandleTarget,
} from "../ipcReplySize";

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function setup(durationMs: number, phase: string | null = null) {
  const registered = new Map<string, Listener>();
  const target: HandleTarget = { handle: (c, l) => void registered.set(c, l) };
  const lines: string[] = [];
  let calls = 0;
  wrapHandleForReplySize(target, {
    phase: () => phase,
    now: () => (calls++ % 2 === 0 ? 1_000 : 1_000 + durationMs),
    log: (line) => lines.push(line),
  });
  return { target, registered, lines };
}

afterEach(() => resetIpcActivityForTests());

describe("BACKLOG-3884: slow handler that throws", () => {
  it(`logs threw=1 at ${SLOW_HANDLER_MS} ms with no error text, and the rejection still reaches the caller`, async () => {
    const { target, registered, lines } = setup(SLOW_HANDLER_MS);
    target.handle("transactions:get-review-state", async () => {
      throw new Error("secret detail about a deal");
    });
    await expect(registered.get("transactions:get-review-state")!({})).rejects.toThrow(
      "secret detail about a deal",
    );
    expect(lines).toEqual([
      "[IpcSlowHandler] channel=transactions:get-review-state durationMs=1000 threw=1",
    ]);
  });

  it("is silent when it throws at 999 ms", async () => {
    const { target, registered, lines } = setup(SLOW_HANDLER_MS - 1);
    target.handle("x", async () => {
      throw new Error("boom");
    });
    await expect(registered.get("x")!({})).rejects.toThrow("boom");
    expect(lines).toEqual([]);
  });
});

describe("BACKLOG-3884: reply measured once when slow AND in a sync", () => {
  it("walks the reply a single time and logs both lines", async () => {
    const { target, registered, lines } = setup(2_000, "messages");
    let reads = 0;
    const big = "x".repeat(LARGE_REPLY_BYTES + 10);
    const reply = {
      get payload() {
        reads += 1;
        return big;
      },
    };
    target.handle("messages:get-all", async () => reply);
    await registered.get("messages:get-all")!({});
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[IpcSlowHandler\] channel=messages:get-all durationMs=2000 approxBytes=\d+$/);
    expect(lines[1]).toMatch(/^\[IpcReplySize\] channel=messages:get-all approxBytes=\d+ durationMs=2000 phase=messages$/);
    expect(reads).toBe(1);
  });
});

describe("BACKLOG-3884: IPC activity tracker", () => {
  it("records the channel at handler start and lists it in flight until it settles", async () => {
    const { target, registered } = setup(10);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seenInside: string[] = [];
    target.handle("transactions:sync-review-queue", async () => {
      seenInside = ipcActivitySnapshot().inFlight;
      await gate;
      return 1;
    });
    expect(lastIpcChannelStarted()).toBeNull();
    const p = registered.get("transactions:sync-review-queue")!({});
    expect(lastIpcChannelStarted()).toBe("transactions:sync-review-queue");
    expect(seenInside).toEqual(["transactions:sync-review-queue"]);
    release();
    await p;
    expect(ipcActivitySnapshot().inFlight).toEqual([]);
    expect(lastIpcChannelStarted()).toBe("transactions:sync-review-queue");
  });

  it("clears in-flight when the handler throws", async () => {
    const { target, registered } = setup(10);
    target.handle("y", async () => {
      throw new Error("no");
    });
    await expect(registered.get("y")!({})).rejects.toThrow();
    expect(ipcActivitySnapshot().inFlight).toEqual([]);
  });
});
