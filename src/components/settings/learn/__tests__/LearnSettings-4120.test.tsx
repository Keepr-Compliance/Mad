/**
 * BACKLOG-4120 PR3 — the "Help Keepr learn" screens (boards L1-L4).
 *
 *   OFF   toggle OFF: nothing below the switch, and no run / sample / score
 *   ON    toggle ON with no run in main: run 12 months, then Questions ready
 *   AT    the one attachment is opened when ITS question is shown: never at
 *         Start, never for a sibling, never for a mail question, no prefetch
 *   IMG   remote images blocked until "Show images", per email
 *   SK/UN skip (deal: session exclude list; mail: stored "skip"), undo
 *   SC    score dialog: tiles, "minimum", recall without legacy, skipped
 *         counts, Copy block = main's aggregates
 *   P6    the canary address / subject reach no aria-label, title or data-*
 *         attribute and no console call
 *   DEL   Data & Privacy row: shown with saved answers, deletes through main
 *   2.46.2 (sittings of 12, Done for now, Your answers):
 *   C1    the cap is on the SESSION: 30 items, 12 previews, then the score
 *   C2    the card shows one sitting (12, about 5 minutes)
 *   C3    "N more" only when another question exists; keeps skipped deals
 *   C4    Done for now keeps an in-flight answer and asks nothing after it
 *   C8    deleting one answer re-reads the score and the count
 *
 * window.api.learn is a fake "main" built from the transcribed replies in
 * learnFixtures-4120.ts. Synthetic data only.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PlatformProvider } from "@/contexts/PlatformContext";
import { LearnSettings } from "../LearnSettings";
import { LearnScoreHost, LearnSessionHost } from "../LearnSessionHost";
import { LearnAnswersPrivacyRow } from "../LearnAnswersPrivacyRow";
import { LearnEmailPane } from "../LearnEmailPane";
import type { LearnPreviewResult, LearnScoreResult, LearnStateResult } from "../../../../../electron/types/ipc/window-api-learn";
import {
  CLEANUP_NEXT,
  CLEANUP_NEXT_2,
  PREVIEW_BULK,
  PREVIEW_BULK_2,
  PREVIEW_CLEANUP,
  PREVIEW_CLEANUP_2,
  LIST_ANSWERS,
  SAMPLE_ROW_ID,
  SCORE,
  STATE_ON,
} from "./learnFixtures-4120";

type Cleanup = { detectionId: string; question: unknown; preview: LearnPreviewResult };
type Bulk = { rowId: string; preview: LearnPreviewResult };

interface FakeMain {
  state: LearnStateResult;
  hasRun: boolean;
  cleanup: Cleanup[];
  bulk: Bulk[];
  answeredDeals: Map<string, string>;
  answeredRows: Map<string, string>;
  sampleSize: number;
  score: LearnScoreResult;
  list: Extract<typeof LIST_ANSWERS, { success: true }>["answers"];
}

let main: FakeMain;
let api: Record<string, jest.Mock>;

function cleanupItems(): Cleanup[] {
  return [
    { detectionId: "d1", question: (CLEANUP_NEXT as { question: unknown }).question, preview: PREVIEW_CLEANUP },
    { detectionId: "d2", question: (CLEANUP_NEXT_2 as { question: unknown }).question, preview: PREVIEW_CLEANUP_2 },
  ];
}

function install(overrides: Partial<FakeMain> = {}): void {
  main = {
    state: STATE_ON,
    hasRun: true,
    cleanup: cleanupItems(),
    bulk: [
      { rowId: SAMPLE_ROW_ID, preview: PREVIEW_BULK },
      { rowId: "row-4120-2", preview: PREVIEW_BULK_2 },
    ],
    answeredDeals: new Map(),
    answeredRows: new Map(),
    sampleSize: 2,
    score: { ...(SCORE as Extract<LearnScoreResult, { success: true }>) },
    list: [],
    ...overrides,
  };
  const s = SCORE as Extract<LearnScoreResult, { success: true }>;
  api = {
    getState: jest.fn(async () => main.state),
    setEnabled: jest.fn(async ({ enabled }: { enabled: boolean }) => {
      main.state = { ...(main.state as Extract<LearnStateResult, { success: true }>), enabled };
      return { success: true, enabled };
    }),
    run: jest.fn(async () => {
      main.hasRun = true;
      return { success: true, summary: { runId: "run-x", detectionIds: ["d1", "d2"], rowsScanned: 1 } };
    }),
    onRunProgress: jest.fn(() => () => undefined),
    sampleDraw: jest.fn(async () => ({ success: true, result: { sampleSize: main.sampleSize, drawn: 0 } })),
    score: jest.fn(async () => {
      if (!main.hasRun) return { success: false, error: "Run the check first." };
      const unanswered = main.cleanup.filter((c) => !main.answeredDeals.has(c.detectionId)).length;
      return {
        ...s,
        score: { ...s.score, cleanupUnanswered: unanswered, bulk: { ...s.score.bulk, answered: main.answeredRows.size } },
      };
    }),
    cleanupNext: jest.fn(async (args?: { exclude: string[] }) => {
      const ex = new Set(args?.exclude ?? []);
      const next = main.cleanup.find((c) => !main.answeredDeals.has(c.detectionId) && !ex.has(c.detectionId));
      return { success: true, question: next ? next.question : null };
    }),
    cleanupAnswer: jest.fn(async ({ detectionId, answer }: { detectionId: string; answer: string }) => {
      main.answeredDeals.set(detectionId, answer);
      return { success: true };
    }),
    sampleNext: jest.fn(async () => {
      const next = main.bulk.find((b) => !main.answeredRows.has(b.rowId));
      return { success: true, question: next ? { rowId: next.rowId } : null };
    }),
    sampleAnswer: jest.fn(async ({ rowId, answer }: { rowId: string; answer: string }) => {
      main.answeredRows.set(rowId, answer);
      return { success: true };
    }),
    preview: jest.fn(async (args: { kind: string; detectionId?: string; rowId?: string }) => {
      if (args.kind === "cleanup") return main.cleanup.find((c) => c.detectionId === args.detectionId)!.preview;
      return main.bulk.find((b) => b.rowId === args.rowId)!.preview;
    }),
    attachmentOpen: jest.fn(async () => ({ success: true, dataUrl: "data:application/pdf;base64,JVBERi0=", downloadedNow: true })),
    deleteAnswers: jest.fn(async () => ({ success: true, removed: { deal: 2, bulk: 3 } })),
    listAnswers: jest.fn(async () => ({ success: true, answers: main.list })),
    deleteAnswer: jest.fn(async ({ kind, id }: { kind: string; id: string }) => {
      main.list = main.list.filter((a) => !(a.kind === kind && a.id === id));
      const st = main.state as Extract<LearnStateResult, { success: true }>;
      main.state = {
        ...st,
        answers: kind === "deal" ? { ...st.answers, deal: st.answers.deal - 1 } : { ...st.answers, bulk: st.answers.bulk - 1 },
      };
      return { success: true };
    }),
  };
  (window.api as unknown as { learn: unknown }).learn = api;
}

/** The section plus the app-level host Start hands off to (BACKLOG-4120 2.46.1: AppModals). */
function SectionWithHost() {
  const [total, setTotal] = React.useState<number | null>(null);
  const [score, setScore] = React.useState(false);
  return (
    <>
      <LearnSettings onStart={setTotal} onSeeScore={() => setScore(true)} />
      {total !== null && <LearnSessionHost total={total} onClose={() => setTotal(null)} />}
      {score && <LearnScoreHost onClose={() => setScore(false)} />}
    </>
  );
}

