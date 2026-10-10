/**
 * BACKLOG-3884 follow-up — the remaining open-path reads log a [TxnOpen] line
 * with ms and counts only: the checklist read, the review-state read, the
 * open-time review sync, the email-name map and contacts:get-all.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import logger from "../../../../utils/logger";
import { useTransactionChecklist } from "../useTransactionChecklist";
import { useReviewQueue } from "../useReviewQueue";
import { useTransactionDetails } from "../useTransactionDetails";
import { useContactNameMap } from "../../../../hooks/useContactNameMap";
import { envelopeOf, fixtureDetail } from "../../components/checklist/__tests__/checklistFixture";
import type { Transaction } from "@/types";

let info: jest.SpyInstance;
const lines = () => info.mock.calls.map(([l]) => String(l));
const txnLines = (label: string) => lines().filter((l) => l.startsWith(`[TxnOpen] ${label} `));

beforeEach(() => {
  info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
});
afterEach(() => info.mockRestore());

function expectNoSecrets() {
  const all = lines().join("\n");
  expect(all).not.toContain("secret");
}

describe("[TxnOpen] checklist read", () => {
  it("logs once for the first read of a transaction, with ms and checklist count", async () => {
    const api = window.api.checklists as unknown as Record<string, jest.Mock>;
    api.get.mockResolvedValue({ success: true, checklists: envelopeOf([fixtureDetail()]) });
    const { result } = renderHook(() => useTransactionChecklist("txn-secret-1"));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => {
      await result.current.reload();
    });
    expect(api.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(txnLines("checklist read")).toHaveLength(1);
    expect(txnLines("checklist read")[0]).toMatch(/^\[TxnOpen\] checklist read ms=\d+ ok=1 checklists=1$/);
    expectNoSecrets();
  });
});

describe("[TxnOpen] review state read and review sync", () => {
  it("logs the first review-state read and every sync, ms and counts only", async () => {
    const api = window.api.transactions as unknown as Record<string, jest.Mock>;
    api.getReviewState = jest.fn().mockResolvedValue({
      items: [{ id: "item-secret-1" }, { id: "item-secret-2" }],
      count: 2,
    });
    api.syncReviewQueue = jest.fn().mockResolvedValue({ added: 3, linked: 4 });
    const { result } = renderHook(() => useReviewQueue("txn-secret-2"));
    await act(async () => {
      await result.current.runSync("open");
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(api.getReviewState).toHaveBeenCalledTimes(2);
    expect(txnLines("review state read")).toEqual([
      expect.stringMatching(/^\[TxnOpen\] review state read ms=\d+ count=2 items=2$/),
    ]);
    expect(txnLines("review sync")).toEqual([
      expect.stringMatching(/^\[TxnOpen\] review sync ms=\d+ reason=open added=3 linked=4$/),
    ]);
    expectNoSecrets();
  });
});

describe("[TxnOpen] email-name map", () => {
  it("logs the real fetch with an entry count and no addresses or names", async () => {
    const api = window.api.contacts as unknown as Record<string, jest.Mock>;
    api.getEmailNameMap = jest.fn().mockResolvedValue({
      success: true,
      nameMap: { "secret1@example.com": "secret-alpha", "secret2@example.com": "secret-beta" },
    });
    const { result } = renderHook(() => useContactNameMap("user-namemap-3884"));
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(txnLines("email-name map")).toEqual([
      expect.stringMatching(/^\[TxnOpen\] email-name map ms=\d+ entries=2$/),
    ]);
    expect(lines().join("\n")).not.toMatch(/example\.com|secret/);
  });
});

describe("[TxnOpen] contacts get-all", () => {
  it("logs ms and counts when the deal has suggested contacts", async () => {
    const tapi = window.api.transactions as unknown as Record<string, jest.Mock>;
    tapi.getOverview = jest.fn().mockResolvedValue({ success: true, transaction: { contact_assignments: [] } });
    const capi = window.api.contacts as unknown as Record<string, jest.Mock>;
    capi.getAll = jest.fn().mockResolvedValue({
      success: true,
      contacts: [
        { id: "c-secret-1", display_name: "Secret A" },
        { id: "c-secret-2", display_name: "Secret B" },
        { id: "c-secret-3", display_name: "Secret C" },
      ],
    });
    const tx = {
      id: "txn-secret-3",
      user_id: "user-secret",
      suggested_contacts: JSON.stringify([{ role: "buyer", contact_id: "c-secret-1" }]),
    } as unknown as Transaction;
    renderHook(() => useTransactionDetails(tx));
    await waitFor(() => expect(txnLines("contacts get-all")).toHaveLength(1));
    expect(txnLines("contacts get-all")[0]).toMatch(
      /^\[TxnOpen\] contacts get-all ms=\d+ contacts=3 suggested=1$/,
    );
    expectNoSecrets();
  });
});
