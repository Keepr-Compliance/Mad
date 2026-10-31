/**
 * BACKLOG-3968 U2: the texts the checklist link picker offers, and the contact
 * name a text chip shows.
 *
 * Data path (SR plan review R10): the deal's conversation list
 * (`transactions:get-text-threads`, no texts) gives the thread keys; the PAGED
 * text reader (`transactions:get-text-thread-page`) gives the texts, newest
 * first, a page at a time. Each row's `id` is `messages.id` — the id the
 * checklist writer takes for a text member. Never `thread_id`, never the
 * communication id, never a full load of the deal's texts.
 *
 * Only this deal's texts: both reads are scoped to `transactionId` in main
 * (LINKED_TEXTS_FROM: `c.transaction_id = ?`). All history, not the audit
 * window: the writer accepts any text on the deal, and the submit pre-flight
 * says when one is not sent.
 *
 * The contact name and the snippet stay in the renderer. Linking sends the
 * item id and the message ids only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Communication } from "../types";
import type { ChecklistLink } from "../../../../electron/types/checklist";
import type { TextPageCursor, TextThreadSummary } from "@electron/types/textThreads";
import { transactionService } from "../../../services/transactionService";
import { contactService } from "../../../services/contactService";
import { extractAllHandles, normalizePhoneForLookup } from "../../../utils/phoneNormalization";
import logger from "../../../utils/logger";

/** Texts asked for per page in the picker (main caps it too). */
export const PICKER_TEXT_PAGE_SIZE = 50;
/** The paged reader takes at most 200 conversation keys per call (validateThreadKeys). */
export const PICKER_MAX_THREADS = 200;
const SNIPPET_MAX = 80;

/** One text the picker offers. */
export interface PickerText {
  /** `messages.id` — what the writer stores. */
  id: string;
  name: string;
  sentAt: string | null;
  snippet: string;
}

type Names = Record<string, string>;

/** Every handle-to-name pair, also under its normalized key (as the Texts tab does). */
function withNormalizedKeys(names: Names): Names {
  const out: Names = {};
  for (const [handle, name] of Object.entries(names)) {
    out[handle] = name;
    out[normalizePhoneForLookup(handle)] = name;
  }
  return out;
}

