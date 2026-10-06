/**
 * Live (founder): Keepr's "Open Google Messages" opens Messages with
 * #keepr-link. The new tab asks the worker (which may move to an open
 * signed-in tab and close this one); else it opens the link window itself —
 * only once Messages is signed in here. On the QR page (never signed in)
 * nothing opens. Mutations: opened while not signed in; opened after a
 * hand-off → red.
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports */
const job = require("../../chrome-extension/job.js") as {
  handleLinkHash: (io: { toWorker: (m: { type: string }) => Promise<unknown>; sleep: (ms: number) => Promise<void>; signedIn: () => boolean }) => Promise<string>;
  LINK_HASH_RE: RegExp;
};
/* eslint-enable @typescript-eslint/no-require-imports */

function io(opts: { handedOff: boolean; signedInAfter: number }) {
  const sent: string[] = [];
  let slept = 0;
  return {
    sent,
    io: {
      toWorker: async (m: { type: string }) => {
        sent.push(m.type);
        return m.type === "keepr-link-found" ? { handedOff: opts.handedOff } : { ok: true };
      },
      sleep: async (ms: number) => void (slept += ms),
      signedIn: () => slept >= opts.signedInAfter,
    },
  };
}

describe("#keepr-link on a new Messages tab", () => {
  it("the hash: only #keepr-link (not a job hash)", () => {
    expect(job.LINK_HASH_RE.test("#keepr-link")).toBe(true);
    expect(job.LINK_HASH_RE.test("#a=1&keepr-link")).toBe(true);
    expect(job.LINK_HASH_RE.test("#keepr-job=00000000-0000-4000-8000-000000000000")).toBe(false); // pii-allow-uuid: invented
  });

  it("handed off to an open signed-in tab: this tab opens nothing", async () => {
    const t = io({ handedOff: true, signedInAfter: 0 });
    expect(await job.handleLinkHash(t.io)).toBe("handed_off");
    expect(t.sent).toEqual(["keepr-link-found"]);
  });

  it("no other tab: the link window here once signed in", async () => {
    const t = io({ handedOff: false, signedInAfter: 3000 });
    expect(await job.handleLinkHash(t.io)).toBe("opened_here");
    expect(t.sent).toEqual(["keepr-link-found", "keepr-open-link-window"]);
  });

  it("never signed in (the QR page): no link window", async () => {
    const t = io({ handedOff: false, signedInAfter: Infinity });
    expect(await job.handleLinkHash(t.io)).toBe("not_signed_in");
    expect(t.sent).toEqual(["keepr-link-found"]);
  });
});
