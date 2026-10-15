/**
 * BACKLOG-3156 stage G — the "Stored on this computer" block of each messages pane.
 *
 * The payload shape is transcribed from the producer: `readMessageSourceStatsOn`
 * (electron/services/db/messageSourceStatsDb.ts) returns
 * { macos, iphone, google } each { texts, chats, oldest: ISO | null }, which the
 * `messages:get-source-stats` handler passes through as `stats`.
 *
 * Mutations: a pane reading another source's key; an unreadable count shown as
 * 0; the footnotes reworded → red.
 */
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MessagesStoredBlock, STORED_FOOTNOTE, STATS_RETRY_MS, formatOldest } from "../MessagesStoredBlock";

const STATS = {
  macos: { texts: 12480, chats: 214, oldest: "2016-03-14T10:00:00.000Z" },
  iphone: { texts: 8915, chats: 141, oldest: "2019-06-02T10:00:00.000Z" },
  google: { texts: 3206, chats: 57, oldest: "2024-08-20T10:00:00.000Z" },
};

const getSourceStats = jest.fn();
beforeEach(() => {
  getSourceStats.mockReset();
  (window.api.messages as unknown as { getSourceStats: jest.Mock }).getSourceStats = getSourceStats;
});

const cells = (testId: string) =>
  ["texts", "chats", "oldest"].map((k) => within(screen.getByTestId(`${testId}-${k}`)).getAllByText(/./)[0].textContent);

it.each([
  ["macos", ["12,480", "214", "Mar 2016"]],
  ["iphone", ["8,915", "141", "Jun 2019"]],
  ["google", ["3,206", "57", "Aug 2024"]],
] as const)("%s pane shows its own source's texts, chats and oldest text", async (source, expected) => {
  getSourceStats.mockResolvedValue({ success: true, stats: STATS });
  render(<MessagesStoredBlock userId="u-1" source={source} testId="blk" />);
  await waitFor(() => expect(cells("blk")).toEqual([...expected]));
  expect(getSourceStats).toHaveBeenCalledWith("u-1");
  expect(screen.getByTestId("blk")).toHaveTextContent(STORED_FOOTNOTE[source]);
});

it("the mock's footnotes, word for word", () => {
  expect(STORED_FOOTNOTE).toEqual({
    macos: "Counts are texts imported from macOS Messages.",
    iphone: "Counts are texts imported from iPhone.",
    google: "Counts are texts copied from Google Messages.",
  });
});

it("an unreadable count shows dashes, never zeros", async () => {
  getSourceStats.mockResolvedValue({ success: false, error: "Could not read stored counts" });
  render(<MessagesStoredBlock userId="u-1" source="macos" testId="blk" />);
  await waitFor(() => expect(getSourceStats).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
  expect(cells("blk")).toEqual(["—", "—", "—"]);
});

it("nothing stored: 0 texts, 0 chats, no oldest text", async () => {
  getSourceStats.mockResolvedValue({
    success: true,
    stats: { ...STATS, iphone: { texts: 0, chats: 0, oldest: null } },
  });
  render(<MessagesStoredBlock userId="u-1" source="iphone" testId="blk" />);
  await waitFor(() => expect(cells("blk")).toEqual(["0", "0", "—"]));
});

it("uses the Contacts cell treatment", async () => {
  getSourceStats.mockResolvedValue({ success: true, stats: STATS });
  render(<MessagesStoredBlock userId="u-1" source="google" testId="blk" />);
  await waitFor(() => expect(cells("blk")[0]).toBe("3,206"));
  expect(screen.getByTestId("blk-texts").className).toBe("p-2 rounded border bg-white border-gray-200");
  expect(formatOldest(null)).toBe("—");
});

describe("worker not ready when Settings opens", () => {
  afterEach(() => jest.useRealTimers());

  it("one failed read is retried once after a short delay, then the counts show", async () => {
    jest.useFakeTimers();
    getSourceStats
      .mockResolvedValueOnce({ success: false, error: "Could not read stored counts" })
      .mockResolvedValue({ success: true, stats: STATS });
    render(<MessagesStoredBlock userId="u-1" source="macos" testId="blk" />);
    await act(async () => {});
    expect(getSourceStats).toHaveBeenCalledTimes(1);
    expect(cells("blk")).toEqual(["—", "—", "—"]);
    await act(async () => {
      jest.advanceTimersByTime(STATS_RETRY_MS);
    });
    expect(getSourceStats).toHaveBeenCalledTimes(2);
    expect(cells("blk")).toEqual(["12,480", "214", "Mar 2016"]);
  });

  it("a second failure is not retried again", async () => {
    jest.useFakeTimers();
    getSourceStats.mockResolvedValue({ success: false, error: "x" });
    render(<MessagesStoredBlock userId="u-1" source="macos" testId="blk" />);
    await act(async () => {});
    // Async advance flushes the promise chain between timers, so a retry
    // scheduled by the second failure would fire inside this window.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(STATS_RETRY_MS * 5);
    });
    expect(getSourceStats).toHaveBeenCalledTimes(2);
    expect(cells("blk")).toEqual(["—", "—", "—"]);
  });

  it("unmounting before the retry fires cancels it: one read in total", async () => {
    jest.useFakeTimers();
    getSourceStats.mockResolvedValue({ success: false, error: "x" });
    const { unmount } = render(<MessagesStoredBlock userId="u-1" source="macos" testId="blk" />);
    await act(async () => {});
    expect(getSourceStats).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(STATS_RETRY_MS * 5);
    });
    expect(getSourceStats).toHaveBeenCalledTimes(1);
  });
});
