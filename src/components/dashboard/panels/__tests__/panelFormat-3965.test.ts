/**
 * BACKLOG-3965 PR-4b: the Dashboard panels' date and count helpers.
 *
 * C15 (SR 5e): the closing-date badge at 0 days, 1 day, past, 14 / 15 days,
 * no date, and the local-midnight boundary. `daysUntilClosing` compares
 * calendar components only, so these assertions hold on any runner.
 *
 * opened_at: written as ISO 8601 UTC by `new Date().toISOString()`
 * (electron/handlers/transactionOpenHandlers.ts:59). Instants are compared
 * absolutely. NOTE: an end-to-end "parsed as local" check is blind on a UTC
 * runner (BACKLOG-2632), so the normalisation assertion below is the one that
 * reds there; the instant assertions red off UTC (e.g. the founder's UTC-6).
 */
import {
  closingBadge,
  daysUntilClosing,
  localDay,
  openedAgo,
  parseOpenedAt,
  requiredProgressText,
} from "../panelFormat";
import * as dateFormatters from "../../../../utils/dateFormatters";
import { normalizeDbTimestamp } from "../../../../utils/dateFormatters";

describe("daysUntilClosing / closingBadge (C15)", () => {
  const today = "2026-10-31";

  it.each([
    ["2026-10-31", 0, "Today", "danger"],
    ["2026-11-01", 1, "1 d", "danger"],
    ["2026-10-30", -1, "Overdue", "danger"],
    ["2026-11-14", 14, "14 d", "danger"],
    ["2026-11-15", 15, "15 d", "warning"],
    ["2026-11-28", 28, "28 d", "warning"],
  ])("closing %s -> %i days -> %s (%s)", (deadline, days, label, tone) => {
    expect(daysUntilClosing(deadline, today)).toBe(days);
    expect(closingBadge(daysUntilClosing(deadline, today))).toEqual({ label, tone });
  });

  it("no closing date -> no badge", () => {
    expect(daysUntilClosing(null, today)).toBeNull();
    expect(daysUntilClosing("", today)).toBeNull();
    expect(closingBadge(null)).toBeNull();
  });

  it("a stored ISO timestamp is read by its first 10 characters (PR-3's ORDER BY rule)", () => {
    expect(daysUntilClosing("2026-11-01T00:00:00.000Z", today)).toBe(1);
  });

  it("crosses a month and a DST change without drifting", () => {
    expect(daysUntilClosing("2026-11-02", today)).toBe(2); // US DST ends 2026-11-01
    expect(daysUntilClosing("2027-03-15", "2027-03-13")).toBe(2); // US DST starts 2027-03-14
  });

  it("'today' is the LOCAL day: 23:30 local on the 31st is still the 31st", () => {
    const lateEvening = new Date(2026, 9, 31, 23, 30); // local constructor
    const justAfterMidnight = new Date(2026, 10, 1, 0, 5);
    expect(localDay(lateEvening)).toBe("2026-10-31");
    expect(localDay(justAfterMidnight)).toBe("2026-11-01");
    expect(closingBadge(daysUntilClosing("2026-10-31", localDay(lateEvening)))?.label).toBe("Today");
    expect(closingBadge(daysUntilClosing("2026-10-31", localDay(justAfterMidnight)))?.label).toBe("Overdue");
    expect(closingBadge(daysUntilClosing("2026-11-01", localDay(lateEvening)))?.label).toBe("1 d");
  });

  it("'today' reads the local calendar fields, not the UTC ones (any runner)", () => {
    // 23:30 on Oct 31 at UTC-6 is 05:30 UTC on Nov 1. A stub keeps the two
    // apart even on a UTC runner, where a real Date cannot.
    const stub = {
      getFullYear: () => 2026,
      getMonth: () => 9,
      getDate: () => 31,
      getUTCFullYear: () => 2026,
      getUTCMonth: () => 10,
      getUTCDate: () => 1,
    } as unknown as Date;
    expect(localDay(stub)).toBe("2026-10-31");
  });
});

describe("opened_at is ISO UTC, never local time", () => {
  const producerShape = "2026-10-31T10:00:00.000Z"; // new Date().toISOString()

  it("the producer's shape names the same instant", () => {
    expect(parseOpenedAt(producerShape)?.toISOString()).toBe(producerShape);
  });

  it("a zone-less value is read as UTC (string step: reds on any runner)", () => {
    expect(normalizeDbTimestamp("2026-10-31 10:00:00")).toBe("2026-10-31T10:00:00.000Z");
    expect(parseOpenedAt("2026-10-31 10:00:00")?.toISOString()).toBe(producerShape);
  });

  it.each([
    ["2026-10-31T10:00:30.000Z", "Just now"],
    ["2026-10-31T09:55:00.000Z", "5m ago"],
    ["2026-10-31T08:00:00.000Z", "2h ago"],
    ["2026-10-30T09:00:00.000Z", "Yesterday"],
    ["2026-10-28T10:00:00.000Z", "3d ago"],
  ])("%s -> %s at 10:00:59Z", (openedAt, expected) => {
    expect(openedAgo(openedAt, new Date("2026-10-31T10:00:59.000Z"))).toBe(expected);
  });

  it("goes through parseDbTimestamp, the UTC-safe parser (reds on any runner)", () => {
    const spy = jest.spyOn(dateFormatters, "parseDbTimestamp");
    parseOpenedAt(producerShape);
    expect(spy).toHaveBeenCalledWith(producerShape);
    spy.mockRestore();
  });

  it("unparseable -> empty text, never 'NaN'", () => {
    expect(openedAgo("not a date", new Date())).toBe("");
  });
});

describe("requiredProgressText", () => {
  it.each([
    [3, 5, "3 of 5"],
    [0, 5, "0 of 5"],
    [0, 0, "No required items"],
  ])("%i/%i -> %s", (done, total, text) => {
    expect(requiredProgressText(done, total)).toBe(text);
  });
});