function parseParticipants(raw: unknown): { from?: unknown; to?: unknown; chat_members?: unknown } {
  if (!raw) return {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The other people on a text (never "me"), in a stable order. */
export function otherParties(row: Pick<Communication, "participants" | "direction">): string[] {
  const p = parseParticipants(row.participants);
  const out = new Set<string>();
  const add = (h: unknown) => {
    if (typeof h === "string" && h.trim() && h !== "me" && h !== "unknown") out.add(h);
  };
  if (Array.isArray(p.chat_members)) p.chat_members.forEach(add);
  if (row.direction === "inbound") add(p.from);
  else (Array.isArray(p.to) ? p.to : [p.to]).forEach(add);
  return [...out];
}

/** The conversation's name: the group's own name, else its people (3 at most). */
export function textName(
  row: Pick<Communication, "participants" | "direction"> & { thread_display_name?: string | null },
  names: Names,
): string {
  const group = typeof row.thread_display_name === "string" ? row.thread_display_name.trim() : "";
  if (group) return group;
  const people = [
    ...new Set(otherParties(row).map((h) => names[h] ?? names[normalizePhoneForLookup(h)] ?? h)),
  ];
  if (people.length === 0) return "Unknown";
  return people.length <= 3 ? people.join(", ") : `${people.slice(0, 3).join(", ")} +${people.length - 3}`;
}

/** One line of the text's body, cut to a short length. */
export function textSnippet(row: Pick<Communication, "body_text" | "body_plain">): string {
  const body = (row.body_text ?? row.body_plain ?? "").replace(/\s+/g, " ").trim();
  return body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX - 1)}…` : body;
}

async function resolveNames(rows: Communication[], userId: string | undefined, transactionId: string): Promise<Names> {
  const handles = extractAllHandles(rows);
  if (handles.length === 0) return {};
  return withNormalizedKeys(await contactService.resolveHandles(handles, userId, transactionId));
}

/** The keys of this deal's conversations, most recent first, at most PICKER_MAX_THREADS. */
function threadKeysOf(threads: TextThreadSummary[]): string[] {
  return [...threads]
    .sort((a, b) => (b.lastSentAt ?? "").localeCompare(a.lastSentAt ?? ""))
    .slice(0, PICKER_MAX_THREADS)
    .map((t) => t.threadId);
}

export interface UsePickerTextsResult {
  texts: PickerText[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Conversations left out because the deal has more than PICKER_MAX_THREADS. */
  threadsLeftOut: number;
}

/**
 * The picker's texts. Reads nothing until `enabled` (the Texts tab was opened),
 * then the first page; `loadMore` appends the next.
 */
export function usePickerTexts(
  transactionId: string,
  userId: string | undefined,
  enabled: boolean,
): UsePickerTextsResult {
  const [texts, setTexts] = useState<PickerText[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<TextPageCursor | null>(null);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [threadsLeftOut, setThreadsLeftOut] = useState(0);
  const namesRef = useRef<Names>({});
  const seqRef = useRef(0);

  const readPage = useCallback(
    async (threadKeys: string[], from: TextPageCursor | null, seq: number): Promise<void> => {
      const r = await transactionService.getTextThreadPage(transactionId, threadKeys, null, from, PICKER_TEXT_PAGE_SIZE);
      if (seq !== seqRef.current) return;
      if (!r.success) {
        setError("Couldn't load texts.");
        return;
      }
      const rows = r.rows ?? [];
      const names = { ...namesRef.current, ...(await resolveNames(rows, userId, transactionId)) };
      if (seq !== seqRef.current) return;
      namesRef.current = names;
      const page = rows.map((row) => ({
        id: row.id,
        name: textName(row, names),
        sentAt: row.sent_at ? String(row.sent_at) : null,
        snippet: textSnippet(row),
      }));
      setTexts((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...page.filter((t) => !seen.has(t.id))];
      });
      setCursor(r.nextCursor ?? null);
      setError(null);
    },
    [transactionId, userId],
  );

  useEffect(() => {
    if (!enabled) return;
    const seq = ++seqRef.current;
    setTexts([]);
    setCursor(null);
    setKeys(null);
    setLoading(true);
    void (async () => {
      try {
        const r = await transactionService.getTextThreads(transactionId, null);
        if (seq !== seqRef.current) return;
        if (!r.success) {
          setError("Couldn't load texts.");
          return;
        }
        const threads = r.threads ?? [];
        const k = threadKeysOf(threads);
        setKeys(k);
        setThreadsLeftOut(Math.max(0, threads.length - k.length));
        if (k.length > 0) await readPage(k, null, seq);
      } catch (err) {
        if (seq !== seqRef.current) return;
        logger.error("Loading texts for the checklist picker failed:", err);
        setError("Couldn't load texts.");
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    })();
    return () => {
      seqRef.current += 1;
    };
  }, [enabled, transactionId, readPage]);

  const loadMore = useCallback(async () => {
    if (!keys || !cursor || loading) return;
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      await readPage(keys, cursor, seq);
    } catch (err) {
      if (seq === seqRef.current) setError("Couldn't load texts.");
      logger.error("Loading more texts for the checklist picker failed:", err);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [keys, cursor, loading, readPage]);

  return { texts, loading, error, hasMore: cursor !== null, loadMore, threadsLeftOut };
}

/** The member a text chip names and opens: its first text still on the deal. */
export function textChipMessageId(link: ChecklistLink): string | null {
  if (link.kind !== "text") return null;
  const live = link.members.find((m) => m.inTransaction && m.messageId);
  return live?.messageId ?? null;
}

/**
 * BACKLOG-3968 U2: the contact name for each text chip, keyed by the
 * `messages.id` the chip names (`textChipMessageId`). Main stores only
 * "Text · <date>"; the name is looked up here, from the conversation list's
 * header rows, the way the Texts tab names a conversation.
 */
export function useChecklistTextNames(
  transactionId: string | undefined,
  userId: string | undefined,
  links: readonly ChecklistLink[],
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const ids = [...new Set(links.map(textChipMessageId).filter((id): id is string => !!id))].sort();
  const idsKey = ids.join(",");

  useEffect(() => {
    if (!transactionId || ids.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const threads = await transactionService.getTextThreads(transactionId, null);
        if (cancelled || !threads.success) return;
        const byKey = new Map((threads.threads ?? []).map((t) => [t.threadId, t]));
        const samplesById = new Map<string, Communication[]>();
        for (const id of ids) {
          const key = await transactionService.findTextThread(transactionId, id);
          const summary = key ? byKey.get(key) : undefined;
          if (summary && summary.samples.length > 0) samplesById.set(id, summary.samples);
        }
        if (cancelled || samplesById.size === 0) return;
        const resolved = await resolveNames([...samplesById.values()].flat(), userId, transactionId);
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const [id, samples] of samplesById) {
          const name = textName(samples[0], resolved);
          if (name !== "Unknown") next.set(id, name);
        }
        setNames(next);
      } catch (err) {
        logger.error("Naming checklist text links failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // idsKey stands for ids.
  }, [transactionId, userId, idsKey]);

  return names;
}
