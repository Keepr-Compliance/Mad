/**
 * BACKLOG-4174 FIX A4 — the account panel's rows from the session store.
 *
 * Wrong implementations this suite is here to catch (plan "FIX A4", SR plan
 * review):
 *   C1   per-mount reads kept (a reopen waits on the IPC again), or the old
 *        per-mount plan read kept alongside the store (two get-alls a reopen).
 *   C2*  rows shown before BOTH reads have answered (C2p: plan pending,
 *        C2s: strict pending), or `{}` from get-all read as "not answered".
 *   C3   a failure granting Learn; a failed plan read hiding AI (fail-open).
 *   C4   a "pending" placeholder stored while a question is in flight.
 *   C5   one user's plan answer shown for the next; sign-out still showing.
 *   C6   an org change resetting the answer to pending instead of re-asking.
 *   R1   a checklist consumer re-asking the plan or the Learn read.
 * Every list recorded is a list a consumer RENDERED, so "never on any frame"
 * is a claim about frames, not about the final state.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { StrictFeatureProvider, useSessionStrictFeatureState } from "../StrictFeatureContext";
import { useVisibleSettingsTabs } from "../../components/settings/useVisibleSettingsTabs";

const strictState = () => window.api.featureGate.strictState as jest.Mock;
const getAll = () => window.api.featureGate.getAll as jest.Mock;
const never = () => new Promise<never>(() => {});
let frames: string[][] = [];

function Panel() {
  const { tabs } = useVisibleSettingsTabs();
  const ids = tabs ? tabs.map((t) => t.id) : [];
  frames.push(ids);
  return (
    <ul data-testid="rows">
      {ids.map((i) => (
        <li key={i} data-testid={i} />
      ))}
    </ul>
  );
}
function Checklist() {
  useSessionStrictFeatureState("transaction_checklists");
  return null;
}
function App({
  userId,
  open,
  tx = false,
  organizationId = "org-1",
}: {
  userId: string | null;
  open: boolean;
  tx?: boolean;
  organizationId?: string;
}) {
  return (
    <StrictFeatureProvider userId={userId} organizationId={organizationId}>
      {open && <Panel />}
      {tx && <Checklist />}
    </StrictFeatureProvider>
  );
}
const flush = () => act(async () => {});
const byKey = (impl: Record<string, () => Promise<unknown>>) =>
  strictState().mockImplementation((k: string) => (impl[k] ?? never)());
const learnCalls = () => strictState().mock.calls.filter((c) => c[0] === "autodetect_eval").length;
const NO_AI = { ai_detection: { allowed: false, value: "", source: "plan" } };

beforeEach(() => {
  frames = [];
  strictState().mockReset();
  getAll().mockReset();
});

it("C1 — reopen is synchronous: rows on the first frame while every re-ask hangs; one background read of each", async () => {
  byKey({ autodetect_eval: async () => "allowed", transaction_checklists: async () => "allowed" });
  getAll().mockResolvedValue(NO_AI);
  const { rerender } = render(<App userId="u-a" open={false} />);
  await flush();
  strictState().mockImplementation(never);
  getAll().mockImplementation(never);
  const g = getAll().mock.calls.length;
  const l = learnCalls();
  frames = [];
  rerender(<App userId="u-a" open />);
  expect(frames[0]).toContain("settings-learn");
  expect(frames[0]).not.toContain("settings-ai");
  expect(frames[0]).toContain("settings-about");
  await flush();
  // While the background re-asks are in flight the rows never blank (C4).
  expect(frames.every((f) => f.includes("settings-learn"))).toBe(true);
  expect(getAll().mock.calls.length - g).toBe(1);
  expect(learnCalls() - l).toBe(1);
});

it("C2 — first open before any answer holds (no rows), then shows once both land", async () => {
  let resolvePlan!: (v: unknown) => void;
  let resolveLearn!: (v: unknown) => void;
  getAll().mockReturnValue(new Promise((r) => (resolvePlan = r)));
  byKey({ autodetect_eval: () => new Promise((r) => (resolveLearn = r)) });
  render(<App userId="u-a" open />);
  await flush();
  expect(frames.every((f) => f.length === 0)).toBe(true);
  await act(async () => resolvePlan(NO_AI));
  expect(frames.every((f) => f.length === 0)).toBe(true);
  await act(async () => resolveLearn("allowed"));
  expect(screen.getByTestId("settings-learn")).toBeInTheDocument();
  expect(screen.queryByTestId("settings-ai")).not.toBeInTheDocument();
  // Never a list with AI in it that is later removed.
  expect(frames.some((f) => f.includes("settings-ai"))).toBe(false);
});

it("C2p — strict answered, plan read hangs: still no rows", async () => {
  byKey({ autodetect_eval: async () => "allowed" });
  getAll().mockImplementation(never);
  render(<App userId="u-a" open />);
  await flush();
  expect(frames.every((f) => f.length === 0)).toBe(true);
});

it("C2s — plan answered, strict read hangs: still no rows", async () => {
  strictState().mockImplementation(never);
  getAll().mockResolvedValue({});
  render(<App userId="u-a" open />);
  await flush();
  expect(frames.every((f) => f.length === 0)).toBe(true);
});

it("C2b — {} from get-all is a settled answer: AI shown, Learn absent on blocked", async () => {
  byKey({ autodetect_eval: async () => "blocked" });
  getAll().mockResolvedValue({});
  render(<App userId="u-a" open />);
  await flush();
  expect(screen.getByTestId("settings-ai")).toBeInTheDocument();
  expect(screen.getByTestId("settings-about")).toBeInTheDocument();
  expect(screen.queryByTestId("settings-learn")).not.toBeInTheDocument();
});

it("C3 — failures never grant Learn; a failed plan read is settled with AI fail-open", async () => {
  strictState().mockRejectedValue(new Error("x"));
  getAll().mockRejectedValue(new Error("x"));
  render(<App userId="u-a" open />);
  await flush();
  expect(screen.getByTestId("settings-ai")).toBeInTheDocument();
  expect(screen.queryByTestId("settings-learn")).not.toBeInTheDocument();
});

it("C3u — an 'unknown' Learn answer does not show Learn", async () => {
  byKey({ autodetect_eval: async () => "unknown" });
  getAll().mockResolvedValue({});
  render(<App userId="u-a" open />);
  await flush();
  expect(screen.getByTestId("settings-about")).toBeInTheDocument();
  expect(screen.queryByTestId("settings-learn")).not.toBeInTheDocument();
});

it("C5 — user switch: A's plan answer is never shown for B (plan slot)", async () => {
  byKey({ autodetect_eval: async () => "allowed" });
  getAll().mockResolvedValue(NO_AI);
  const { rerender } = render(<App userId="u-a" open={false} />);
  await flush();
  // B: strict answers at once, plan read hangs.
  getAll().mockImplementation(never);
  frames = [];
  rerender(<App userId="u-b" open />);
  await flush();
  expect(frames.every((f) => f.length === 0)).toBe(true);
});

it("C5b — sign-out reads pending (no rows)", async () => {
  byKey({ autodetect_eval: async () => "allowed" });
  getAll().mockResolvedValue({});
  const { rerender } = render(<App userId="u-a" open />);
  await flush();
  frames = [];
  rerender(<App userId={null} open />);
  expect(frames[0]).toEqual([]);
});

it("C6 — an org change keeps the stored rows while it re-asks", async () => {
  byKey({ autodetect_eval: async () => "allowed" });
  getAll().mockResolvedValue(NO_AI);
  const { rerender } = render(<App userId="u-a" open />);
  await flush();
  strictState().mockImplementation(never);
  getAll().mockImplementation(never);
  const g = getAll().mock.calls.length;
  frames = [];
  rerender(<App userId="u-a" open organizationId="org-2" />);
  await flush();
  expect(getAll().mock.calls.length - g).toBe(1);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((f) => f.includes("settings-learn"))).toBe(true);
});

it("R1 — a checklist consumer mount re-asks only its own key (no get-all, no autodetect)", async () => {
  byKey({ autodetect_eval: async () => "allowed", transaction_checklists: async () => "allowed" });
  getAll().mockResolvedValue({});
  const { rerender } = render(<App userId="u-a" open={false} />);
  await flush();
  const g = getAll().mock.calls.length;
  const l = learnCalls();
  const c = strictState().mock.calls.filter((x) => x[0] === "transaction_checklists").length;
  rerender(<App userId="u-a" open={false} tx />);
  await flush();
  expect(getAll().mock.calls.length).toBe(g);
  expect(learnCalls()).toBe(l);
  expect(strictState().mock.calls.filter((x) => x[0] === "transaction_checklists").length - c).toBe(1);
});
