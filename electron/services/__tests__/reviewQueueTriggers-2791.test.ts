/**
 * @jest-environment node
 *
 * BACKLOG-2791 — CONTROL 5: every discovery TRIGGER is actually wired.
 *
 * The behaviour of a sync is covered by reviewStateService-2791. What this file
 * pins is that the sync is CALLED from each place the founder's design requires,
 * and — just as important — NOT called from the three global writers the founder
 * scoped out. A trigger silently dropped during a refactor is invisible to every
 * behavioural test: the queue simply stops filling, and nothing goes red.
 *
 * Structural by necessity (the same reasoning as singleReadPath-2791): the
 * failure mode is a MISSING call site, and no behavioural test can observe a
 * call that no longer exists.
 *
 * The founder's scope decision, recorded so a future reader does not "fix" it:
 * discovery is contact-change/open driven — "the deal finds out on its next
 * open". The background provider sync, the message import and the debounced
 * linker KEEP auto-linking. The honest consequence is that mail auto-linked by a
 * background sync never appears in P2; P2 reports what the DEAL-SCOPED scan
 * found, which is its designed meaning.
 */

import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Trigger sites that MUST queue for review. */
const MUST_QUEUE: Array<{ file: string; why: string }> = [
  {
    file: "services/transactionSyncTrigger.ts",
    why: "T1 — the on-open trigger's already-covered branch",
  },
  {
    file: "services/emailSyncService.ts",
    why: "T1 — the on-open trigger's provider-fetch branch, and the per-contact fetch",
  },
  {
    file: "../electron/handlers/transactionCrudHandlers.ts",
    why: "T2 — batchUpdateContacts add-ops (a contact saved ON the deal)",
  },
  {
    file: "../electron/handlers/contactHandlers.ts",
    why: "T2 — contacts:update (editing a party's email/phone changes the matcher inputs)",
  },
];

describe("BACKLOG-2791 CONTROL 5 — discovery triggers are wired", () => {
  it.each(MUST_QUEUE)("$file queues for review ($why)", ({ file }) => {
    const src = read(file);
    const queues =
      src.includes("syncReviewQueueForTransaction") ||
      src.includes("queueForReviewInsteadOfLinking");
    expect(queues).toBe(true);
  });

  it("the contact-save paths use the contact-change axis, which ignores the watermark", () => {
    // A contact-save that scanned with the OPEN axis would miss the newly
    // relevant contact's older mail entirely — the exact bug the two axes exist
    // to prevent — and nothing would look wrong.
    for (const file of [
      "../electron/handlers/transactionCrudHandlers.ts",
      "../electron/handlers/contactHandlers.ts",
    ]) {
      expect(read(file)).toContain('reason: "contact-change"');
    }
  });

  it("assign-contact (confirming a suggested match) queues rather than links", () => {
    expect(read("services/transactionService/transactionService.ts")).toContain(
      "queueForReviewInsteadOfLinking: true",
    );
  });

  it("ONLY the open path advances the watermark", () => {
    const src = read("services/reviewStateService.ts");
    const advances = src.match(/UPDATE transactions SET last_pending_scan_at/g) ?? [];
    // Exactly one write site, and it is inside the reason === "open" branch.
    expect(advances).toHaveLength(1);
    const branch = src.slice(src.indexOf('if (reason === "open") {'));
    expect(branch).toContain("UPDATE transactions SET last_pending_scan_at");
  });

  it("the three GLOBAL writers still auto-link — the founder's scope decision", () => {
    // If someone later routes these through the queue, every synced email would
    // pend approval and the review screen would flood. That is a founder call,
    // not a refactor, so it goes red here first.
    for (const file of ["../electron/handlers/syncHandlers.ts", "../electron/handlers/messageImportHandlers.ts"]) {
      const src = read(file);
      expect(src).not.toContain("syncReviewQueueForTransaction");
      expect(src).not.toContain("queueForReviewInsteadOfLinking");
    }
  });
});
