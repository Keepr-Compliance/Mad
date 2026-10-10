/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816: the quit prompt while the kept iPhone backup is being secured.
 *
 * The app double mirrors Electron: `quit()` emits `before-quit` with a cancellable event
 * and the app exits only when no handler prevented it. The before-quit handler is
 * composed exactly as main.ts composes it: the prompt first, then the three existing
 * deferrals built by the real createBackupStopOnQuit.
 */
import { createBackupStopOnQuit, type QuitEventLike } from "../backupStopOnQuit";
import {
  createSealQuitPrompt,
  installSealQuitPrompt,
  noteSystemQuit,
  resetSealQuitPromptForTests,
  sealQuitPromptHeading,
  SEAL_QUIT_PROMPT_DETAIL,
  SYSTEM_QUIT_RESET_MS,
  type SealQuitPrompt,
} from "../sealQuitPrompt";

type Choice = "keep" | "quit";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(opts: { sealing: number | null }) {
  let sealPercent: number | null = opts.sealing;
  const asks: Array<{ percent: number; signal: AbortSignal; answer: ReturnType<typeof deferred<Choice>> }> = [];
  const order: string[] = [];
  let exited = false;

  const backupStop = jest.fn((): Promise<unknown> | null => null);
  const linkWait = jest.fn((): Promise<unknown> | null => null);
  const indexSeal = jest.fn((): Promise<unknown> | null => {
    order.push("index-seal");
    return Promise.resolve();
  });

  const app = {
    quit: () => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      beforeQuit(event);
      if (!event.prevented) {
        order.push("exit");
        exited = true;
      }
    },
  };

  const prompt: SealQuitPrompt = installSealQuitPrompt(
    createSealQuitPrompt({
      app,
      sealPercent: () => sealPercent,
      ask: (percent, signal) => {
        order.push("prompt");
        const answer = deferred<Choice>();
        asks.push({ percent, signal, answer });
        // Like Electron's message box: an aborted dialog resolves as cancelled.
        signal.addEventListener("abort", () => answer.resolve("keep"));
        return answer.promise;
      },
    }),
  );

  const deferQuitForBackupStop = createBackupStopOnQuit(app, () => {
    const r = backupStop();
    if (r) order.push("backup-stop");
    return r;
  });
  const deferQuitForLink = createBackupStopOnQuit(app, linkWait);
  const deferQuitForBackupSeal = createBackupStopOnQuit(app, indexSeal);
  const cleanup = jest.fn(() => order.push("cleanup"));

  // Same order as main.ts's before-quit handler.
  function beforeQuit(event: QuitEventLike) {
    if (prompt.check(event)) return;
    if (deferQuitForBackupStop(event)) return;
    if (deferQuitForLink(event)) return;
    if (deferQuitForBackupSeal(event)) return;
    cleanup();
  }

  return {
    app,
    prompt,
    asks,
    order,
    indexSeal,
    backupStop,
    cleanup,
    exited: () => exited,
    setSealing: (p: number | null) => {
      sealPercent = p;
    },
  };
}

beforeEach(() => resetSealQuitPromptForTests());

