/**
 * BACKLOG-3892 S1 — iPhone parse floors (no Keepr database, no preferences).
 *
 * An iPhone sync reads only the texts lookback window, except that a chat with a
 * live deal's contact (or one already linked to a live deal) is read back to that
 * deal's audit start minus COVERAGE_TOLERANCE_MS — the Google Messages per-chat
 * model (rcsCacheService.chatFloorDecision), applied at parse time.
 *
 * The plan is built in syncHandlers (iphoneChatFloorPlan.ts) and handed to the
 * orchestrator in SyncOptions.floorPlan; the orchestrator reads no preferences.
 *
 * GATED: IPHONE_PARSE_FLOORS_ENABLED is false until S2 (coverage) lands. With it
 * off no plan is built and the sync reads every chat in full, exactly as before.
 * S1 must not reach a tester without S2 (SR plan review, D1-D6).
 */
import { toE164 } from "../utils/phoneNormalization";
import { appleDateKeptByFloor, floorBinds } from "./db/appleSmsDbSql";
import type { iOSConversation, iOSMessage } from "../types/iosMessages";

/**
 * BACKLOG-3892: S2 flips this to true, together with the coverage rows that stop
 * an iPhone source from reading "covered" off MIN(sent_at). Until then a floored
 * sync could report false coverage, so the floor stays off.
 */
export const IPHONE_PARSE_FLOORS_ENABLED = false;

/** Where the run's floors came from (timeline; counts only). */
export type FloorSource = "none" | "all-time" | "settings" | "settings+deals";

export interface ChatFloorPlan {
  /** The lookback setting's floor (epoch ms); null = "All time" = no floor at all. */
  settingsFloorMs: number | null;
  /** handle key (see handleKeys) -> earliest live-deal floor (deal start − 24 h), epoch ms. */
  handleFloors: ReadonlyMap<string, number>;
  /** sms.db chat ROWID -> earliest floor of a live deal its thread is linked to. */
  linkedChatFloors: ReadonlyMap<number, number>;
}

export function floorSourceOf(plan: ChatFloorPlan | undefined): FloorSource {
  if (!plan) return "none";
  if (plan.settingsFloorMs === null) return "all-time";
  return plan.handleFloors.size > 0 || plan.linkedChatFloors.size > 0 ? "settings+deals" : "settings";
}

/**
 * The keys one handle is matched under. Emails: lowercased. Phones: E.164 and the
 * last 10 digits, so a handle that is not stored in E.164 still matches. A wider
 * match can only widen a chat (store more), never narrow one.
 */
export function handleKeys(raw: string | null | undefined): string[] {
  const v = (raw ?? "").trim();
  if (!v) return [];
  if (v.includes("@")) return [v.toLowerCase()];
  const keys = new Set<string>();
  const e164 = toE164(v);
  if (e164) keys.add(e164);
  const digits = v.replace(/\D/g, "");
  if (digits.length >= 10) keys.add(`d:${digits.slice(-10)}`);
  return [...keys];
}

/** The earliest deal floor of any of these handles; null = none of them is a deal contact. */
export function dealFloorForHandles(plan: ChatFloorPlan, handles: Iterable<string>): number | null {
  let min: number | null = null;
  for (const h of handles) {
    for (const k of handleKeys(h)) {
      const f = plan.handleFloors.get(k);
      if (f !== undefined && (min === null || f < min)) min = f;
    }
  }
  return min;
}

export interface ChatFloorInput {
  chatId: number;
  /** Current members (chat_handle_join) and, for a 1:1 chat, its identifier. */
  handles: readonly string[];
  /** Every handle that sent a message in the chat (D7d), when read; null = not read. */
  senderHandles?: readonly string[] | null;
}

/**
 * One chat's floor (epoch ms), or null = read the whole chat.
 *  - no plan, or "All time" → null;
 *  - otherwise the earliest of: the settings floor, the floor of any live deal one
 *    of its handles (members, identifier, senders) belongs to, and the floor of a
 *    live deal its thread is linked to. A deal later than the settings floor never
 *    narrows the chat. A group takes the minimum over all its people.
 */
