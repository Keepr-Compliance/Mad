/**
 * Zod schemas for the Google Messages extension bridge — SR clean-up C5
 * (CASA hardening). BACKLOG-3619.
 *
 * A bridge body comes from OUTSIDE the app (a local HTTP request), so one that
 * does not parse is REFUSED (400) — unlike the IPC `validate.ts`, which warns
 * and continues. Each schema types the fields the bridge reads, with bounds;
 * fields it does not read are allowed through untouched (looseObject), so a
 * newer extension that adds a field is not refused. Counts may be null (the
 * extension sends null for "unknown").
 *
 * The deeper parsers (parseIncomingChat: each message; parseNotReached) still
 * normalise what passes.
 */
import { z } from "zod/v4";

const id = z.string().min(1).max(200);
const count = z.number().finite().min(0).nullish();
const text = (max: number) => z.string().max(max).nullish();
const anyObject = z.looseObject({}).nullish();

/**
 * BACKLOG-3668 M3: at most this many messages in one /chat POST. The page
 * sends a chat in one POST and reads at most ~2,000 messages of it (scan.js
 * loadHistory cap, plus what is on screen), so a real Sync stays well under.
 */
export const RCS_MAX_MESSAGES_PER_POST = 5_000;

export const RcsBridgeBodySchemas = {
  claim: z.looseObject({}),
  cancel: z.looseObject({}),
  match: z.looseObject({
    conversationId: id,
    numbers: z.array(z.string().max(100)).max(500),
  }),
  chat: z.looseObject({
    conversationId: id,
    title: text(2000),
    messages: z.array(z.looseObject({})).max(RCS_MAX_MESSAGES_PER_POST),
  }),
  attachment: z.looseObject({
    conversationId: id,
    msgId: id,
    index: z.number().int().min(0).max(99),
    mimeType: z.string().min(1).max(100),
    base64: z.string().min(1),
  }),
  progress: z.looseObject({
    stage: text(1000),
    listed: count,
    candidates: count,
    checked: count,
    skipped: count,
    notChecked: count,
    historyLoaded: count,
  }),
  finish: z.looseObject({
    notReached: z.array(z.unknown()).max(10_000).nullish(),
    notReachedMore: count,
    notChecked: count,
    notText: count,
    noMessagesYet: count,
    listStop: text(100),
    phoneDisconnected: z.boolean().nullish(),
    media: anyObject,
    hidden: anyObject,
    metrics: anyObject,
  }),
  error: z.looseObject({
    code: text(200),
    message: text(2000),
    metrics: anyObject,
  }),
} as const;

export type RcsBridgeJobAction = keyof typeof RcsBridgeBodySchemas;

/** /hello (unsigned or signed). */
export const RcsHelloBodySchema = z.looseObject({
  version: text(100),
  paired: z.boolean().nullish(),
  linked: z.boolean().nullish(),
});

/** /link/start | /link/poll | /link/finish. */
export const RcsLinkBodySchemas = {
  "/link/start": z.looseObject({ pA: z.string().min(1).max(200) }),
  "/link/poll": z.looseObject({ sessionId: z.string().min(1).max(200) }),
  "/link/finish": z.looseObject({ sessionId: z.string().min(1).max(200), cA: z.string().min(1).max(200), nonce: text(200) }),
} as const;

/** /exclusions/set ({} for /exclusions/list). */
export const RcsExclusionSetBodySchema = z.looseObject({
  conversationId: id,
  excluded: z.boolean(),
});

/** Parse a bridge body: the parsed object, or null (→ 400). A non-object (array, string, null) never passes. */
export function parseBridgeBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const r = schema.safeParse(body);
  return r.success ? r.data : null;
}
