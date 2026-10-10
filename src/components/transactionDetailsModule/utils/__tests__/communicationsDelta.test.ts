/**
 * BACKLOG-3785 — merging a communications delta into the held list must give
 * what a full reload gives: other channel untouched and first, this channel's
 * removed ids gone, added rows present once, newest first by sent_at.
 */
import { mergeCommunicationsDelta } from "../communicationsDelta";

type Row = { id: string; channel: string; sent_at?: string | null };
const isText = (r: Row) => r.channel === "sms";
const ids = (rows: Row[]) => rows.map((r) => r.id);

const email1: Row = { id: "e1", channel: "email", sent_at: "2024-05-01T00:00:00Z" };
const t3: Row = { id: "t3", channel: "sms", sent_at: "2024-03-01T00:00:00Z" };
const t2: Row = { id: "t2", channel: "sms", sent_at: "2024-02-01T00:00:00Z" };
const t1: Row = { id: "t1", channel: "sms", sent_at: "2024-01-01T00:00:00Z" };

describe("mergeCommunicationsDelta (BACKLOG-3785)", () => {
  it("interleaves added rows newest first and keeps the other channel first", () => {
    const added: Row[] = [
      { id: "n4", channel: "sms", sent_at: "2024-04-01T00:00:00Z" },
      { id: "n2b", channel: "sms", sent_at: "2024-02-15T00:00:00Z" },
      { id: "n0", channel: "sms", sent_at: "2023-12-01T00:00:00Z" },
    ];
    const out = mergeCommunicationsDelta([email1, t3, t2, t1], isText, added, []);
    expect(ids(out)).toEqual(["e1", "n4", "t3", "n2b", "t2", "t1", "n0"]);
  });

  it("drops removed ids of this channel only", () => {
    const emailSameId: Row = { id: "t2", channel: "email", sent_at: null };
    const out = mergeCommunicationsDelta([emailSameId, t3, t2, t1], isText, [], ["t2"]);
    expect(ids(out)).toEqual(["t2", "t3", "t1"]);
    expect(out[0].channel).toBe("email");
  });

  it("never adds a row whose id is already held, in any channel", () => {
    const unknownHeld: Row = { id: "u1", channel: "unknown", sent_at: null };
    const out = mergeCommunicationsDelta(
      [unknownHeld, t2],
      isText,
      [
        { id: "u1", channel: "unknown", sent_at: null },
        { id: "t2", channel: "sms", sent_at: t2.sent_at },
        { id: "n9", channel: "sms", sent_at: "2024-02-01T00:00:00Z" },
        { id: "n9", channel: "sms", sent_at: "2024-02-01T00:00:00Z" },
      ],
      [],
    );
    expect(ids(out)).toEqual(["u1", "t2", "n9"]);
  });

  it("orders missing dates last, as ORDER BY sent_at DESC does", () => {
    const out = mergeCommunicationsDelta(
      [t2, { id: "tnull", channel: "sms", sent_at: null }],
      isText,
      [{ id: "nnull", channel: "sms", sent_at: null }, { id: "n1", channel: "sms", sent_at: "2024-01-15T00:00:00Z" }].sort(
        (a, b) => (a.sent_at ? -1 : 1) - (b.sent_at ? -1 : 1),
      ),
      [],
    );
    expect(ids(out)).toEqual(["t2", "n1", "tnull", "nnull"]);
  });

  it("an empty delta returns the same ids in the same order", () => {
    const prev = [email1, t3, t2, t1];
    expect(ids(mergeCommunicationsDelta(prev, isText, [], []))).toEqual(ids(prev));
  });
});