function renderSection() {
  return render(
    <PlatformProvider>
      <SectionWithHost />
    </PlatformProvider>,
  );
}

async function startSession(): Promise<HTMLElement> {
  renderSection();
  const start = await screen.findByTestId("learn-start");
  await waitFor(() => expect(start).not.toBeDisabled());
  fireEvent.click(start);
  return screen.findByRole("dialog", { name: "Learn mode question" });
}

const attachmentCalls = () => api.attachmentOpen.mock.calls.map((c) => c[0]);

beforeEach(() => {
  install();
});

describe("OFF toggle OFF: nothing below the switch", () => {
  it("renders only the header and the switch, and asks main for nothing else", async () => {
    install({ state: { success: true, available: true, enabled: false, answers: { deal: 0, bulk: 0 } } });
    renderSection();
    const sw = await screen.findByRole("switch", { name: "Learn mode" });
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("learn-start")).toBeNull();
    expect(screen.queryByTestId("learn-doing")).toBeNull();
    expect(screen.queryByTestId("learn-reading")).toBeNull();
    expect(screen.queryByTestId("learn-footer")).toBeNull();
    for (const m of ["run", "score", "sampleDraw", "cleanupNext", "sampleNext", "preview", "attachmentOpen"]) {
      expect({ m, calls: api[m].mock.calls.length }).toEqual({ m, calls: 0 });
    }
  });

  it("turning it ON asks main, then prepares the questions", async () => {
    install({ state: { success: true, available: true, enabled: false, answers: { deal: 0, bulk: 0 } } });
    renderSection();
    const sw = await screen.findByRole("switch", { name: "Learn mode" });
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await screen.findByTestId("learn-start");
    expect(api.setEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});

describe("ON toggle ON", () => {
  it("with no run in main, reads 12 months of mail, then shows Questions ready and the tiles", async () => {
    install({ hasRun: false });
    renderSection();
    const start = await screen.findByTestId("learn-start");
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(api.run).toHaveBeenCalledWith({ windowMonths: 12 });
    // 2 deal questions + 2 unanswered sample rows.
    expect(within(start).getByText("4")).toBeInTheDocument();
    expect(within(start).getByText("Questions ready")).toBeInTheDocument();
    const doing = screen.getByTestId("learn-doing");
    expect(within(doing).getByTestId("learn-tile-found")).toHaveTextContent("Not enough deals yet to score");
    expect(within(doing).getByTestId("learn-tile-found")).not.toHaveTextContent("0 of 0");
  });

  it("with a run already in main, does not run again", async () => {
    renderSection();
    await screen.findByTestId("learn-start");
    expect(api.run).not.toHaveBeenCalled();
  });

  it("the footer says turning Learn mode off keeps the answers", async () => {
    renderSection();
    expect(await screen.findByTestId("learn-footer")).toHaveTextContent("Turning Learn mode off keeps your answers.");
  });

  it("with no questions left, promises no new ones after a mail sync", async () => {
    install({ cleanup: [], bulk: [], sampleSize: 0 });
    renderSection();
    const start = await screen.findByTestId("learn-start");
    expect(start).toHaveTextContent("No questions right now");
    expect(start).toHaveTextContent("There are no more questions about the mail on this computer.");
    expect(start).not.toHaveTextContent(/mail sync/i);
  });
});

describe("RD the email preview is contained", () => {
  it("hostile position / z-index / class never reach the DOM, and the scroll box isolates the body", () => {
    const email = (PREVIEW_CLEANUP as Extract<LearnPreviewResult, { success: true }>).emails[0];
    render(
      <LearnEmailPane
        email={{
          ...email,
          bodyHtml:
            '<div class="fixed inset-0 z-50" style="position:fixed;inset:0;z-index:99999;color:#111">Canaryredress</div>',
        }}
        highlightAddress={null}
      />,
    );
    const body = screen.getByTestId("learn-email-body");
    const div = within(body).getByText("Canaryredress");
    expect(div).not.toHaveAttribute("class");
    expect(div.getAttribute("style")).toBe("color:#111");
    const box = screen.getByTestId("learn-email-scroll");
    for (const c of ["relative", "isolate", "overflow-x-auto", "overflow-y-auto", "[contain:paint]"]) {
      expect(box.className.split(/\s+/)).toContain(c);
    }
  });
});

describe("AT the one attachment, when its question is shown", () => {
  it("nothing is opened before Start; Q1 opens exactly its one; Q2 only when shown; mail questions never", async () => {
    renderSection();
    await screen.findByTestId("learn-start");
    expect(api.attachmentOpen).not.toHaveBeenCalled();
    expect(api.preview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("learn-start"));
    const dialog = await screen.findByRole("dialog", { name: "Learn mode question" });
    await within(dialog).findByTestId("learn-pdf-pane");
    expect(attachmentCalls()).toEqual([{ detectionId: "d1", attachmentId: "att-4120-1" }]);
    expect(within(dialog).getByText("Canary purchase agreement.pdf · PDF")).toBeInTheDocument();
    expect(within(dialog).getByText("4120 Canarytest Lane, Testville, ZZ 00000")).toBeInTheDocument();
    expect(within(dialog).getByTestId("learn-question-progress")).toHaveTextContent("Question 1 of 4");

    fireEvent.click(within(dialog).getByRole("button", { name: /Yes, my deal/ }));
    await within(dialog).findByText("77 Canarytest Road, Testville, ZZ 00000");
    await waitFor(() => expect(attachmentCalls()).toHaveLength(2));
    expect(attachmentCalls()[1]).toEqual({ detectionId: "d2", attachmentId: "att-4120-3" });
    expect(api.cleanupAnswer).toHaveBeenCalledWith({ detectionId: "d1", answer: "yes" });

    fireEvent.click(within(dialog).getByRole("button", { name: /^No$/ }));
    await within(dialog).findByText("Is this real estate business, or a newsletter / spam?");
    fireEvent.click(within(dialog).getByRole("button", { name: /Real estate business/ }));
    await within(dialog).findByText("Canarynews second issue", { selector: "span.text-base" });
    // Mail questions name no attachment and open none (flyer.pdf is listed only).
    expect(attachmentCalls()).toHaveLength(2);
  });

  it("while the document is being opened, the pane says so; a failure falls back to the email", async () => {
    let resolveOpen: (v: unknown) => void = () => undefined;
    api.attachmentOpen.mockImplementationOnce(() => new Promise((r) => (resolveOpen = r)));
    const dialog = await startSession();
    await within(dialog).findByTestId("learn-pdf-loading");
    await act(async () => resolveOpen({ success: false, error: "The document could not be opened." }));
    await within(dialog).findByTestId("learn-email-pane");
  });
});

describe("IMG remote images blocked until Show images, per email", () => {
  function remoteImages(root: HTMLElement): number {
    return Array.from(root.querySelectorAll("img")).filter((i) => /^https?:/i.test(i.getAttribute("src") ?? "")).length;
  }

  it("blocked on show; loaded after the click; blocked again on the next message", async () => {
    main.cleanup = [];
    const dialog = await startSession();
    const pane = await within(dialog).findByTestId("learn-email-pane");
    expect(remoteImages(pane)).toBe(0);
    expect(pane.innerHTML).not.toMatch(/url\(/i);
    expect(within(pane).getByText("flyer.pdf")).toBeInTheDocument();

    fireEvent.click(within(pane).getByRole("button", { name: "Show images" }));
    expect(remoteImages(within(dialog).getByTestId("learn-email-pane"))).toBe(1);

    fireEvent.click(within(dialog).getByRole("button", { name: /Newsletter or spam/ }));
    await within(dialog).findByText("Canarynews second issue", { selector: "span.text-base" });
    const next = within(dialog).getByTestId("learn-email-pane");
    expect(remoteImages(next)).toBe(0);
    expect(within(next).getByRole("button", { name: "Show images" })).toBeInTheDocument();
    expect(api.sampleAnswer).toHaveBeenCalledWith({ rowId: SAMPLE_ROW_ID, answer: "newsletter_spam" });
  });
});

describe("SK/UN skip and undo", () => {
  it("skipping a deal stores nothing and passes it over; skipping mail stores 'skip'", async () => {
    const dialog = await startSession();
    await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000");
    fireEvent.click(within(dialog).getByRole("button", { name: /Skip for now/ }));
    await within(dialog).findByText("77 Canarytest Road, Testville, ZZ 00000");
    expect(api.cleanupNext).toHaveBeenLastCalledWith({ exclude: ["d1"] });
    expect(api.cleanupAnswer).not.toHaveBeenCalled();
    expect(within(dialog).getByTestId("learn-question-progress")).toHaveTextContent("Question 2 of 4");

    fireEvent.click(within(dialog).getByRole("button", { name: /Skip for now/ }));
    await within(dialog).findByText("Is this real estate business, or a newsletter / spam?");
    fireEvent.click(within(dialog).getByRole("button", { name: /Skip for now/ }));
    await waitFor(() => expect(api.sampleAnswer).toHaveBeenCalledWith({ rowId: SAMPLE_ROW_ID, answer: "skip" }));
  });

  it("undo shows the previous question again and steps the counter back; the new answer replaces it", async () => {
    const dialog = await startSession();
    await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000");
    const undo = within(dialog).getByRole("button", { name: /Undo last/ });
    expect(undo).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: /Yes, my deal/ }));
    await within(dialog).findByText("77 Canarytest Road, Testville, ZZ 00000");
    expect(within(dialog).getByTestId("learn-question-progress")).toHaveTextContent("Question 2 of 4");

    await waitFor(() => expect(within(dialog).getByRole("button", { name: /Undo last/ })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: /Undo last/ }));
    await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000");
    expect(within(dialog).getByTestId("learn-question-progress")).toHaveTextContent("Question 1 of 4");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^No$/ })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: /^No$/ }));
    await waitFor(() => expect(api.cleanupAnswer).toHaveBeenLastCalledWith({ detectionId: "d1", answer: "no" }));
  });
});