describe("seal quit prompt (BACKLOG-3816)", () => {
  it("asks on a user quit while a seal pass runs, with the percentage", () => {
    const h = harness({ sealing: 42 });
    h.app.quit();
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0].percent).toBe(42);
    expect(sealQuitPromptHeading(42)).toBe("Securing your iPhone backup (42%)");
    expect(SEAL_QUIT_PROMPT_DETAIL).toBe("Quit now? Securing will finish next time you open Keepr.");
    // Held: nothing ran behind the prompt.
    expect(h.indexSeal).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
    expect(h.exited()).toBe(false);
  });

  it("does not ask when no seal pass is running", async () => {
    const h = harness({ sealing: null });
    h.app.quit();
    expect(h.asks).toHaveLength(0);
    await flush();
    await flush();
    expect(h.exited()).toBe(true);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
  });

  it("Keep running cancels the quit; the seal pass is not paused; a later quit asks again", async () => {
    const h = harness({ sealing: 10 });
    h.app.quit();
    h.asks[0].answer.resolve("keep");
    await flush();
    expect(h.exited()).toBe(false);
    // The index seal (which pauses the running pass) never ran.
    expect(h.indexSeal).not.toHaveBeenCalled();
    expect(h.cleanup).not.toHaveBeenCalled();
    // Nothing that stops a running sync ran either (PC final check 2026-10-10): the backup
    // stop and the link wait come after the prompt and only on Quit anyway.
    expect(h.backupStop).not.toHaveBeenCalled();
    expect(h.order).toEqual(["prompt"]);
    h.setSealing(55);
    h.app.quit();
    expect(h.asks).toHaveLength(2);
    expect(h.asks[1].percent).toBe(55);
  });

  it("Quit anyway proceeds, and the index seal still runs before the app exits", async () => {
    const h = harness({ sealing: 30 });
    h.app.quit();
    h.asks[0].answer.resolve("quit");
    await flush();
    await flush();
    expect(h.indexSeal).toHaveBeenCalledTimes(1);
    expect(h.exited()).toBe(true);
    expect(h.order).toEqual(["prompt", "index-seal", "cleanup", "exit"]);
    expect(h.cleanup).toHaveBeenCalledTimes(1);
    expect(h.asks).toHaveLength(1);
  });

  it("Quit anyway keeps the deferral order: backup stop, then index seal", async () => {
    const h = harness({ sealing: 30 });
    h.backupStop.mockImplementationOnce(() => Promise.resolve());
    h.app.quit();
    h.asks[0].answer.resolve("quit");
    for (let i = 0; i < 4; i++) await flush();
    expect(h.order).toEqual(["prompt", "backup-stop", "index-seal", "cleanup", "exit"]);
  });

  it("repeated quits while the dialog is open do not stack dialogs", async () => {
    const h = harness({ sealing: 20 });
    h.app.quit();
    h.app.quit();
    h.app.quit();
    expect(h.asks).toHaveLength(1);
    expect(h.exited()).toBe(false);
    h.asks[0].answer.resolve("quit");
    await flush();
    await flush();
    expect(h.exited()).toBe(true);
    expect(h.asks).toHaveLength(1);
  });

  it("an OS shutdown does not ask (the index seal still runs)", async () => {
    const h = harness({ sealing: 20 });
    noteSystemQuit("os-shutdown");
    h.app.quit();
    expect(h.asks).toHaveLength(0);
    await flush();
    await flush();
    expect(h.indexSeal).toHaveBeenCalledTimes(1);
    expect(h.exited()).toBe(true);
  });

  it("Restart to update does not ask", () => {
    const h = harness({ sealing: 20 });
    noteSystemQuit("update");
    h.app.quit();
    expect(h.asks).toHaveLength(0);
  });

  it("a shutdown noted before the prompt is installed still applies", () => {
    noteSystemQuit("os-shutdown");
    const h = harness({ sealing: 20 });
    h.app.quit();
    expect(h.asks).toHaveLength(0);
  });

  it("a shutdown while the dialog is open closes it and quits", async () => {
    const h = harness({ sealing: 20 });
    h.app.quit();
    expect(h.asks).toHaveLength(1);
    noteSystemQuit("os-shutdown");
    expect(h.asks[0].signal.aborted).toBe(true);
    await flush();
    await flush();
    expect(h.exited()).toBe(true);
    expect(h.indexSeal).toHaveBeenCalledTimes(1);
  });

  it("a shutdown/update signal with no quit after it stops suppressing the prompt after 30 s", () => {
    jest.useFakeTimers();
    try {
      const h = harness({ sealing: 20 });
      noteSystemQuit("os-shutdown"); // a shutdown another app then cancelled
      jest.advanceTimersByTime(SYSTEM_QUIT_RESET_MS - 1);
      h.app.quit();
      // Inside the window: still treated as the OS's quit.
      expect(h.asks).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("after the 30 s reset a user quit asks again (cancelled shutdown / failed update)", () => {
    jest.useFakeTimers();
    try {
      const h = harness({ sealing: 20 });
      noteSystemQuit("update");
      jest.advanceTimersByTime(SYSTEM_QUIT_RESET_MS);
      h.app.quit();
      expect(h.asks).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("the reset does not bring the prompt back in the middle of a system quit's re-quits", async () => {
    jest.useFakeTimers();
    try {
      const h = harness({ sealing: 20 });
      let release!: () => void;
      h.backupStop.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
      noteSystemQuit("os-shutdown");
      h.app.quit(); // deferred by the backup stop
      jest.advanceTimersByTime(SYSTEM_QUIT_RESET_MS + 1000);
      release();
      await Promise.resolve();
      await Promise.resolve();
      expect(h.asks).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a dialog that fails does not swallow the quit", async () => {
    resetSealQuitPromptForTests();
    let exited = false;
    let prompt!: SealQuitPrompt;
    const app = {
      quit: () => {
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        if (!prompt.check(event)) exited = true;
      },
    };
    prompt = createSealQuitPrompt({ app, sealPercent: () => 5, ask: () => Promise.reject(new Error("no window")) });
    app.quit();
    await flush();
    expect(exited).toBe(true);
  });
});
