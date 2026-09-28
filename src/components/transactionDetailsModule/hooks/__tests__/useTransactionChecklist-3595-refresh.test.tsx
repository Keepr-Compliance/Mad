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