describe("SC score", () => {
  it("after the last question: Thanks + tiles; details carry minimum, recall without legacy, skipped counts; Copy = main's block", async () => {
    const writeText = jest.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    main.bulk = [];
    const dialog = await startSession();
    await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000");
    fireEvent.click(within(dialog).getByRole("button", { name: /Yes, my deal/ }));
    await within(dialog).findByText("77 Canarytest Road, Testville, ZZ 00000");
    fireEvent.click(within(dialog).getByRole("button", { name: /^No$/ }));

    const done = await screen.findByRole("dialog", { name: "Thanks, 2 answers saved" });
    expect(within(done).getByText("Thanks, 2 answers saved")).toBeInTheDocument();
    expect(within(done).getByTestId("learn-tile-found")).toHaveTextContent("Not enough deals yet to score");
    fireEvent.click(within(done).getByRole("button", { name: "Details" }));
    const details = within(done).getByTestId("learn-score-details");
    expect(details).toHaveTextContent("Manual deals created before 2026-08-31 (possibly auto-detected): 1 (minimum)");
    expect(details).toHaveTextContent("Deals found, without manual deals created before 2026-08-31: 0 of 0 (n/a)");
    expect(details).toHaveTextContent("skipped (deal type not buyer or seller)");
    expect(details).toHaveTextContent("skipped (status not closed, active or pending)");
    fireEvent.click(within(done).getByRole("button", { name: "Copy score" }));
    expect(writeText).toHaveBeenCalledWith((SCORE as Extract<LearnScoreResult, { success: true }>).copyBlock);
    // No address, subject or file name anywhere in the score dialog.
    expect(done.textContent).not.toMatch(/canary/i);
  });

  it("See score opens the same dialog titled How Keepr is doing", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /See score/ }));
    const d = await screen.findByRole("dialog", { name: "How Keepr is doing" });
    expect(within(d).getByText("How Keepr is doing")).toBeInTheDocument();
  });
});

