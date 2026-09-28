/**
 * BACKLOG-3595 follow-up — `refresh`, the background re-read.
 *
 * Wrong implementations this suite catches:
 *   (a) refresh replaces a good checklist with the error when the read fails
 *       (the tab empties or hides, the rows remount, an unsaved note is lost)
 *   (b) refresh keeps whatever is stored, including `loading`: a refresh that
 *       overtakes the first load and then fails leaves the tab loading forever
 *   (c) the keep-last-good rule leaks into `reload`, so a write's own re-read
 *       stops reporting a failure
 *   (d) refresh goes through `loading`
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTransactionChecklist } from "../useTransactionChecklist";
import { fixtureChecklists } from "../../components/checklist/__tests__/checklistFixture";

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const FAILED = { success: false, error: "read failed" };

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue({ success: true, checklists: fixtureChecklists() });
});

describe("useTransactionChecklist.refresh (BACKLOG-3595)", () => {
  it("(a) a failed refresh keeps the checklist already shown", async () => {
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const shown = result.current.data;

    api().get.mockResolvedValueOnce(FAILED);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.state.status).toBe("ready");
    expect(result.current.data).toBe(shown);
  });

  it("(b) a refresh that overtakes the first load and fails shows the error, not loading", async () => {
    const first = deferred<unknown>();
    api().get.mockReturnValueOnce(first.promise).mockResolvedValueOnce(FAILED);
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    expect(result.current.state.status).toBe("loading");

    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      first.resolve({ success: true, checklists: fixtureChecklists() });
      await first.promise;
    });

    expect(result.current.state).toEqual({ status: "error", error: "read failed" });
  });

  it("(c) reload still reports a failed read (the keep rule is refresh-only)", async () => {
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    api().get.mockResolvedValueOnce(FAILED);
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.state).toEqual({ status: "error", error: "read failed" });
  });

  it("(d) a successful refresh never passes through loading", async () => {
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const next = deferred<unknown>();
    api().get.mockReturnValueOnce(next.promise);

    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refresh();
    });
    expect(result.current.state.status).toBe("ready");
    await act(async () => {
      next.resolve({ success: true, checklists: fixtureChecklists() });
      await pending;
    });
    expect(result.current.state.status).toBe("ready");
    expect(api().get).toHaveBeenCalledTimes(2);
  });
});

/**
 * BACKLOG-3599 — an older answer never overwrites a newer one; a kept failure
 * changes nothing.
 *
 * Wrong implementations these catch:
 *   newest-request-wins for successes too (the shipped bug)  -> P5a, P5b, S1
 *   a kept failure advances the applied answer               -> P5b
 *   failures never advance the applied answer                -> P4a, (b) above
 *   no store-time transaction guard, or a stale-closure one  -> T4
 *   `storedRef` mirrored from render, not written with each
 *   `setStored` (two answers landing in one batch)           -> S2
 */
