/**
 * @jest-environment node
 *
 * BACKLOG-2791 — CONTROL 5, rebuilt.
 *
 * WHY IT WAS REBUILT. The first version grepped whole files for
 * `syncReviewQueueForTransaction || queueForReviewInsteadOfLinking`. A 1700-line
 * file containing the string ANYWHERE passed — so it certified
 * emailSyncService's "on-open provider-fetch branch" as wired while an early
 * return at :942 leaked straight past the flag and silently linked every text on
 * a phone-only deal. Its inputs could not separate pass from fail, which is the
 * one thing a control has to do.
 *
 * This version enumerates every CALL SITE of every link primitive by scanning
 * for the call expressions, and requires each one to be CLASSIFIED. An
 * unclassified call site fails the suite — so a NEW writer (the failure mode
 * that produced blockers 5 and 6, two writers missed by an enumeration done from
 * memory) cannot be added silently.
 */

import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "../..");

/** The primitives that put a communication into the audit. */
const LINK_PRIMITIVES = [
  "autoLinkCommunicationsForContact",
  "fetchAndAutoLinkForContact",
  "runAutoLinkOnly",
  "autoLinkAllToTransaction",
  "createThreadCommunicationReference",
  "linkEmailToTransaction",
];

/**
 * Every known call site, and WHY it is allowed to behave as it does.
 *
 *  "queues"  — on the deal surface; must route through the review queue.
 *  "manual"  — the user explicitly asked for a link on this deal (a sync button
 *              or a resync); linking is the requested action, not a discovery.
 *  "global"  — background pipelines outside the deal surface. Founder scope
 *              decision: these KEEP auto-linking. Re-routing them would make
 *              every synced email pend approval and flood the review screen.
 *  "internal"— the primitive's own definition or an internal helper hop.
 */
type Classification = "queues" | "manual" | "global" | "internal";

const CLASSIFIED: Record<string, Classification> = {
  // --- deal surface: must queue -------------------------------------------
  "electron/services/transactionSyncTrigger.ts": "queues",
  "electron/handlers/transactionCrudHandlers.ts": "queues",
  "electron/handlers/contactHandlers.ts": "queues",
  // --- user-initiated manual link on this deal -----------------------------
  "electron/handlers/emailAutoLinkHandlers.ts": "manual",
  // --- global background pipelines (founder scope decision) ----------------
  "electron/handlers/syncHandlers.ts": "global",
  "electron/handlers/messageImportHandlers.ts": "global",
  // --- mixed files, asserted at call-site granularity below -----------------
  "electron/services/emailSyncService.ts": "internal",
  "electron/services/transactionService/transactionService.ts": "internal",
  "electron/services/autoLinkService.ts": "internal",
  "electron/services/messageMatchingService.ts": "internal",
  "electron/services/reviewStateService.ts": "internal",
  // Defines createThreadCommunicationReference; a primitive, not a caller.
  "electron/services/db/communicationDbService.ts": "internal",
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", "dist-electron", "__tests__"].includes(e.name)) continue;
        walk(full);
      } else if (e.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

const rel = (f: string) => path.relative(path.join(ROOT, ".."), f).split(path.sep).join("/");
const read = (r: string) => fs.readFileSync(path.join(ROOT, "..", r), "utf8");

describe("BACKLOG-2791 CONTROL 5 — every link writer is enumerated and classified", () => {
  const files = sourceFiles();

  it("the scan sees the tree (the control on the control)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every file that CALLS a link primitive is classified", () => {
    const callers = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const prim of LINK_PRIMITIVES) {
        // A CALL, not a mention: the identifier followed by "(".
        if (new RegExp(`\\b${prim}\\s*\\(`).test(src)) callers.add(rel(f));
      }
    }
    const unclassified = [...callers].filter((f) => !(f in CLASSIFIED)).sort();

    // A new writer lands here. Blockers 5 and 6 of the SR review were exactly
    // this: two call sites nobody had enumerated.
    expect(unclassified).toEqual([]);
  });

  it("the on-open trigger queues on BOTH its branches, including the phone-only early return", () => {
    const sync = read("electron/services/emailSyncService.ts");
    // The early return that leaked: it must now forward the flag.
    expect(sync).toMatch(
      /return this\.runAutoLinkOnly\(\s*transactionId,\s*contactAssignments,\s*queueForReviewInsteadOfLinking,?\s*\)/,
    );
    // ...and runAutoLinkOnly must have a queue path, not just accept the flag.
    const body = sync.slice(sync.indexOf("private async runAutoLinkOnly"));
    expect(body.slice(0, 1600)).toContain("syncReviewQueueForTransaction");
  });

  it("transaction CREATION with parties queues rather than links", () => {
    // The most common entry point of all, and the one missed first time.
    const svc = read("electron/services/transactionService/transactionService.ts");
    const fn = svc.slice(
      svc.indexOf("async createAuditedTransaction"),
      svc.indexOf("async getTransactionWithContacts"),
    );
    expect(fn).toContain("syncReviewQueueForTransaction");
    expect(fn).not.toContain("autoLinkCommunicationsForContact(");
  });

  it("assign-contact queues on BOTH branches, including the transaction-not-found fallback", () => {
    const svc = read("electron/services/transactionService/transactionService.ts");
    const fn = svc.slice(svc.indexOf("async assignContactToTransaction"));
    const upTo = fn.slice(0, fn.indexOf("\n  async "));
    expect(upTo).toContain("queueForReviewInsteadOfLinking: true");
    expect(upTo).toContain("syncReviewQueueForTransaction");
    expect(upTo).not.toContain("autoLinkCommunicationsForContact(");
  });

  it("the contact-save paths use the contact-change axis, which ignores the watermark", () => {
    for (const f of [
      "electron/handlers/transactionCrudHandlers.ts",
      "electron/handlers/contactHandlers.ts",
    ]) {
      expect(read(f)).toContain('reason: "contact-change"');
    }
  });

  it("ONLY the open path advances the watermark", () => {
    const src = read("electron/services/reviewStateService.ts");
    expect(src.match(/UPDATE transactions SET last_pending_scan_at/g) ?? []).toHaveLength(1);
    expect(src.slice(src.indexOf('if (reason === "open") {'))).toContain(
      "UPDATE transactions SET last_pending_scan_at",
    );
  });

  it("the queue-changed broadcast is wired end to end", () => {
    // The renderer subscribes with optional chaining so a partial `window.api`
    // mock cannot break the details screen. That tolerance would otherwise let a
    // real removal pass unnoticed, so the three ends are pinned structurally.
    expect(read("electron/services/reviewStateService.ts")).toContain('"review:queue-changed"');
    expect(read("electron/preload/transactionBridge.ts")).toContain("onReviewQueueChanged");
    expect(read("electron/types/ipc/window-api-transactions.ts")).toContain("onReviewQueueChanged");
  });

  it("the global writers still auto-link — the founder's scope decision", () => {
    for (const f of ["electron/handlers/syncHandlers.ts", "electron/handlers/messageImportHandlers.ts"]) {
      const src = read(f);
      expect(src).not.toContain("syncReviewQueueForTransaction");
      expect(src).not.toContain("queueForReviewInsteadOfLinking");
    }
  });
});
