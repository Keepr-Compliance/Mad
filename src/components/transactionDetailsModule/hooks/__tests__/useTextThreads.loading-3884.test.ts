/**
 * BACKLOG-3884: the Texts tab could stay on "Loading messages..." forever. Opening the
 * tab runs a loud load(); a silent refresh() that starts while it is in flight
 * supersedes it. The loud call skipped clearing `loading` (superseded) and the silent
 * call never cleared it (silent), so `loading` stayed true.
 */
import { renderHook, act } from "@testing-library/react";
import { useTextThreads } from "../useTextThreads";
import { textThreadSummary } from "../../../__tests__/helpers/textThreadSummary3884";

const older = textThreadSummary({ threadId: "thr-old", phone: "+12065550101", lastSentAt: "2026-02-01T10:00:00.000Z" });
const newer = textThreadSummary({ threadId: "thr-new", phone: "+12065550102", lastSentAt: "2026-02-02T10:00:00.000Z" });
const get = () => window.api.transactions.getTextThreads as jest.Mock;

type Reply = { success: boolean; threads?: unknown[]; error?: string };
interface Deferred {
  resolve: (v: Reply) => void;
  reject: (e: unknown) => void;
}

/** Each getTextThreads call returns a promise the test settles by hand, in call order. */
function deferCalls(): Deferred[] {
  const calls: Deferred[] = [];
  get().mockImplementation(
    () =>
      new Promise<Reply>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return calls;
}

function setup() {
  return renderHook(() => useTextThreads("txn-1", "2026-01-01", "2026-06-30"));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useTextThreads loading flag (BACKLOG-3884)", () => {
  it("load, then refresh; load settles first, then refresh -> loading false, threads from refresh", async () => {
    const calls = deferCalls();
    const { result } = setup();
    let pLoad!: Promise<void>;
    let pRefresh!: Promise<void>;
    act(() => {
      pLoad = result.current.load();
    });
    expect(result.current.loading).toBe(true);
    act(() => {
      pRefresh = result.current.refresh();
    });
    expect(calls).toHaveLength(2);
    await act(async () => {
      calls[0].resolve({ success: true, threads: [older] });
      await pLoad;
    });
    await act(async () => {
      calls[1].resolve({ success: true, threads: [newer] });
      await pRefresh;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.threads?.map((t) => t.threadId)).toEqual(["thr-new"]);
    expect(result.current.error).toBeNull();
  });

  it("load, then refresh; refresh settles first, then load -> loading false, threads from refresh", async () => {
    const calls = deferCalls();
    const { result } = setup();
    let pLoad!: Promise<void>;
    let pRefresh!: Promise<void>;
    act(() => {
      pLoad = result.current.load();
    });
    act(() => {
      pRefresh = result.current.refresh();
    });
    await act(async () => {
      calls[1].resolve({ success: true, threads: [newer] });
      await pRefresh;
    });
    expect(result.current.loading).toBe(false);
    await act(async () => {
      calls[0].resolve({ success: true, threads: [older] });
      await pLoad;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.threads?.map((t) => t.threadId)).toEqual(["thr-new"]);
  });

  it("load rejects after being superseded by refresh -> loading false, threads from refresh, no error", async () => {
    const calls = deferCalls();
    const { result } = setup();
    let pLoad!: Promise<void>;
    let pRefresh!: Promise<void>;
    act(() => {
      pLoad = result.current.load();
    });
    act(() => {
      pRefresh = result.current.refresh();
    });
    await act(async () => {
      calls[0].reject(new Error("ipc failed"));
      await pLoad;
    });
    await act(async () => {
      calls[1].resolve({ success: true, threads: [newer] });
      await pRefresh;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.threads?.map((t) => t.threadId)).toEqual(["thr-new"]);
    expect(result.current.error).toBeNull();
  });

  it("the superseding refresh rejects -> loading false and the error is shown", async () => {
    const calls = deferCalls();
    const { result } = setup();
    let pLoad!: Promise<void>;
    let pRefresh!: Promise<void>;
    act(() => {
      pLoad = result.current.load();
    });
    act(() => {
      pRefresh = result.current.refresh();
    });
    await act(async () => {
      calls[0].resolve({ success: true, threads: [older] });
      await pLoad;
    });
    await act(async () => {
      calls[1].reject(new Error("ipc failed"));
      await pRefresh;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("Failed to load messages");
  });

  it("a superseded load does not clear the spinner while a newer load is still in flight", async () => {
    const calls = deferCalls();
    const { result } = setup();
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.load();
    });
    act(() => {
      p2 = result.current.load();
    });
    await act(async () => {
      calls[0].resolve({ success: true, threads: [older] });
      await p1;
    });
    expect(result.current.loading).toBe(true);
    await act(async () => {
      calls[1].resolve({ success: true, threads: [newer] });
      await p2;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.threads?.map((t) => t.threadId)).toEqual(["thr-new"]);
  });

  it("a silent refresh alone never turns the spinner on", async () => {
    const calls = deferCalls();
    const { result } = setup();
    let p!: Promise<void>;
    act(() => {
      p = result.current.refresh();
    });
    expect(result.current.loading).toBe(false);
    await act(async () => {
      calls[0].resolve({ success: true, threads: [newer] });
      await p;
    });
    expect(result.current.loading).toBe(false);
  });
});
