/**
 * BACKLOG-3476 part C — the session store for the checklist plan answer.
 *
 * Wrong implementations this suite is here to catch (plan v2 §D, SR condition 9):
 *   C-1  serving an answer before main has given one.
 *   C-2  an answer surviving sign-out or a user switch; an org change not re-asked.
 *   C-3  an answer served past main's 5-minute TTL.
 *   C-4  no focus re-ask, or one on every focus.
 *   C-5  an open still waiting on the IPC when the session already knows.
 *   C-7  the background re-ask's answer dropped once an answer exists.
 *   C-8  an in-flight answer for user A stamped with user B's key at landing.
 * Every state recorded is every state a consumer RENDERED, so "never on any
 * frame" is a claim about frames, not about the final state.
 */
import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  STRICT_ANSWER_TTL_MS,
  StrictFeatureProvider,
  useSessionStrictFeatureState,
} from "../StrictFeatureContext";

type Answer = "allowed" | "blocked" | "unknown";

function deferred() {
  let resolve!: (v: Answer) => void;
  const promise = new Promise<Answer>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const strictState = () => window.api.featureGate.strictState as jest.Mock;

let frames: string[] = [];

/** A transaction open: one mount of the consumer. */
function Open() {
  const state = useSessionStrictFeatureState("transaction_checklists");
  frames.push(state);
  return state === "allowed" ? <div data-testid="tab-checklist" /> : <div data-testid="no-tab">{state}</div>;
}

function App({
  userId,
  organizationId = "org-1",
  open = true,
}: {
  userId: string | null;
  organizationId?: string | null;
  open?: boolean;
}) {
  return (
    <StrictFeatureProvider userId={userId} organizationId={organizationId}>
      {open && <Open />}
    </StrictFeatureProvider>
  );
}

const flush = () => act(async () => {});

beforeEach(() => {
  frames = [];
  strictState().mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("C-1 — nothing is shown before main answers", () => {
  it("blocked plan, invoke never resolves: no tab on any frame", async () => {
    strictState().mockReturnValue(new Promise(() => {}));
    render(<App userId="user-a" />);
    await flush();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f === "pending")).toBe(true);
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
  });

  it("signed out: pending and no question asked", async () => {
    render(<App userId={null} />);
    await flush();
    expect(strictState()).not.toHaveBeenCalled();
    expect(frames.every((f) => f === "pending")).toBe(true);
  });
});

describe("C-5 — an open does not wait when the session already knows", () => {
  it("pre-resolved allowed; a new open's re-ask never resolves; the tab is there on the open's FIRST render", async () => {
    strictState().mockResolvedValue("allowed");
    const { rerender } = render(<App userId="user-a" open={false} />);
    await flush();
    strictState().mockReturnValue(new Promise(() => {}));
    frames = [];
    rerender(<App userId="user-a" open />);
    expect(frames[0]).toBe("allowed");
    expect(screen.getByTestId("tab-checklist")).toBeInTheDocument();
    // The session's first question, then the open's background re-ask.
    expect(strictState()).toHaveBeenCalledTimes(2);
  });
});

describe("C-7 — the background re-ask is applied", () => {
  it("allowed, then an open's re-ask answers blocked: the tab goes, with no pending frame in between", async () => {
    strictState().mockResolvedValue("allowed");
    const { rerender } = render(<App userId="user-a" open={false} />);
    await flush();
    const reask = deferred();
    strictState().mockReturnValue(reask.promise);
    frames = [];
    rerender(<App userId="user-a" open />);
    expect(screen.getByTestId("tab-checklist")).toBeInTheDocument();
    await act(async () => reask.resolve("blocked"));
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
    expect(screen.getByTestId("no-tab")).toHaveTextContent("blocked");
    expect(frames).not.toContain("pending");
  });
});

describe("C-2 — no answer survives a user change; an org change re-asks", () => {
  it("allowed for A, switch to B with B's question in flight: no tab for B", async () => {
    strictState().mockResolvedValue("allowed");
    const { rerender } = render(<App userId="user-a" />);
    await flush();
    expect(screen.getByTestId("tab-checklist")).toBeInTheDocument();
    strictState().mockReturnValue(new Promise(() => {}));
    frames = [];
    rerender(<App userId="user-b" />);
    expect(frames[0]).toBe("pending");
    await flush();
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
  });

  it("sign-out: pending at once", async () => {
    strictState().mockResolvedValue("allowed");
    const { rerender } = render(<App userId="user-a" />);
    await flush();
    frames = [];
    rerender(<App userId={null} />);
    expect(frames[0]).toBe("pending");
  });

  it("org 1 → 2: one new question, and a blocked answer removes the tab", async () => {
    strictState().mockResolvedValue("allowed");
    const { rerender } = render(<App userId="user-a" organizationId="org-1" />);
    await flush();
    const before = strictState().mock.calls.length;
    strictState().mockResolvedValue("blocked");
    rerender(<App userId="user-a" organizationId="org-2" />);
    await flush();
    expect(strictState().mock.calls.length - before).toBe(1);
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
  });
});

describe("C-8 — an answer lands for the user it was asked FOR", () => {
  it("A's question in flight, switch to B, A's answer lands allowed: nothing for B", async () => {
    const forA = deferred();
    strictState().mockReturnValueOnce(forA.promise).mockReturnValue(new Promise(() => {}));
    const { rerender } = render(<App userId="user-a" open={false} />);
    rerender(<App userId="user-b" />);
    frames = [];
    await act(async () => forA.resolve("allowed"));
    expect(frames.every((f) => f === "pending")).toBe(true);
    expect(screen.queryByTestId("tab-checklist")).not.toBeInTheDocument();
  });
});

describe("C-3 — never older than main's TTL", () => {
  it("at TTL + 1 ms the answer reads pending and exactly one new question goes", async () => {
    jest.useFakeTimers();
    strictState().mockResolvedValue("allowed");
    render(<App userId="user-a" />);
    await flush();
    expect(screen.getByTestId("tab-checklist")).toBeInTheDocument();
    const before = strictState().mock.calls.length;
    strictState().mockReturnValue(new Promise(() => {}));
    await act(async () => {
      jest.advanceTimersByTime(STRICT_ANSWER_TTL_MS);
    });
    expect(strictState().mock.calls.length - before).toBe(0);
    expect(screen.getByTestId("tab-checklist")).toBeInTheDocument();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(strictState().mock.calls.length - before).toBe(1);
    expect(screen.getByTestId("no-tab")).toHaveTextContent("pending");
  });
});

describe("C-4 — focus re-asks at most once a minute", () => {
  it("focus within 60 s of the last question: none; after 61 s: one", async () => {
    jest.useFakeTimers();
    strictState().mockResolvedValue("allowed");
    render(<App userId="user-a" open={false} />);
    await flush();
    const before = strictState().mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(strictState().mock.calls.length - before).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(31_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(strictState().mock.calls.length - before).toBe(1);
  });
});

describe("outside a provider — the per-mount fallback", () => {
  it("pending, then one question per mount, then main's answer", async () => {
    strictState().mockResolvedValue("blocked");
    render(<Open />);
    expect(frames[0]).toBe("pending");
    await flush();
    expect(strictState()).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("no-tab")).toHaveTextContent("blocked");
  });
});