describe("useTransactionChecklist — overlapping reads (BACKLOG-3599)", () => {
  /** A distinct checklist object per read, so `toBe` tells them apart. */
  const answer = () => ({ success: true, checklists: fixtureChecklists() });

  /** Ready on `txn-1`, then a note save whose re-read is held open. */
  async function saveWithHeldReRead() {
    const { result, rerender } = renderHook(({ id }) => useTransactionChecklist(id), {
      initialProps: { id: "txn-1" },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const preSave = result.current.data;
    const reRead = deferred<unknown>();
    const refreshRead = deferred<unknown>();
    api().get.mockReturnValueOnce(reRead.promise).mockReturnValueOnce(refreshRead.promise);

    let saving!: Promise<unknown>;
    act(() => {
      saving = result.current.setItemNote("item-1", "after save");
    });
    await waitFor(() => expect(api().get).toHaveBeenCalledTimes(2));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    expect(api().get).toHaveBeenCalledTimes(3);
    return { result, rerender, preSave, reRead, refreshRead, saving, refreshing };
  }

  it("P5a: the post-save re-read answers, then the overtaking refresh fails -> the saved checklist stays", async () => {
    const h = await saveWithHeldReRead();
    const saved = answer();

    await act(async () => {
      h.reRead.resolve(saved);
      await h.saving;
    });
    expect(h.result.current.data).toBe(saved.checklists);
    await act(async () => {
      h.refreshRead.resolve(FAILED);
      await h.refreshing;
    });

    expect(h.result.current.state.status).toBe("ready");
    expect(h.result.current.data).toBe(saved.checklists);
    expect(h.result.current.data).not.toBe(h.preSave);
  });

  it("P5b: the overtaking refresh fails first, then the post-save re-read answers -> the saved checklist shows", async () => {
    const h = await saveWithHeldReRead();
    const saved = answer();

    await act(async () => {
      h.refreshRead.resolve(FAILED);
      await h.refreshing;
    });
    expect(h.result.current.data).toBe(h.preSave);
    await act(async () => {
      h.reRead.resolve(saved);
      await h.saving;
    });

    expect(h.result.current.state.status).toBe("ready");
    expect(h.result.current.data).toBe(saved.checklists);
  });

  it("S1: P5a's order, both answers in one batch -> the saved checklist stays", async () => {
    const h = await saveWithHeldReRead();
    const saved = answer();

    await act(async () => {
      h.reRead.resolve(saved);
      h.refreshRead.resolve(FAILED);
      await Promise.all([h.saving, h.refreshing]);
    });

    expect(h.result.current.state.status).toBe("ready");
    expect(h.result.current.data).toBe(saved.checklists);
  });

  it("S2: the first load succeeds and the overtaking refresh fails in one batch -> the loaded checklist is kept", async () => {
    const first = deferred<unknown>();
    const refreshRead = deferred<unknown>();
    api().get.mockReturnValueOnce(first.promise).mockReturnValueOnce(refreshRead.promise);
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = result.current.refresh();
    });
    const loaded = answer();

    await act(async () => {
      first.resolve(loaded);
      refreshRead.resolve(FAILED);
      await refreshing;
    });

    expect(result.current.state.status).toBe("ready");
    expect(result.current.data).toBe(loaded.checklists);
  });

  it("T4: A's refresh lands after the switch, then B's first load and refresh fail -> B shows the error, never A", async () => {
    const { result, rerender } = renderHook(({ id }) => useTransactionChecklist(id), {
      initialProps: { id: "txn-A" },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const aRefresh = deferred<unknown>();
    const bFirst = deferred<unknown>();
    const bRefresh = deferred<unknown>();
    api().get
      .mockReturnValueOnce(aRefresh.promise)
      .mockReturnValueOnce(bFirst.promise)
      .mockReturnValueOnce(bRefresh.promise);
    let aRefreshing!: Promise<void>;
    act(() => {
      aRefreshing = result.current.refresh();
    });
    rerender({ id: "txn-B" });
    let bRefreshing!: Promise<void>;
    act(() => {
      bRefreshing = result.current.refresh();
    });
    expect(api().get.mock.calls.map((c) => (c[0] as { transactionId: string }).transactionId)).toEqual([
      "txn-A",
      "txn-A",
      "txn-B",
      "txn-B",
    ]);

    const aLate = answer();
    await act(async () => {
      aRefresh.resolve(aLate);
      await aRefreshing;
    });
    expect(result.current.data).not.toBe(aLate.checklists);
    await act(async () => {
      bFirst.resolve(FAILED);
      bRefresh.resolve(FAILED);
      await bRefreshing;
    });

    expect(result.current.state).toEqual({ status: "error", error: "read failed" });
  });

  it("P4a (SR scenario): A ready, switch to B, B's refresh fails before B's first load -> B shows the error, never A", async () => {
    const { result, rerender } = renderHook(({ id }) => useTransactionChecklist(id), {
      initialProps: { id: "txn-A" },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const aShown = result.current.data;
    const bFirst = deferred<unknown>();
    api().get.mockReturnValueOnce(bFirst.promise).mockResolvedValueOnce(FAILED);

    rerender({ id: "txn-B" });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.state).toEqual({ status: "error", error: "read failed" });
    await act(async () => {
      bFirst.resolve(answer());
      await bFirst.promise;
    });

    expect(result.current.state).toEqual({ status: "error", error: "read failed" });
    expect(result.current.data).not.toBe(aShown);
  });
});
