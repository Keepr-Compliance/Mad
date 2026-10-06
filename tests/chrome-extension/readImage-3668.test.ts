/**
 * BACKLOG-3668 L2: a photo is read only from Messages for Web's own blob:
 * URLs or Google's image host, and never past the photo size cap.
 *
 * Mutation controls (each turns a test red):
 *   I1 the src allow-list removed (any URL fetched)         → "allow-list"
 *   I2 the Content-Length check removed                     → "Content-Length"
 *   I3 the stream cap removed (the whole body read)         → "stream"
 *   I4 uploadPhoto ignores { tooLarge } (cacheJob.test.ts)  → "stopped at the cap"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports */
const job = require("../../chrome-extension/job.js") as {
  RCS_MAX_PHOTO_BYTES: number;
  imageSrcAllowed: (src: string) => boolean;
  readImageCapped: (
    src: string,
    io: { fetch: (src: string) => Promise<unknown>; toBase64: (blob: Blob) => Promise<string>; maxBytes?: number },
  ) => Promise<{ mimeType: string; base64: string } | { tooLarge: true } | null>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const BLOB = "blob:https://messages.google.com/synthetic-image-0105";

function response(opts: { chunks: number[]; contentLength?: number; type?: string; ok?: boolean }) {
  let i = 0;
  const reads = { count: 0, cancelled: false };
  const headers = new Map<string, string>();
  if (opts.contentLength !== undefined) headers.set("content-length", String(opts.contentLength));
  headers.set("content-type", opts.type ?? "image/jpeg");
  return {
    reads,
    res: {
      ok: opts.ok ?? true,
      headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null },
      body: {
        cancel: async () => { reads.cancelled = true; },
        getReader: () => ({
          read: async () => {
            reads.count += 1;
            if (i >= opts.chunks.length) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(opts.chunks[i++]) };
          },
          cancel: async () => { reads.cancelled = true; },
        }),
      },
    },
  };
}

describe("readImage: allow-list and size cap (L2)", () => {
  it("allow-list: Messages for Web blob: URLs and googleusercontent.com only", async () => {
    expect(job.imageSrcAllowed(BLOB)).toBe(true);
    expect(job.imageSrcAllowed("https://lh3.googleusercontent.com/abc=s0")).toBe(true);
    for (const bad of [
      "https://example.com/x.png",
      "blob:https://example.com/abc",
      "http://lh3.googleusercontent.com/x",
      "https://googleusercontent.com.example.com/x",
      "data:image/png;base64,AAAA",
      "",
    ]) {
      expect([bad, job.imageSrcAllowed(bad)]).toEqual([bad, false]);
      const fetch = jest.fn();
      expect(await job.readImageCapped(bad, { fetch, toBase64: async () => "x" })).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("a Content-Length over the cap: too large, nothing read", async () => {
    const r = response({ chunks: [10], contentLength: job.RCS_MAX_PHOTO_BYTES + 1 });
    const toBase64 = jest.fn(async () => "x");
    expect(await job.readImageCapped(BLOB, { fetch: async () => r.res, toBase64 })).toEqual({ tooLarge: true });
    expect(r.reads.count).toBe(0);
    expect(toBase64).not.toHaveBeenCalled();
  });

  it("a stream that grows past the cap (no Content-Length): stopped there, too large", async () => {
    const r = response({ chunks: [60, 60, 60, 60] });
    const toBase64 = jest.fn(async () => "x");
    expect(await job.readImageCapped(BLOB, { fetch: async () => r.res, toBase64, maxBytes: 100 })).toEqual({ tooLarge: true });
    expect(r.reads.count).toBe(2);
    expect(r.reads.cancelled).toBe(true);
    expect(toBase64).not.toHaveBeenCalled();
  });

  it("under the cap: read in full, with its type; a failed response is null", async () => {
    const r = response({ chunks: [40, 40], contentLength: 80, type: "image/png; x=1" });
    const got = await job.readImageCapped(BLOB, {
      fetch: async () => r.res,
      toBase64: async (b: Blob) => `bytes:${b.size}`,
      maxBytes: 100,
    });
    expect(got).toEqual({ mimeType: "image/png", base64: "bytes:80" });
    const bad = response({ chunks: [1], ok: false });
    expect(await job.readImageCapped(BLOB, { fetch: async () => bad.res, toBase64: async () => "x" })).toBeNull();
  });
});
