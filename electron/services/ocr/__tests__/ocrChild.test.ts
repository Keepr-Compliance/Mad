/**
 * @jest-environment node
 *
 * BACKLOG-3943 — the page-child wrapper with an in-process fake child (nothing spawned).
 * C5 stdout cap, C4 timeout, crash/exit/unreadable classification, the stop used on quit,
 * and the output parser on the child's real wire format.
 */
import { VISION_OCR_SCRIPT } from "../visionOcrScript";
import {
  __setOcrSpawnerForTests,
  buildOcrArgs,
  isOcrSupportedPlatform,
  parseOcrOutput,
  runOcrPage,
  stopLiveOcrChild,
  type OcrPageOptions,
} from "../ocrChild";
import { makeFakeSpawner, type FakeBehaviour } from "./fakeOcrChild";

const OPTS: OcrPageOptions = { dpi: 200, maxLongEdgePx: 2600, timeoutMs: 1000, maxStdoutBytes: 4096 };
const BYTES = Buffer.from("%PDF synthetic");

afterEach(() => __setOcrSpawnerForTests(null));

function useFake(b: FakeBehaviour) {
  const fake = makeFakeSpawner(() => b);
  __setOcrSpawnerForTests(fake.spawner);
  return fake;
}

describe("parseOcrOutput", () => {
  it("reads the DOC count and the first PAGE block", () => {
    const out = "\u0001DOC pages=3\n\u0001PAGE 2 ms=1500 lines=2 held=4\nForm 41\nRev. 8/24\n\u0002\n";
    expect(parseOcrOutput(out)).toEqual({ pagesTotal: 3, lines: ["Form 41", "Rev. 8/24"] });
  });

  it("an unterminated PAGE block (child died mid-write) yields no lines", () => {
    expect(parseOcrOutput("\u0001DOC pages=3\n\u0001PAGE 1 ms=1 lines=2\nForm 41\n")).toEqual({ pagesTotal: 3, lines: null });
  });

  it("no DOC line -> pagesTotal null", () => {
    expect(parseOcrOutput("")).toEqual({ pagesTotal: null, lines: null });
  });
});

describe("runOcrPage", () => {
  it("success: lines and page count; args carry integers only", async () => {
    const fake = useFake({ kind: "page", pagesTotal: 2, lines: ["Form 41"] });
    await expect(runOcrPage(BYTES, 1, OPTS)).resolves.toMatchObject({ ok: true, pagesTotal: 2, lines: ["Form 41"] });
    expect(fake.calls[0].args).toEqual(buildOcrArgs(1, OPTS));
    expect(fake.calls[0].args.slice(0, 4)).toEqual(["-l", "JavaScript", "-e", VISION_OCR_SCRIPT]);
    expect(fake.calls[0].stdinBytes).toBe(BYTES.length);
  });

  it("a page index past the end is ok with no lines", async () => {
    useFake({ kind: "page", pagesTotal: 1, lines: ["x"] });
    await expect(runOcrPage(BYTES, 3, OPTS)).resolves.toMatchObject({ ok: true, pagesTotal: 1, lines: [] });
  });

  it("crash by signal -> signal, keeping a DOC count streamed before the crash", async () => {
    useFake({ kind: "crash", signal: "SIGSEGV", pagesTotal: 5 });
    await expect(runOcrPage(BYTES, 0, OPTS)).resolves.toMatchObject({ ok: false, failure: "signal", pagesTotal: 5 });
  });

  it("non-zero exit -> exit; the unreadable message -> unreadable", async () => {
    useFake({ kind: "exit", code: 1, stderr: "vision performRequests failed" });
    await expect(runOcrPage(BYTES, 0, OPTS)).resolves.toMatchObject({ ok: false, failure: "exit" });
    useFake({ kind: "exit", code: 1, stderr: "execution error: Error: stdin is neither a PDF nor an image (-2700)" });
    await expect(runOcrPage(BYTES, 0, OPTS)).resolves.toMatchObject({ ok: false, failure: "unreadable" });
  });

  it("C4: a hung child is stopped with SIGKILL at the timeout", async () => {
    const fake = useFake({ kind: "hang" });
    await expect(runOcrPage(BYTES, 0, { ...OPTS, timeoutMs: 20 })).resolves.toMatchObject({ ok: false, failure: "timeout" });
    expect(fake.calls[0].killedWith).toBe("SIGKILL");
  });

  it("C5: stdout over the cap stops the child; nothing partial is returned", async () => {
    const fake = useFake({ kind: "flood", bytes: OPTS.maxStdoutBytes + 1 });
    const r = await runOcrPage(BYTES, 0, OPTS);
    expect(r).toMatchObject({ ok: false, failure: "overflow" });
    expect("lines" in r).toBe(false);
    expect(fake.calls[0].killedWith).toBe("SIGKILL");
  });

  it("stdout under the cap is not an overflow", async () => {
    useFake({ kind: "page", pagesTotal: 1, lines: ["x".repeat(100)] });
    await expect(runOcrPage(BYTES, 0, OPTS)).resolves.toMatchObject({ ok: true });
  });

  it("a spawn that throws -> spawn failure, never a throw", async () => {
    __setOcrSpawnerForTests(() => {
      throw new Error("ENOENT");
    });
    await expect(runOcrPage(BYTES, 0, OPTS)).resolves.toMatchObject({ ok: false, failure: "spawn" });
  });

  it("stopLiveOcrChild (quit) ends the live child with SIGKILL -> stopped", async () => {
    const fake = useFake({ kind: "hang" });
    const p = runOcrPage(BYTES, 0, OPTS);
    expect(stopLiveOcrChild()).toBe(true);
    await expect(p).resolves.toMatchObject({ ok: false, failure: "stopped" });
    expect(fake.calls[0].killedWith).toBe("SIGKILL");
    expect(stopLiveOcrChild()).toBe(false);
  });
});

describe("platform", () => {
  it("macOS only in this build", () => {
    expect(isOcrSupportedPlatform("darwin")).toBe(true);
    expect(isOcrSupportedPlatform("win32")).toBe(false);
    expect(isOcrSupportedPlatform("linux")).toBe(false);
  });
});

describe("the script asks Vision for the accurate level only (founder ruling 6)", () => {
  it("names the accurate level and never the fast level", () => {
    expect(VISION_OCR_SCRIPT).toContain("$.VNRequestTextRecognitionLevelAccurate");
    expect(VISION_OCR_SCRIPT).not.toContain("RecognitionLevelFast");
  });
});
