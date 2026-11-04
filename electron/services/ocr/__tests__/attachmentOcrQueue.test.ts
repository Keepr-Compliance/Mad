/**
 * @jest-environment node
 *
 * BACKLOG-3943 — the OCR queue: FIFO, one job at a time, bounded (R7), stopped on quit
 * (R7), post-sync drain bounded and skipped on battery (founder ruling 3).
 * Every dependency is injected; nothing is spawned and no database is opened.
 */
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import logService from "../../logService";
import { AttachmentOcrQueue, enqueueAttachmentOcr, requestOcrDrainAfterSync, type OcrQueueDeps } from "../attachmentOcrQueue";
import type { OcrRunOptions } from "../attachmentOcrService";

function makeQueue(over: Partial<OcrQueueDeps> = {}) {
  const ran: string[] = [];
  let active = 0;
  let maxActive = 0;
  const gates = new Map<string, () => void>();
  const seenOptions: OcrRunOptions[] = [];
  const deps: OcrQueueDeps = {
    run: async (id, options) => {
      seenOptions.push(options);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gates.set(id, resolve));
      active--;
      ran.push(id);
      return "text";
    },
    isSupported: () => true,
    isOnBatteryPower: () => false,
    selectPendingIds: jest.fn((limit: number) => Array.from({ length: limit }, (_, i) => `db-${i}`)),
    stopChild: jest.fn(),
    cap: 200,
    drainBatch: 25,
    ...over,
  };
  const queue = new AttachmentOcrQueue(deps);
  const release = async (id: string) => {
    for (let i = 0; i < 50 && !gates.has(id); i++) await new Promise((r) => setImmediate(r));
    gates.get(id)?.();
    gates.delete(id);
    await new Promise((r) => setImmediate(r));
  };
  return { queue, deps, ran, release, seenOptions, maxActive: () => maxActive };
}

describe("lifecycle", () => {
  it("the shared queue is not started in tests: enqueue and drain are no-ops", () => {
    expect(enqueueAttachmentOcr("x")).toBe("not-started");
    expect(requestOcrDrainAfterSync()).toEqual({ queued: 0, skipped: "not-started" });
  });

  it("an unsupported platform queues nothing", () => {
    const { queue } = makeQueue({ isSupported: () => false });
    queue.start();
    expect(queue.enqueue("a")).toBe("unsupported");
    expect(queue.requestDrainAfterSync()).toEqual({ queued: 0, skipped: "unsupported" });
  });
});

describe("FIFO, one job at a time, duplicates dropped", () => {
  it("runs in order with at most one job active", async () => {
    const t = makeQueue();
    t.queue.start();
    expect(t.queue.enqueue("a")).toBe("queued");
    expect(t.queue.enqueue("b")).toBe("queued");
    expect(t.queue.enqueue("a")).toBe("duplicate");
    expect(t.queue.enqueue("c")).toBe("queued");
    await t.release("a");
    await t.release("b");
    await t.release("c");
    await t.queue.whenIdle();
    expect(t.ran).toEqual(["a", "b", "c"]);
    expect(t.maxActive()).toBe(1);
  });
});

describe("R7 — bounded queue", () => {
  it("cap + 1 ids: cap queued (one may be running), overflow counted and logged", () => {
    const t = makeQueue({ cap: 3 });
    t.queue.start();
    const results = ["a", "b", "c", "d", "e"].map((id) => t.queue.enqueue(id));
    // "a" leaves `pending` the moment the worker starts it, so pending holds b, c, d.
    expect(results).toEqual(["queued", "queued", "queued", "queued", "overflow"]);
    expect(t.queue.size).toBe(3);
    expect(t.queue.overflowed).toBe(1);
    expect(logService.info).toHaveBeenCalledWith(
      expect.stringContaining("OCR queue full"),
      "AttachmentOcr",
      expect.objectContaining({ cap: 3, overflowed: 1 }),
    );
  });
});

describe("R7 — stop on quit", () => {
  it("clears the queue, stops the live child, tells the running job it is stopped", async () => {
    const t = makeQueue();
    t.queue.start();
    t.queue.enqueue("a");
    t.queue.enqueue("b");
    await new Promise((r) => setImmediate(r));
    expect(t.seenOptions[0].isStopped?.()).toBe(false);
    t.queue.stop();
    expect(t.deps.stopChild).toHaveBeenCalledTimes(1);
    expect(t.seenOptions[0].isStopped?.()).toBe(true);
    expect(t.queue.size).toBe(0);
    expect(t.queue.enqueue("c")).toBe("stopped");
    await t.release("a");
    await t.queue.whenIdle();
    expect(t.ran).toEqual(["a"]); // "b" never ran
  });
});

describe("post-sync drain (founder ruling 3)", () => {
  it("queues up to drainBatch pending ids", async () => {
    const t = makeQueue();
    t.queue.start();
    expect(t.queue.requestDrainAfterSync()).toEqual({ queued: 25 });
    expect(t.deps.selectPendingIds).toHaveBeenCalledWith(25);
  });

  it("skipped on battery power, without reading the database", () => {
    const t = makeQueue({ isOnBatteryPower: () => true });
    t.queue.start();
    expect(t.queue.requestDrainAfterSync()).toEqual({ queued: 0, skipped: "battery" });
    expect(t.deps.selectPendingIds).not.toHaveBeenCalled();
  });

  it("a no-op while the queue is busy (a deal sync runs several windows)", () => {
    const t = makeQueue();
    t.queue.start();
    t.queue.enqueue("live");
    expect(t.queue.requestDrainAfterSync()).toEqual({ queued: 0, skipped: "busy" });
    expect(t.deps.selectPendingIds).not.toHaveBeenCalled();
  });

  it("a failing pending query is reported, not thrown", () => {
    const t = makeQueue({
      selectPendingIds: () => {
        throw new Error("db closed");
      },
    });
    t.queue.start();
    expect(t.queue.requestDrainAfterSync()).toEqual({ queued: 0, skipped: "error" });
  });

  it("start() takes the battery check from main.ts", () => {
    const t = makeQueue();
    t.queue.start({ isOnBatteryPower: () => true });
    expect(t.queue.requestDrainAfterSync()).toEqual({ queued: 0, skipped: "battery" });
  });
});
