/**
 * BACKLOG-2632 — the RENDERED "Removed <date>" line, not just the parser.
 *
 * The parser is unit-tested in `src/utils/__tests__/dateFormatters.dbTimestamp-2632.test.ts`,
 * which pins the founder's zone per assertion and is therefore runner-independent.
 * This suite exists to prove the WIRING: that `RemovedContactsSection` actually
 * routes `removed_at` through `formatDbDate`, so reverting the one line in the
 * component (and not the util) still goes red.
 *
 * ===========================================================================
 * WHY THE FIXTURE IS COMPUTED FROM THE RUNNER'S OWN OFFSET
 * ===========================================================================
 * The component formats with `toLocaleDateString(undefined, ...)` — the AMBIENT
 * zone. There is no seam to inject one, and `process.env.TZ` provably does not
 * work under jest's jsdom environment (measured: with ambient `TZ=UTC`, plain
 * node honours the assignment and jest does not). Hard-coding Costa Rica would
 * make this suite green only on a machine physically at UTC-6 and red on CI.
 *
 * So the fixture is DERIVED at run time from whatever offset the runner has:
 * a local wall-clock time is chosen on the far side of local midnight, the naive
 * string is that instant's UTC wall clock (what SQLite stores), and the expected
 * and buggy renderings are both computed. A guard asserts they differ.
 *
 * At UTC exactly (offset 0) the naive shape and UTC coincide, the defect CANNOT
 * manifest, and there is nothing to assert — so those cases skip with an explicit
 * reason rather than passing for free. `ISO_AGREES_WITH_NAIVE` runs everywhere.
 *
 * FIXTURE SHAPE is transcribed from the sibling `RemovedContactsSection.test.tsx`,
 * whose `makeRemovedContact` was captured by running the real
 * `contactDbService.getRemovedContacts` against a database built from
 * `electron/database/schema.sql` — including that `removed_at` arrives as
 * `"YYYY-MM-DD HH:MM:SS"` (a SPACE, no zone) and `active_role_count` as a NUMBER.
 *
 * Fixture values are reserved-for-documentation only (`example.com`).
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { RemovedContactsSection } from "../RemovedContactsSection";

const USER_ID = "user-2632";

const DISPLAY_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

/**
 * A row whose stored `removed_at` sits where the naive-vs-UTC reading falls on
 * DIFFERENT local calendar days, for this runner's offset.
 *
 * West of UTC the bug reads the value LATER, so 23:30 local spills into tomorrow.
 * East of UTC it reads EARLIER, so 00:30 local spills into yesterday.
 */
function buildSkewFixture(): {
  naive: string;
  iso: string;
  rightDay: string;
  wrongDay: string;
} {
  // Minutes WEST of UTC on the reference date (positive = west, e.g. 360 at UTC-6).
  const offsetMinutes = new Date(2026, 7, 10, 12, 0, 0).getTimezoneOffset();
  const hour = offsetMinutes > 0 ? 23 : 0;
  const minute = offsetMinutes > 0 ? 30 : 30;

  // The true instant, expressed as a local wall clock on Aug 10 2026.
  const instant = new Date(2026, 7, 10, hour, minute, 0, 0);

  // What SQLite stores: that instant's UTC wall clock, with no zone marker.
  const naive = instant.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");

  return {
    naive,
    iso: instant.toISOString(),
    rightDay: instant.toLocaleDateString(undefined, DISPLAY_OPTS),
    // Exactly what the unfixed `new Date(naive)` produced.
    wrongDay: new Date(naive).toLocaleDateString(undefined, DISPLAY_OPTS),
  };
}

const FIXTURE = buildSkewFixture();

/** True only where the defect can actually manifest. At UTC it cannot. */
const SKEW_IS_OBSERVABLE = FIXTURE.rightDay !== FIXTURE.wrongDay;

/** Skips with a visible reason instead of passing for free. */
const itWhenSkewed = SKEW_IS_OBSERVABLE ? it : it.skip;

/** Local noon — no offset under 12h can move this off its own calendar day. */
const NOON_LOCAL = new Date(2026, 7, 10, 12, 0, 0, 0);
const NOON_NAIVE = NOON_LOCAL.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
const NOON_DAY = NOON_LOCAL.toLocaleDateString(undefined, DISPLAY_OPTS);

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
 * "some card shows the right day" is satisfied by the wrong person's card.
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

async function renderWith(contacts: ReturnType<typeof makeRemovedContact>[]) {
  (window.api.contacts.getRemoved as jest.Mock).mockResolvedValue({ success: true, contacts });
  render(<RemovedContactsSection userId={USER_ID} />);
  await openSection();
}

describe("Fixture guard", () => {
  it("stores the naive shape SQLite actually writes", () => {
    expect(FIXTURE.naive).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(FIXTURE.naive).not.toContain("Z");
  });

  it("reports whether this runner's offset can expose the defect at all", () => {
    // Documented, not silently assumed. At UTC the two readings coincide and the
    // skew cases below skip rather than pass for free.
    const offset = new Date(2026, 7, 10, 12, 0, 0).getTimezoneOffset();
    expect(SKEW_IS_OBSERVABLE).toBe(offset !== 0);
  });
});

describe("BACKLOG-2632 — removed-contact card date", () => {
  itWhenSkewed("shows the day the removal actually happened, not the skewed one", async () => {
    await renderWith([makeRemovedContact("c-dana", "Dana Example", FIXTURE.naive)]);

    expect(removedLineFor("Dana Example")).toContain(FIXTURE.rightDay);
    expect(removedLineFor("Dana Example")).not.toContain(FIXTURE.wrongDay);
  });

  it("agrees with the ISO shape for the same instant", async () => {
    // Runs at EVERY offset including UTC: the two storage shapes must never
    // disagree, which is the RemovedEmailsSection side-by-side case.
    await renderWith([
      makeRemovedContact("c-naive", "Naive Example", FIXTURE.naive),
      makeRemovedContact("c-iso", "Iso Example", FIXTURE.iso),
    ]);

    expect(removedLineFor("Naive Example")).toBe(removedLineFor("Iso Example"));
    expect(removedLineFor("Iso Example")).toContain(FIXTURE.rightDay);
  });

  it("is not a blanket day-shift — a midday removal keeps its own day", async () => {
    await renderWith([makeRemovedContact("c-noon", "Noon Example", NOON_NAIVE)]);

    expect(removedLineFor("Noon Example")).toContain(NOON_DAY);
  });
});