describe("P6 the canary stays out of attributes and the console", () => {
  it("no aria-label, title or data-* attribute and no console call carries the address, subject or file name", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => jest.spyOn(console, k).mockImplementation(() => undefined));
    try {
      const dialog = await startSession();
      await within(dialog).findByTestId("learn-pdf-pane");
      fireEvent.click(within(dialog).getByRole("button", { name: /Yes, my deal/ }));
      await within(dialog).findByText("77 Canarytest Road, Testville, ZZ 00000");
      const attrs: string[] = [];
      document.body.querySelectorAll("*").forEach((el) => {
        for (const a of Array.from(el.attributes)) {
          if (a.name === "aria-label" || a.name === "title" || a.name.startsWith("data-")) attrs.push(a.value);
        }
      });
      expect(attrs.length).toBeGreaterThan(0);
      expect(attrs.join("|")).not.toMatch(/canary|Offer accepted|Counter offer/i);
      const logged = JSON.stringify(spies.map((s) => s.mock.calls));
      expect(logged).not.toMatch(/canary/i);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe("DEL Data & Privacy: delete Learn mode answers", () => {
  it("shown with saved answers even when Learn mode is off and unavailable; deletes through main", async () => {
    install({ state: { success: true, available: false, enabled: false, answers: { deal: 2, bulk: 3 } } });
    render(<LearnAnswersPrivacyRow />);
    const row = await screen.findByTestId("learn-answers-privacy");
    expect(row).toHaveTextContent("5 answers saved on this computer");
    fireEvent.click(within(row).getByRole("button", { name: "Delete all" }));
    expect(api.deleteAnswers).not.toHaveBeenCalled();
    const confirm = within(row).getByTestId("learn-delete-all-confirm");
    expect(confirm).toHaveTextContent("Delete all answers? Your transactions don't change.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete all" }));
    await waitFor(() => expect(api.deleteAnswers).toHaveBeenCalledTimes(1));
    await within(row).findByText("Your Learn mode answers were deleted.");
  });

  it("hidden when there is nothing saved", async () => {
    install({ state: { success: true, available: true, enabled: true, answers: { deal: 0, bulk: 0 } } });
    const { container } = render(<LearnAnswersPrivacyRow />);
    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// 2.46.2: sittings of 12, Done for now, Your answers
// ---------------------------------------------------------------------------

function mailRows(n: number): Bulk[] {
  return Array.from({ length: n }, (_, i) => ({ rowId: `row-4120-m${i + 1}`, preview: PREVIEW_BULK }));
}

const progress = (dialog: HTMLElement) => within(dialog).getByTestId("learn-question-progress");

/** Wait for question N, then answer it (a mail question, or Yes on a deal). */
async function answerQuestion(dialog: HTMLElement, n: number, of: number): Promise<void> {
  await waitFor(() => expect(progress(dialog)).toHaveTextContent(`Question ${n} of ${of}`));
  const button = await within(dialog).findByRole("button", { name: /Newsletter or spam|Yes, my deal/ });
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
}

describe("C1/C2/C3 sittings of 12", () => {
  it("C2 the card shows one sitting: 12 and about 5 minutes, with 234 ready", async () => {
    install({ sampleSize: 232 });
    renderSection();
    const start = await screen.findByTestId("learn-start");
    expect(within(start).getByText("12")).toBeInTheDocument();
    expect(start).toHaveTextContent("About 5 minutes. Stop any time; your answers are kept.");
    expect(start).not.toHaveTextContent("234");
  });

  it("C1 the SESSION stops after 12: 30 items, 12 previews, then the score with 12 more", async () => {
    install({ cleanup: [], bulk: mailRows(30), sampleSize: 30 });
    const dialog = await startSession();
    for (let n = 1; n <= 11; n++) await answerQuestion(dialog, n, 12);
    await waitFor(() => expect(progress(dialog)).toHaveTextContent("Question 12 of 12"));
    await answerQuestion(dialog, 12, 12);
    const done = await screen.findByRole("dialog", { name: "Thanks, 12 answers saved" });
    expect(api.preview).toHaveBeenCalledTimes(12);
    expect(api.sampleAnswer).toHaveBeenCalledTimes(12);
    expect(screen.queryByRole("dialog", { name: "Learn mode question" })).toBeNull();
    expect(within(done).getByRole("button", { name: "12 more" })).toBeInTheDocument();
  });

  it("C3 12 more starts the next sitting at Question 1 of 12 and does not re-ask a deal skipped earlier; the last offers the rest", async () => {
    install({ bulk: mailRows(28), sampleSize: 28 }); // 2 deals + 28 mail = 30
    const dialog = await startSession();
    await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /Skip for now/ })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: /Skip for now/ }));
    for (let n = 2; n <= 12; n++) await answerQuestion(dialog, n, 12);
    const done = await screen.findByRole("dialog", { name: "Thanks, 11 answers saved" });
    fireEvent.click(within(done).getByRole("button", { name: "12 more" }));

    const next = await screen.findByRole("dialog", { name: "Learn mode question" });
    await waitFor(() => expect(progress(next)).toHaveTextContent("Question 1 of 12"));
    await within(next).findByRole("button", { name: /Newsletter or spam/ });
    expect(within(next).queryByText("4120 Canarytest Lane, Testville, ZZ 00000")).toBeNull();
    expect(api.cleanupNext).toHaveBeenLastCalledWith({ exclude: ["d1"] });
    for (let n = 1; n <= 12; n++) await answerQuestion(next, n, 12);
    const second = await screen.findByRole("dialog", { name: "Thanks, 12 answers saved" });
    // 30 - 24 = 6 left (5 mail + the skipped deal, which stays skipped this time).
    expect(within(second).getByRole("button", { name: "6 more" })).toBeInTheDocument();
  });

  it("C3 with 5 items the sitting ends at 5 and offers no more", async () => {
    install({ cleanup: [], bulk: mailRows(5), sampleSize: 5 });
    const dialog = await startSession();
    for (let n = 1; n <= 5; n++) await answerQuestion(dialog, n, 5);
    const done = await screen.findByRole("dialog", { name: "Thanks, 5 answers saved" });
    expect(within(done).queryByRole("button", { name: /more$/ })).toBeNull();
    expect(within(done).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });
});

describe("C4 Done for now", () => {
  it("keeps an in-flight answer: the score waits for the store, counts it, and nothing more is asked", async () => {
    main.bulk = [];
    let resolveStore: (v: { success: true }) => void = () => undefined;
    api.cleanupAnswer.mockImplementationOnce(
      ({ detectionId, answer }: { detectionId: string; answer: string }) =>
        new Promise((r) => {
          resolveStore = (v) => {
            main.answeredDeals.set(detectionId, answer);
            r(v);
          };
        }),
    );
    const dialog = await startSession();
    const yes = await within(dialog).findByRole("button", { name: /Yes, my deal/ });
    await waitFor(() => expect(yes).not.toBeDisabled());
    fireEvent.click(yes);
    await waitFor(() => expect(api.cleanupAnswer).toHaveBeenCalledTimes(1));
    const cleanupCalls = api.cleanupNext.mock.calls.length;
    const previewCalls = api.preview.mock.calls.length;
    const scoreCalls = api.score.mock.calls.length; // the Settings section read it once on load
    fireEvent.click(within(dialog).getByRole("button", { name: "Done for now" }));
    await act(async () => Promise.resolve());
    expect(api.score).toHaveBeenCalledTimes(scoreCalls);

    await act(async () => resolveStore({ success: true }));
    const done = await screen.findByRole("dialog", { name: "Thanks, 1 answer saved" });
    expect(api.score).toHaveBeenCalledTimes(scoreCalls + 1);
    expect(api.cleanupNext).toHaveBeenCalledTimes(cleanupCalls);
    expect(api.sampleNext).not.toHaveBeenCalled();
    expect(api.preview).toHaveBeenCalledTimes(previewCalls);
    // Let any late continuation run, then check the question did not come back over the score.
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(api.cleanupNext).toHaveBeenCalledTimes(cleanupCalls);
    expect(screen.queryByRole("dialog", { name: "Learn mode question" })).toBeNull();
    expect(done).toBeInTheDocument();
    expect(within(done).queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("is shown while loading, on a question and on an error; with nothing answered the score is How Keepr is doing", async () => {
    let resolvePreview: (v: LearnPreviewResult) => void = () => undefined;
    api.preview.mockImplementationOnce(() => new Promise((r) => (resolvePreview = r)));
    const dialog = await startSession();
    expect(within(dialog).getByRole("button", { name: "Done for now" })).not.toBeDisabled();
    await act(async () => resolvePreview({ success: false, error: "That item is not part of the current questions." }));
    await within(dialog).findByText("That item is not part of the current questions.");
    const doneForNow = within(dialog).getByRole("button", { name: "Done for now" });
    expect(doneForNow).not.toBeDisabled();
    fireEvent.click(doneForNow);
    await screen.findByRole("dialog", { name: "How Keepr is doing" });
  });

  it("is shown on a question", async () => {
    const dialog = await startSession();
    await within(dialog).findByText("4120 Canarytest Lane, Testville, ZZ 00000");
    expect(within(dialog).getByRole("button", { name: "Done for now" })).not.toBeDisabled();
  });
});

describe("C8 Your answers in Help Keepr learn", () => {
  it("lists answers newest first; Delete asks inline; a delete re-reads the count and the score", async () => {
    const list = (LIST_ANSWERS as Extract<typeof LIST_ANSWERS, { success: true }>).answers;
    install({ list: [...list], state: { success: true, available: true, enabled: true, answers: { deal: 1, bulk: 2 } } });
    renderSection();
    const box = await screen.findByTestId("learn-answers-list");
    expect(screen.getByTestId("learn-footer")).toHaveTextContent("3 answers so far.");
    const rows = within(box).getAllByTestId("learn-answer-row");
    expect(rows.map((r) => r.textContent?.split(/Yes|Real|Skip/)[0])).toEqual([
      "4120 Canarytest Lane, Testville, ZZ 00000",
      "Canarysubject offer",
      "Message no longer on this computer",
    ]);
    expect(rows[0]).toHaveTextContent("Yes, my deal · Answered");
    expect(rows[2]).toHaveTextContent("Skipped");
    const scoreCalls = api.score.mock.calls.length;

    fireEvent.click(within(rows[0]).getByRole("button", { name: "Delete" }));
    expect(api.deleteAnswer).not.toHaveBeenCalled();
    expect(within(rows[0]).getByText("Delete?")).toBeInTheDocument();
    fireEvent.click(within(rows[0]).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteAnswer).toHaveBeenCalledWith({ kind: "deal", id: "dla-c" }));
    await waitFor(() => expect(within(box).getAllByTestId("learn-answer-row")).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("learn-footer")).toHaveTextContent("2 answers so far."));
    expect(api.score.mock.calls.length).toBeGreaterThan(scoreCalls);
  });

  it("is shown with Learn mode off", async () => {
    const list = (LIST_ANSWERS as Extract<typeof LIST_ANSWERS, { success: true }>).answers;
    install({ list: [...list], state: { success: true, available: true, enabled: false, answers: { deal: 1, bulk: 2 } } });
    renderSection();
    expect(await screen.findByTestId("learn-answers-list")).toBeInTheDocument();
    expect(screen.queryByTestId("learn-start")).toBeNull();
  });
});
