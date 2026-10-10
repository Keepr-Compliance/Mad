/**
 * @jest-environment node
 *
 * BACKLOG-3884 — any ipcMain.handle that takes >= 1 s logs ONE line naming its
 * channel, at any time (not only during a sync), with no payload content.
 */
import { wrapHandleForReplySize, SLOW_HANDLER_MS, type HandleTarget } from "../ipcReplySize";

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function setup(durationMs: number, phase: string | null = null) {
  const registered = new Map<string, Listener>();
  const target: HandleTarget = { handle: (c, l) => void registered.set(c, l) };
  const lines: string[] = [];
  let calls = 0;
  wrapHandleForReplySize(target, {
    phase: () => phase,
    // first read = start, second = end
    now: () => (calls++ % 2 === 0 ? 1_000 : 1_000 + durationMs),
    log: (line) => lines.push(line),
  });
  return { target, registered, lines };
}

const reply = () => ({ rows: [{ id: "secret-id-1", filename: "secret-name.pdf" }] });

describe("BACKLOG-3884: slow IPC handler log", () => {
  it(`logs channel, duration and size for a handler of exactly ${SLOW_HANDLER_MS} ms outside a sync — no content`, async () => {
    const { target, registered, lines } = setup(SLOW_HANDLER_MS);
    target.handle("transactions:get-all-attachments", async () => reply());
    await registered.get("transactions:get-all-attachments")!({});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[IpcSlowHandler\] channel=transactions:get-all-attachments durationMs=1000 approxBytes=\d+$/,
    );
    expect(lines[0]).not.toContain("secret");
  });

  it("is silent at 999 ms", async () => {
    const { target, registered, lines } = setup(SLOW_HANDLER_MS - 1);
    target.handle("transactions:get-overview", async () => reply());
    await registered.get("transactions:get-overview")!({});
    expect(lines).toEqual([]);
  });

  it("returns the reply unchanged", async () => {
    const { target, registered } = setup(5_000);
    const r = reply();
    target.handle("x", async () => r);
    await expect(registered.get("x")!({})).resolves.toBe(r);
  });
});
