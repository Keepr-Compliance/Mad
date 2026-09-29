/**
 * BACKLOG-3476 — useTransactionChecklist (SR condition 6).
 *
 * Wrong implementations this suite is here to catch:
 *   (a) `reload` driven by an effect on a write counter — fires twice under
 *       StrictMode, or not at all when the counter is batched.
 *   (b) no transaction guard — A's late answer renders on B, and B's next tick
 *       writes one of A's item ids.
 *   (c) no pending guard — a double-click sends two writes computed from the
 *       same stale `isChecked`.
 *   (d) an add sends a checklist id, or a remove names the wrong one (SVC1,
 *       BACKLOG-3476 several checklists; round 2: Change is gone, so add is
 *       the only write besides remove that touches which checklists exist).
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTransactionChecklist } from "../useTransactionChecklist";
import {
  envelopeOf,
  fixtureChecklists,
  fixtureDetail,
} from "../../components/checklist/__tests__/checklistFixture";
import type { ChecklistDetail, ChecklistsForTransaction } from "../../../../../electron/types/checklist";

const envelopeFor = (detail: ChecklistDetail): ChecklistsForTransaction => envelopeOf([detail]);
const firstName = (data: ChecklistsForTransaction | null) => data?.checklists[0]?.checklist.templateName;
const firstTx = (data: ChecklistsForTransaction | null) => data?.checklists[0]?.checklist.transactionId;

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const strict = ({ children }: { children: React.ReactNode }) => (
  <React.StrictMode>{children}</React.StrictMode>
);

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue({ success: true, checklists: fixtureChecklists() });
  api().setItemChecked.mockResolvedValue({ success: true, changed: true });
  api().selectTemplate.mockResolvedValue({ success: true, result: { status: "added", checklistId: "c" } });
});

describe("useTransactionChecklist (BACKLOG-3476)", () => {
  it("(a) one completed write is followed by exactly one get, under StrictMode", async () => {
    const { result } = renderHook(() => useTransactionChecklist("txn-1"), { wrapper: strict });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const before = api().get.mock.calls.length;

    await act(async () => {
      await result.current.setItemChecked(fixtureDetail().items[1].id, true);
    });

    expect(api().setItemChecked).toHaveBeenCalledTimes(1);
    expect(api().get.mock.calls.length - before).toBe(1);
  });

  it("(b) a late answer for transaction A never renders on B", async () => {
    const detailA = fixtureDetail();
    const detailB: ChecklistDetail = {
      ...fixtureDetail(),
      checklist: { ...fixtureDetail().checklist, transactionId: "txn-B", templateName: "Template B" },
    };
    const a = deferred<unknown>();
    api().get.mockImplementation(({ transactionId }: { transactionId: string }) =>
      transactionId === "txn-A" ? a.promise : Promise.resolve({ success: true, checklists: envelopeFor(detailB) }),
    );

    const { result, rerender } = renderHook(({ id }) => useTransactionChecklist(id), {
      initialProps: { id: "txn-A" },
    });
    rerender({ id: "txn-B" });
    await waitFor(() => expect(firstName(result.current.data)).toBe("Template B"));

    await act(async () => {
      a.resolve({ success: true, checklists: envelopeFor(detailA) });
      await a.promise;
    });
    expect(firstName(result.current.data)).toBe("Template B");
  });

  it("(b) while B's answer is outstanding, A's stored answer is not shown", async () => {
    const b = deferred<unknown>();
    api().get.mockImplementation(({ transactionId }: { transactionId: string }) =>
      transactionId === "txn-B" ? b.promise : Promise.resolve({ success: true, checklists: fixtureChecklists() }),
    );
    const { result, rerender } = renderHook(({ id }) => useTransactionChecklist(id), {
      initialProps: { id: "txn-A" },
    });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender({ id: "txn-B" });
    expect(result.current.state.status).toBe("loading");
    expect(result.current.data).toBeNull();
  });

  it("(b) no render ever pairs transaction B with A's checklist", async () => {
    const detailFor = (id: string): ChecklistDetail => ({
      ...fixtureDetail(),
      checklist: { ...fixtureDetail().checklist, transactionId: id },
    });
    api().get.mockImplementation(({ transactionId }: { transactionId: string }) =>
      Promise.resolve({ success: true, checklists: envelopeFor(detailFor(transactionId)) }),
    );
    const seen: Array<[string, string | undefined]> = [];
    const { result, rerender } = renderHook(({ id }) => {
      const r = useTransactionChecklist(id);
      seen.push([id, firstTx(r.data)]);
      return r;
    }, { initialProps: { id: "txn-A" } });
    await waitFor(() => expect(firstTx(result.current.data)).toBe("txn-A"));

    rerender({ id: "txn-B" });
    await waitFor(() => expect(firstTx(result.current.data)).toBe("txn-B"));

    const mismatched = seen.filter(([id, shown]) => shown !== undefined && shown !== id);
    expect(mismatched).toEqual([]);
  });

  it("(c) a second click on a pending checkbox makes no second write", async () => {
    const write = deferred<unknown>();
    api().setItemChecked.mockReturnValue(write.promise);
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const itemId = fixtureDetail().items[1].id;

    let first!: Promise<unknown>;
    let second: unknown;
    await act(async () => {
      first = result.current.setItemChecked(itemId, true);
      second = await result.current.setItemChecked(itemId, true);
    });
    expect(second).toBeNull();
    expect(result.current.pendingItemIds.has(itemId)).toBe(true);
    expect(api().setItemChecked).toHaveBeenCalledTimes(1);

    await act(async () => {
      write.resolve({ success: true, changed: true });
      await first;
    });
    expect(result.current.pendingItemIds.has(itemId)).toBe(false);
  });

  it("(d) addChecklist sends no checklist id; remove sends exactly the one it was given", async () => {
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    await act(async () => { await result.current.addChecklist("tpl-fresh"); });
    expect(api().selectTemplate.mock.calls[0]).toEqual([{ transactionId: "txn-1", templateId: "tpl-fresh" }]);
    expect(Object.keys(api().selectTemplate.mock.calls[0][0]).sort()).toEqual([
      "templateId",
      "transactionId",
    ]);

    api().remove.mockResolvedValue({ success: true, changed: true });
    await act(async () => { await result.current.removeChecklist("id-2"); });
    expect(api().remove.mock.calls[0]).toEqual([{ transactionId: "txn-1", checklistId: "id-2" }]);
  });

  it("the envelope arrives whole: every checklist and main's sums", async () => {
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.data).toEqual(fixtureChecklists());
    expect(result.current.data?.checklists).toHaveLength(3);
  });

  it("a failed get is an error state, never 'no checklist'", async () => {
    api().get.mockResolvedValue({ success: false, error: "Could not read." });
    const { result } = renderHook(() => useTransactionChecklist("txn-1"));
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(result.current.data).toBeNull();
  });
});
