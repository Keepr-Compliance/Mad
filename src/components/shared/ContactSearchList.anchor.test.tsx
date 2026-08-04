/**
 * ContactSearchList — keeping the user's place across open/close (BACKLOG-2459).
 *
 * Founder: *"when clicking on a contact row to open it and then closing, the
 * place in the list the user just was on should stay put — even if there were
 * changes made to the list since, maybe 2 got linked and one needed to be
 * consolidated."*
 *
 * That last clause is what these tests are for. Restoring a saved offset is
 * correct only while the list is unchanged, and the actions available on an open
 * contact are exactly the ones that change it. So the assertions here are on
 * WHICH CONTACT the user is looking at after the restore — never on a raw
 * offset, which is the thing that goes wrong.
 *
 * jsdom reports zero-size rects, so geometry is simulated: the list container
 * sits at y=100 and every row is 40px tall, positioned from its index in the
 * rendered order minus the container's current scrollTop. That is enough to make
 * "which row is at the place the user was looking" a real, checkable question.
 */

import React, { useCallback, useState } from "react";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { ContactSearchList } from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";
import type { ContactListAnchor } from "../../utils/contactListAnchor";

// --- Simulated layout -------------------------------------------------------

const CONTAINER_TOP = 100;
const CONTAINER_HEIGHT = 400;
const ROW_HEIGHT = 40;

const rect = (partial: Partial<DOMRect>): DOMRect =>
  ({
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => {},
    ...partial,
  }) as DOMRect;

function listContainer(): HTMLElement {
  return screen.getByTestId("contact-list");
}

/** Every rendered row's contact id, in render order. */
function renderedIds(): string[] {
  return Array.from(listContainer().querySelectorAll("[data-contact-id]")).map(
    (el) => el.getAttribute("data-contact-id") as string,
  );
}

/**
 * The contact currently occupying `offset` px from the top of the scroll
 * container — i.e. "who is the user looking at?".
 */
function contactAtViewportOffset(offset: number): string | null {
  const container = listContainer();
  const index = (container.scrollTop + offset) / ROW_HEIGHT;
  return renderedIds()[index] ?? null;
}