export function chatFloorMs(plan: ChatFloorPlan | undefined, chat: ChatFloorInput): number | null {
  if (!plan || plan.settingsFloorMs === null) return null;
  let floor = plan.settingsFloorMs;
  const byHandle = dealFloorForHandles(plan, chat.handles);
  if (byHandle !== null && byHandle < floor) floor = byHandle;
  if (chat.senderHandles) {
    const bySender = dealFloorForHandles(plan, chat.senderHandles);
    if (bySender !== null && bySender < floor) floor = bySender;
  }
  const linked = plan.linkedChatFloors.get(chat.chatId);
  if (linked !== undefined && linked < floor) floor = linked;
  return floor;
}

/** Counts a floored parse reports (timeline + SyncResult); no content. */
export interface ParseFloorReport {
  floorSource: FloorSource;
  settingsFloorMs: number | null;
  /** Chats whose newest text is older than their floor: not read at all. */
  chatsSkippedOld: number;
  /** Chats read back further than the settings floor (a deal chat). */
  chatsWidened: number;
  /** Texts not read because they are older than their chat's floor. */
  messagesBelowFloor: number;
}

/** The parser reads a floored chat needs (iOSMessagesParser satisfies it). */
export interface FloorParser {
  getMessagesAsync(chatId: number, limit?: number, offset?: number, sinceMs?: number): Promise<iOSMessage[]>;
  getMessageCount(chatId: number): number;
  getChatSenderHandles(chatId: number): string[] | null;
}

/**
 * One chat's parse floor under `plan` (epoch ms), or null = read the whole chat.
 * A chat whose people or senders could not be read gets NO floor (SR D5): a
 * missing deal contact must never narrow a deal chat.
 */
export function chatParseFloor(parser: FloorParser, plan: ChatFloorPlan, conv: iOSConversation): number | null {
  if (plan.settingsFloorMs === null || conv.participantsReadFailed) return null;
  const handles = [...conv.participants];
  // A 1:1 chat's identifier is the other person's handle (a group's is "chat…").
  if (conv.chatIdentifier && (!conv.chatIdentifier.startsWith("chat") || conv.chatIdentifier.includes("@"))) {
    handles.push(conv.chatIdentifier);
  }
  let senderHandles: string[] | null = null;
  if (plan.handleFloors.size > 0) {
    // D7d: members who left a group still sent messages in it.
    senderHandles = parser.getChatSenderHandles(conv.chatId);
    if (senderHandles === null) return null;
  }
  return chatFloorMs(plan, { chatId: conv.chatId, handles, senderHandles });
}

/**
 * Load one chat's messages under the plan (the sync's parse loop). A chat whose
 * newest text is older than its floor is not read ("skipped"); otherwise only
 * texts at or after its floor are read (undated texts are kept). Counts go into
 * `report`.
 */
export async function readChatWithFloor(
  parser: FloorParser,
  plan: ChatFloorPlan,
  conv: iOSConversation,
  report: ParseFloorReport,
): Promise<"read" | "skipped"> {
  const floor = chatParseFloor(parser, plan, conv);
  if (floor === null) {
    conv.messages = await parser.getMessagesAsync(conv.chatId);
    return "read";
  }
  if (!appleDateKeptByFloor(conv.lastDateRaw, floorBinds(floor))) {
    conv.messages = [];
    report.chatsSkippedOld++;
    report.messagesBelowFloor += parser.getMessageCount(conv.chatId);
    return "skipped";
  }
  conv.messages = await parser.getMessagesAsync(conv.chatId, undefined, undefined, floor);
  if (plan.settingsFloorMs !== null && floor < plan.settingsFloorMs) report.chatsWidened++;
  const below = parser.getMessageCount(conv.chatId) - conv.messages.length;
  if (below > 0) report.messagesBelowFloor += below;
  return "read";
}
