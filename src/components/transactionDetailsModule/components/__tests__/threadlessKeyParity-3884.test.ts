/**
 * BACKLOG-3884 (SR B4): main groups thread-less texts per person with
 * electron/services/db/threadlessTextKey.ts; the tab always grouped them with
 * MessageThreadCard's getThreadKey (through groupMessagesByThread). The two must
 * agree, boundaries included (10-digit cut, +1 prefix, case, "me", malformed JSON,
 * no participants at all).
 */
import { groupMessagesByThread, type MessageLike } from "../MessageThreadCard";
import { threadlessGroupKey } from "../../../../../electron/services/db/threadlessTextKey";

const corpus: Array<{ id: string; participants: unknown }> = [
  { id: "a", participants: JSON.stringify({ from: "+12065550101", to: ["me"] }) },
  { id: "b", participants: JSON.stringify({ from: "me", to: ["+1 (206) 555-0101"] }) },
  { id: "c", participants: JSON.stringify({ from: "2065550101", to: "me" }) },
  { id: "m", participants: JSON.stringify({ from: "(206) 555-0101", to: ["me"] }) }, // exactly 10 digits, punctuated
  { id: "d", participants: JSON.stringify({ from: "555-0101", to: ["me"] }) }, // 7 digits: kept as text
  { id: "e", participants: JSON.stringify({ from: "Agent@Example.TEST ", to: ["me"] }) },
  { id: "f", participants: JSON.stringify({ from: "me", to: ["+12065550102", "+12065550103"] }) },
  { id: "g", participants: JSON.stringify({ from: "+12065550103", to: ["+12065550102", "me"] }) },
  { id: "h", participants: JSON.stringify({ from: "me", to: [] }) },
  { id: "i", participants: "{not json" },
  { id: "j", participants: null },
  { id: "k", participants: JSON.stringify({ from: "123456789", to: ["me"] }) }, // 9 digits
  { id: "l", participants: JSON.stringify({ from: "+4420795501010", to: ["me"] }) }, // >10 digits
];

describe("thread-less conversation key: main equals the tab (BACKLOG-3884)", () => {
  it("every corpus row lands in the same group on both sides", () => {
    const messages = corpus.map((c) => ({ id: c.id, thread_id: null, participants: c.participants })) as unknown as MessageLike[];
    const tab = groupMessagesByThread(messages);
    const tabKeyOf = new Map<string, string>();
    for (const [key, msgs] of tab) for (const m of msgs) tabKeyOf.set(m.id as string, key);
    for (const c of corpus) expect({ id: c.id, key: threadlessGroupKey(c.participants, c.id) }).toEqual({ id: c.id, key: tabKeyOf.get(c.id) });
    // The corpus really separates people: a, b, c, m are one person; f, g are one group; h, i, j fall back to their own ids.
    expect(new Set(corpus.map((c) => threadlessGroupKey(c.participants, c.id))).size).toBe(9);
  });
});