beforeEach(() => {
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const container = document.querySelector('[data-testid="contact-list"]');
    if (!container) return rect({});
    if (this === container) {
      return rect({
        top: CONTAINER_TOP,
        bottom: CONTAINER_TOP + CONTAINER_HEIGHT,
        height: CONTAINER_HEIGHT,
      });
    }
    if (this.hasAttribute?.("data-contact-id")) {
      const rows = Array.from(container.querySelectorAll("[data-contact-id]"));
      const index = rows.indexOf(this);
      if (index < 0) return rect({});
      const top =
        CONTAINER_TOP + index * ROW_HEIGHT - (container as HTMLElement).scrollTop;
      return rect({ top, bottom: top + ROW_HEIGHT, height: ROW_HEIGHT });
    }
    return rect({});
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// --- Fixtures ---------------------------------------------------------------

function contact(id: string, overrides: Partial<ExtendedContact> = {}): ExtendedContact {
  return {
    id,
    user_id: "u1",
    source: "contacts_app",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    display_name: `Person ${id}`,
    name: `Person ${id}`,
    email: `${id}@example.test`,
    ...overrides,
  } as ExtendedContact;
}

/**
 * A stand-in for the Contacts screen's plumbing: it holds the anchor across the
 * detail view exactly as `Contacts.tsx` does, and lets a test swap the contact
 * data underneath while the detail is "open".
 */
function Harness({
  initialContacts,
  initialExternal = [],
}: {
  initialContacts: ExtendedContact[];
  initialExternal?: ExtendedContact[];
}): React.ReactElement {
  const [contacts, setContacts] = useState(initialContacts);
  const [externalContacts, setExternalContacts] = useState(initialExternal);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<ContactListAnchor | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<ContactListAnchor | null>(null);

  // Exposed so a test can simulate the list changing while the detail is open.
  (window as unknown as { __harness: unknown }).__harness = {
    setContacts,
    setExternalContacts,
    close: () => {
      setActiveId(null);
      setPendingAnchor(anchor);
    },
  };

  const onAnchorCapture = useCallback((next: ContactListAnchor) => setAnchor(next), []);
  const onAnchorConsumed = useCallback(() => setPendingAnchor(null), []);

  return (
    <ContactSearchList
      contacts={contacts}
      externalContacts={externalContacts}
      selectedIds={[]}
      activeContactId={activeId}
      onSelectionChange={() => {}}
      onContactClick={(c) => setActiveId(c.id)}
      initialSortOrder="alphabetical"
      compact
      onAnchorCapture={onAnchorCapture}
      pendingAnchor={pendingAnchor}
      onAnchorConsumed={onAnchorConsumed}
    />
  );
}

function harness(): {
  setContacts: (c: ExtendedContact[]) => void;
  setExternalContacts: (c: ExtendedContact[]) => void;
  close: () => void;
} {
  return (window as unknown as { __harness: never }).__harness;
}

/** Names sort "Person a01".."Person a12" so alphabetical order == fixture order. */
const roster = (n: number): ExtendedContact[] =>
  Array.from({ length: n }, (_, i) => contact(`a${String(i + 1).padStart(2, "0")}`));

// ---------------------------------------------------------------------------
describe("ContactSearchList — position across open/close (BACKLOG-2459)", () => {
  it("restores the scroll position when the list did not change", async () => {
    render(<Harness initialContacts={roster(12)} />);

    const container = listContainer();
    act(() => {
      container.scrollTop = 200; // the user scrolled five rows down
    });
    expect(contactAtViewportOffset(0)).toBe("a06");

    // Open the seventh row, which is sitting 40px into the visible area.
    await userEvent.click(screen.getByText("Person a07"));
    // Something else moves the scroll while the detail is open (a re-render, a
    // refresh) — the list must not be trusted to have stayed put on its own.
    act(() => {
      container.scrollTop = 0;
    });

    act(() => harness().close());

    expect(container.scrollTop).toBe(200);
    expect(contactAtViewportOffset(40)).toBe("a07");
  });

  it("lands on the MERGED contact after two records are linked while the detail is open", async () => {
    // The founder's hard case. `a07` is an address-book record that gets folded
    // into a saved contact while its card is open: the list becomes SHORTER and
    // every row below shifts up. An offset restore would land on a stranger.
    const saved = roster(12).slice(0, 6); // a01..a06
    const externalAlice = contact("ext-alice", {
      display_name: "Person a07",
      email: "alice@example.test",
    });
    const rest = [contact("a08"), contact("a09"), contact("a10"), contact("a11")];

    render(<Harness initialContacts={saved} initialExternal={[externalAlice, ...rest]} />);

    const container = listContainer();
    act(() => {
      container.scrollTop = 200;
    });
    expect(renderedIds()).toEqual([
      "a01",
      "a02",
      "a03",
      "a04",
      "a05",
      "a06",
      "ext-alice",
      "a08",
      "a09",
      "a10",
      "a11",
    ]);

    await userEvent.click(screen.getByText("Person a07"));

    // While the card is open the record is linked into a saved contact: the
    // external row disappears, a saved row takes its identity, and two rows
    // ABOVE the anchor are consolidated as well — so the surviving contact ends
    // up at a completely different index from the one it was opened at.
    const mergedAlice = contact("db-alice", {
      display_name: "Person a07",
      email: "ALICE@example.test",
    });
    act(() => {
      harness().setContacts([
        contact("a01"),
        contact("a02"),
        contact("a03"),
        contact("a04"),
        mergedAlice,
      ]);
      harness().setExternalContacts([contact("a08"), contact("a09"), contact("a10")]);
    });

    act(() => harness().close());

    // The list is shorter and the anchored identity moved from index 6 to 4.
    expect(renderedIds()).toEqual(["a01", "a02", "a03", "a04", "db-alice", "a08", "a09", "a10"]);
    // The user is looking at the merged contact — the person they had open —
    // and NOT at whoever now occupies the coordinates they left from.
    expect(contactAtViewportOffset(40)).toBe("db-alice");
    expect(contactAtViewportOffset(40)).not.toBe("a09");
  });

  it("lands on the nearest surviving neighbour when the contact is removed entirely", async () => {
    render(<Harness initialContacts={roster(12)} />);

    const container = listContainer();
    act(() => {
      container.scrollTop = 200;
    });
    await userEvent.click(screen.getByText("Person a07"));

    // Deleted while the card was open, with no survivor carrying its identity.
    act(() => {
      harness().setContacts(roster(12).filter((c) => c.id !== "a07"));
    });
    act(() => harness().close());

    expect(renderedIds()).not.toContain("a07");
    // The row that closed the gap, not the top of the list.
    expect(contactAtViewportOffset(40)).toBe("a08");
    expect(container.scrollTop).not.toBe(0);
  });

  it("does not restore against a list that has not finished reloading", async () => {
    render(<Harness initialContacts={roster(12)} />);

    const container = listContainer();
    act(() => {
      container.scrollTop = 200;
    });
    await userEvent.click(screen.getByText("Person a07"));

    // A refresh is in flight: the list is momentarily empty. Restoring here
    // would consume the anchor against a list that cannot answer, and the real
    // data arriving a moment later would find nothing left to restore with.
    act(() => {
      harness().setContacts([]);
    });
    act(() => harness().close());
    // An empty container has nothing to scroll — the browser clamps to 0.
    act(() => {
      container.scrollTop = 0;
    });

    // Data lands — and the anchor is still pending, so the place is recovered
    // rather than lost to a restore that ran too early.
    act(() => {
      harness().setContacts(roster(12));
    });

    expect(container.scrollTop).toBe(200);
    expect(contactAtViewportOffset(40)).toBe("a07");
  });

  it("keeps the anchor on the contact when rows are inserted ABOVE it", async () => {
    render(<Harness initialContacts={roster(12)} />);

    const container = listContainer();
    act(() => {
      container.scrollTop = 200;
    });
    await userEvent.click(screen.getByText("Person a07"));

    // Two new contacts arrive that sort above the anchor: every index below
    // shifts down by two.
    act(() => {
      harness().setContacts([contact("a00"), contact("a005"), ...roster(12)]);
    });
    act(() => harness().close());

    expect(renderedIds().slice(0, 3)).toEqual(["a00", "a005", "a01"]);
    expect(contactAtViewportOffset(40)).toBe("a07");
  });
});
