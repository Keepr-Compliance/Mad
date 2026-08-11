/**
 * BACKLOG-2632 — the RENDERED "Removed <date>" line, not just the parser.
 *
 * The parser is unit-tested in `src/utils/__tests__/dateFormatters.dbTimestamp-2632.test.ts`.
 * This suite exists to prove the WIRING: that `RemovedContactsSection` actually
 * routes `removed_at` through it, so reverting the one-line change in the
 * component (and not the util) still goes red.
 *
 * FIXTURE: the row shape is transcribed from the sibling
 * `RemovedContactsSection.test.tsx`, whose `makeRemovedContact` was captured by
 * running the real `contactDbService.getRemovedContacts` against a database
 * built from `electron/database/schema.sql` — including that `removed_at`
 * arrives as `"YYYY-MM-DD HH:MM:SS"` (a SPACE, no zone) and `active_role_count`
 * as a NUMBER. Only the timestamp VALUES are chosen here, to sit on the
 * boundary the defect straddles.
 *
 * TZ GUARD: at UTC the skew is zero and every assertion below passes against the
 * unfixed code, so the guard test is load-bearing, not decoration.
 *
 * Fixture values are reserved-for-documentation only (`example.com`).
 */

process.env.TZ = "America/Costa_Rica";

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedContactsSection } from "../RemovedContactsSection";

const USER_ID = "user-2632";

/**
 * 19:00 on Aug 9 in Costa Rica is 01:00 UTC on Aug 10, and SQLite's
 * `datetime('now')` stores it with no zone marker. This is the founder's exact
 * measured case: the card used to read "Removed Aug 10, 2026".
 */
const EVENING_NAIVE = "2026-08-10 01:00:00";

/** Same instant, in the shape our `toISOString()` writers use. Must not regress. */
const EVENING_ISO = "2026-08-10T01:00:00.000Z";

/** 00:00:00 local Aug 10 — the first moment the day is genuinely allowed to roll. */
const MIDNIGHT_NAIVE = "2026-08-10 06:00:00";

function makeRemovedContact(id: string, display_name: string, removed_at: string) {
  return {
    id,
    display_name,
    email: `${id}@example.com`,
    phone: null,
    company: "Example Realty",
    title: "Broker",
    source: "manual",
    removed_at,
    removed_reason: "user_unimported",
    active_role_count: 0,
  };
}

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.contacts as any).getRemoved = jest.fn();
  (window.api.contacts as any).restore = jest.fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function openSection() {
  await act(async () => {
    await userEvent.click(screen.getByTestId("show-removed-contacts-toggle"));
  });
  await waitFor(() => {
    expect(screen.getByTestId("removed-contacts-section")).toBeInTheDocument();
  });
}

/**
 * The "Removed <date>" text belonging to the card whose display name is `name`.
 *
 * `removed-contact-meta` is a SIBLING of `removed-contact-card`, not a child, so
 * the lookup walks up one level. Identity is by display name, never by index —
 * "some card shows Aug 9" is satisfied by the wrong person's card.
 */
function removedLineFor(name: string): string {
  const card = screen
    .getAllByTestId("removed-contact-card")
    .find((c) => c.textContent?.includes(name));
  if (!card) throw new Error(`no card for ${name}`);

  const meta = card.parentElement?.querySelector('[data-testid="removed-contact-meta"]');
  if (!meta) throw new Error(`no meta line beside ${name}'s card`);

  const text = meta.textContent ?? "";
  if (!text.startsWith("Removed ")) {
    throw new Error(`meta line for ${name} is not a Removed-date line: "${text}"`);
  }
  return text;
}

/**
 * The component formats with `toLocaleDateString(undefined, ...)`, i.e. the
 * RUNNER's locale. Hard-coding "Aug 9, 2026" would go red on a runner whose
 * default locale is not en-US — a false failure that says nothing about the
 * defect. So the expectations are DERIVED: the right day is formatted from the
 * known-correct instant, the wrong day from the naive-parsed-as-local instant
 * that the bug produced. Whatever locale is in force, those two strings differ
 * and the assertion is meaningful.
 */
const DISPLAY_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};
/** Aug 9 in the runner's locale — the correct rendering. */
const RIGHT_DAY = new Date(EVENING_ISO).toLocaleDateString(undefined, DISPLAY_OPTS);
/** Aug 10 in the runner's locale — exactly what the unfixed `new Date(naive)` produced. */
const WRONG_DAY = new Date("2026-08-10T01:00:00").toLocaleDateString(undefined, DISPLAY_OPTS);
/** Aug 10 again, reached legitimately at 00:00 local. */
const NEXT_DAY = new Date("2026-08-10T06:00:00.000Z").toLocaleDateString(undefined, DISPLAY_OPTS);

describe("TZ guard", () => {
  it("runs at UTC-6, so the skew is actually exercised", () => {
    const probe = new Date(EVENING_ISO);
    expect(probe.getTimezoneOffset()).toBe(360);
    expect(probe.getDate()).toBe(9);
  });

  it("the right and wrong renderings are distinguishable in this locale", () => {
    // If these collapsed to one string the suite could not tell pass from fail.
    expect(RIGHT_DAY).not.toBe(WRONG_DAY);
    expect(WRONG_DAY).toBe(NEXT_DAY);
  });
});

describe("BACKLOG-2632 — removed-contact card date", () => {
  it("shows Aug 9 for a contact removed at 19:00 local, not Aug 10", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [makeRemovedContact("c-dana", "Dana Example", EVENING_NAIVE)],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    expect(removedLineFor("Dana Example")).toContain(RIGHT_DAY);
    expect(removedLineFor("Dana Example")).not.toContain(WRONG_DAY);
  });

  it("agrees with the ISO shape for the same instant", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [
        makeRemovedContact("c-naive", "Naive Example", EVENING_NAIVE),
        makeRemovedContact("c-iso", "Iso Example", EVENING_ISO),
      ],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    // Same instant, two storage shapes, one rendered day.
    expect(removedLineFor("Naive Example")).toBe(removedLineFor("Iso Example"));
    expect(removedLineFor("Iso Example")).toContain(RIGHT_DAY);
  });

  it("still rolls the day at local midnight", async () => {
    (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({
      success: true,
      contacts: [makeRemovedContact("c-mid", "Midnight Example", MIDNIGHT_NAIVE)],
    });

    render(<RemovedContactsSection userId={USER_ID} />);
    await openSection();

    // Not a blanket "subtract a day" — 00:00 local Aug 10 must read Aug 10.
    expect(removedLineFor("Midnight Example")).toContain(NEXT_DAY);
  });
});
