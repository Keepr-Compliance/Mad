/**
 * @jest-environment node
 *
 * BACKLOG-3785 — one log line per ipcMain.handle reply of ~1 MB or more while a
 * sync is running; nothing outside a sync; never changes the reply.
 */
import {
  approxSerializedBytes,
  wrapHandleForReplySize,
  LARGE_REPLY_BYTES,
  type HandleTarget,
} from "../ipcReplySize";

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function setup(phase: string | null) {
  const registered = new Map<string, Listener>();
  const target: HandleTarget = {
    handle: (channel, listener) => {
      registered.set(channel, listener);
    },
  };
  const lines: string[] = [];
  let now = 1000;
  const state = { phase };
  wrapHandleForReplySize(target, {
    phase: () => state.phase,
    now: () => (now += 7),
    log: (line) => lines.push(line),
  });
  return { target, registered, lines, state };
}

const bigReply = () => ({ rows: Array.from({ length: 12_000 }, (_, i) => ({ id: `id-${i}`, body: "x".repeat(100) })) });

describe("BACKLOG-3785: large IPC reply log", () => {
  it("logs channel, approx bytes, duration and phase for a reply >= 1 MB during a sync — and no payload content", async () => {
    const { target, registered, lines } = setup("storing:attachments");
    target.handle("messages:get-all", async () => bigReply());
    const reply = await registered.get("messages:get-all")!({}, "arg");
    expect((reply as { rows: unknown[] }).rows).toHaveLength(12_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[IpcReplySize\] channel=messages:get-all approxBytes=\d+ durationMs=7 phase=storing:attachments$/,
    );
    const bytes = Number(/approxBytes=(\d+)/.exec(lines[0])![1]);
    expect(bytes).toBeGreaterThanOrEqual(LARGE_REPLY_BYTES);
    expect(lines[0]).not.toContain("xxxx");
    expect(lines[0]).not.toContain("id-1");
  });

  it("is silent for a small reply, and for any reply outside a sync", async () => {
    const during = setup("running");
    during.target.handle("small", () => ({ ok: true }));
    await during.registered.get("small")!({});
    expect(during.lines).toEqual([]);

    const outside = setup(null);
    outside.target.handle("big", async () => bigReply());
    await outside.registered.get("big")!({});
    expect(outside.lines).toEqual([]);
  });

  it("passes the handler's arguments, result and rejection through unchanged", async () => {
    const { target, registered } = setup("running");
    const seen: unknown[] = [];
    target.handle("echo", (event, ...args) => {
      seen.push(event, ...args);
      return args[0];
    });
    target.handle("boom", () => {
      throw new Error("handler failed");
    });
    const ev = { sender: 1 };
    await expect(registered.get("echo")!(ev, "a", 2)).resolves.toBe("a");
    expect(seen).toEqual([ev, "a", 2]);
    await expect(registered.get("boom")!({})).rejects.toThrow("handler failed");
  });

  it("a throwing phase source never affects the reply", async () => {
    const { target, registered, state } = setup("running");
    Object.defineProperty(state, "phase", {
      get() {
        throw new Error("phase broke");
      },
    });
    target.handle("big", async () => bigReply());
    await expect(registered.get("big")!({})).resolves.toBeDefined();
  });

  it("wraps once even if installed twice", async () => {
    const registered = new Map<string, Listener>();
    const target: HandleTarget = { handle: (c, l) => void registered.set(c, l) };
    const lines: string[] = [];
    const deps = { phase: () => "running", now: () => 0, log: (l: string) => lines.push(l) };
    wrapHandleForReplySize(target, deps);
    wrapHandleForReplySize(target, deps);
    target.handle("big", async () => bigReply());
    await registered.get("big")!({});
    expect(lines).toHaveLength(1);
  });
});

describe("BACKLOG-3785: approxSerializedBytes", () => {
  it("counts strings, numbers, buffers, nested arrays/maps; counts a shared object once; stops at the cap", () => {
    expect(approxSerializedBytes("abcd")).toBe(4);
    expect(approxSerializedBytes(Buffer.alloc(1000))).toBe(1000);
    expect(approxSerializedBytes([1, 2])).toBe(1 + 16);
    expect(approxSerializedBytes(new Map([["k", "vv"]]))).toBe(3);
    const shared = { s: "x".repeat(100) };
    expect(approxSerializedBytes([shared, shared])).toBe(1 + 1 + 100);
    const cyclic: Record<string, unknown> = { a: "x" };
    cyclic.self = cyclic;
    expect(approxSerializedBytes(cyclic)).toBe(1 + 1 + 4);
    expect(approxSerializedBytes(Array.from({ length: 100 }, () => "x".repeat(100)), 500)).toBeLessThan(700);
  });
});

describe("BACKLOG-3785: install position", () => {
  it("main.ts imports the patch before any handler module (a handler registered earlier is not measured)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source: string = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "main.ts"), "utf8");
    const patch = source.indexOf('import "./bootstrap/installIpcReplySizeLog";');
    const firstHandler = source.search(/from "\.\/handlers/);
    expect(patch).toBeGreaterThan(-1);
    expect(firstHandler).toBeGreaterThan(-1);
    expect(patch).toBeLessThan(firstHandler);
    expect(source.indexOf("ipcMain.handle(")).toBeGreaterThan(patch);
  });
});
