/**
 * @jest-environment node
 *
 * BACKLOG-3403 — the pre-flight's categories and the 50 MB boundary, and the
 * stage-retry classifier (which answers decide "try again").
 */

jest.mock("electron", () => ({
  app: { getVersion: () => "2.39.0", getPath: () => "/user-data" },
}));

import {
  runSubmissionPreflight,
  setPreflightStatForTests,
} from "../submissionPreflight";
import { MAX_ATTACHMENT_FILE_SIZE } from "../submissionAttachmentFiles";
import {
  isTransientStageError,
  withStageRetry,
  SubmissionStageError,
} from "../submissionStageRetry";
import type { Attachment, Message } from "../../types/models";

const text = (id: string, has: number) =>
  ({ id, sent_at: "2026-09-20T10:00:00Z", has_attachments: has, direction: "inbound" }) as unknown as Message;
const email = (id: string, has: number) => ({ id, subject: `Subject ${id}`, sent_at: "2026-09-21T10:00:00Z", has_attachments: has });
// BACKLOG-3731: a text row arrives from getTransactionAttachments carrying
// `resolved_message_id` (the shared lookup's owner); the pre-flight keys on it.
const att = (id: string, owner: { message_id?: string; email_id?: string }, storage_path = `/files/${id}`) =>
  ({
    id,
    filename: `${id}.pdf`,
    storage_path,
    ...owner,
    ...(owner.message_id ? { resolved_message_id: owner.message_id } : {}),
  }) as unknown as Attachment;

afterEach(() => setPreflightStatForTests(null));

describe("BACKLOG-3403 — pre-flight categories", () => {
  /**
   * The size boundary, swept: exactly 50 MB is sent (the uploader refuses only
   * `> MAX_FILE_SIZE`), one byte more is not.
   * MUTATION: `>=` instead of `>` → the 50 MB row flips.
   */
  it.each([
    [MAX_ATTACHMENT_FILE_SIZE - 1, true],
    [MAX_ATTACHMENT_FILE_SIZE, true],
    [MAX_ATTACHMENT_FILE_SIZE + 1, false],
  ])("a %d-byte file is sendable: %s", async (size, sendable) => {
    setPreflightStatForTests(async () => ({ size }));
    const r = await runSubmissionPreflight({
      messages: [],
      emails: [email("e1", 1)],
      attachments: [att("a1", { email_id: "e1" })],
      undownloadedEmailAttachments: [],
      textLabel: () => "",
    });
    expect(r.sendable.map((a) => a.id)).toEqual(sendable ? ["a1"] : []);
    expect(r.notIncluded.map((i) => i.reason)).toEqual(sendable ? [] : ["file_too_large"]);
  });

  it("each reason from its own producer, keyed so the submit can match the agent's confirmation", async () => {
    setPreflightStatForTests(async (p) => (p.endsWith("gone") ? null : { size: 10 }));
    const r = await runSubmissionPreflight({
      messages: [text("t-flagged-no-row", 1), text("t-ok", 1), text("t-plain", 0)],
      emails: [email("e-undl", 1), email("e-norow", 1), email("e-ok", 1)],
      attachments: [
        att("a-t-ok", { message_id: "t-ok" }),
        att("a-e-ok", { email_id: "e-ok" }),
        att("a-gone", { email_id: "e-ok" }, "/files/gone"),
      ],
      undownloadedEmailAttachments: [{ id: "a-undl", email_id: "e-undl", filename: "Contract.pdf" }],
      textLabel: () => "Jane",
    });
    expect(r.sendable.map((a) => a.id).sort()).toEqual(["a-e-ok", "a-t-ok"]);
    expect(r.notIncluded.map((i) => [i.key, i.reason]).sort()).toEqual([
      ["att:a-gone", "file_missing_on_this_computer"],
      ["att:a-undl", "email_attachment_not_downloaded"],
      ["email:e-norow", "email_attachment_not_downloaded"],
      ["msg:t-flagged-no-row", "text_attachment_not_on_this_computer"],
    ]);
    expect(r.sizeById.get("a-t-ok")).toBe(10);
  });

  it("an undownloaded row of an email OUTSIDE the window is not listed", async () => {
    const r = await runSubmissionPreflight({
      messages: [],
      emails: [],
      attachments: [],
      undownloadedEmailAttachments: [{ id: "a-x", email_id: "e-out", filename: "x.pdf" }],
      textLabel: () => "",
    });
    expect(r.notIncluded).toEqual([]);
  });
});

describe("BACKLOG-3403 — which failures are retried", () => {
  it.each([
    [{ code: "", message: "TypeError: fetch failed" }, true],
    [{ message: "socket hang up" }, true],
    [{ status: 503, message: "Service Unavailable" }, true],
    [{ status: 429, message: "Too Many Requests" }, true],
    [{ statusCode: "504", message: "Gateway Timeout" }, true],
    [{ code: "42501", message: "rls" }, false],
    [{ code: "23505", message: "duplicate" }, false],
    [{ code: "23503", message: "fk" }, false],
    [{ code: "22P02", message: "bad uuid" }, false],
    [{ code: "PGRST202", message: "no function" }, false],
    [{ code: "PGRST116", message: "no rows" }, false],
    [{ status: 403, message: "forbidden" }, false],
    [{ status: 400, statusCode: "409", message: "already exists" }, false],
  ])("%j → transient %s", (err, transient) => {
    expect(isTransientStageError(err)).toBe(transient);
  });

  it("3 attempts on a transient error, then a stage error carrying the code", async () => {
    let n = 0;
    const sleep = jest.fn(async (_ms: number) => undefined);
    await expect(
      withStageRetry("messages", async () => ((n += 1), { data: null, error: { status: 503 } }), { sleep })
    ).rejects.toMatchObject({ stage: "messages", transient: true, attempts: 3, code: "503" });
    expect(n).toBe(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it("a permanent error stops at once", async () => {
    let n = 0;
    const err = await withStageRetry("parent", async () => ((n += 1), { data: null, error: { code: "23505", message: "dup" } })).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionStageError);
    expect(err).toMatchObject({ transient: false, attempts: 1, code: "23505", driverMessage: "dup" });
    expect(err.message).not.toMatch(/dup/);
    expect(n).toBe(1);
  });
});
