/**
 * Tests for UnlockBadge (BACKLOG-2090).
 *
 * Asserts the badge renders the correct affordance per unlock state, and — the
 * key list-level guarantee — that in a mixed list only the UNLOCKED rows show
 * the "Unlocked" badge and the locked rows show the lock (asserted by exact
 * transaction identity, never by counts).
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { UnlockBadge } from "../UnlockBadge";

describe("UnlockBadge", () => {
  it("renders the 'Unlocked' badge when unlocked", () => {
    render(<UnlockBadge isUnlocked={true} />);
    expect(screen.getByTestId("unlock-badge-unlocked")).toBeInTheDocument();
    expect(screen.getByText("Unlocked")).toBeInTheDocument();
    expect(screen.queryByTestId("unlock-badge-locked")).not.toBeInTheDocument();
  });

  it("renders the subtle lock (no 'Unlocked' copy) when locked", () => {
    render(<UnlockBadge isUnlocked={false} />);
    expect(screen.getByTestId("unlock-badge-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("unlock-badge-unlocked")).not.toBeInTheDocument();
    expect(screen.queryByText("Unlocked")).not.toBeInTheDocument();
  });

  it("locked badge exposes a 'Locked' accessible label", () => {
    render(<UnlockBadge isUnlocked={false} />);
    expect(screen.getByLabelText("Locked")).toBeInTheDocument();
  });

  it("renders nothing while the unlock status is still loading (undefined)", () => {
    const { container } = render(<UnlockBadge isUnlocked={undefined} />);
    expect(screen.queryByTestId("unlock-badge-unlocked")).not.toBeInTheDocument();
    expect(screen.queryByTestId("unlock-badge-locked")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  describe("mixed list — badge follows exact transaction identity, not counts", () => {
    // A tiny stand-in for the list body: caller resolves isUnlocked from a Set.
    const unlockedIds = new Set<string>(["tx-A", "tx-C"]);
    const rows = ["tx-A", "tx-B", "tx-C", "tx-D"];

    it("shows 'Unlocked' on exactly the unlocked ids and lock on the rest", () => {
      render(
        <ul>
          {rows.map((id) => (
            <li key={id} data-testid={`row-${id}`}>
              <UnlockBadge isUnlocked={unlockedIds.has(id)} />
            </li>
          ))}
        </ul>,
      );

      // Unlocked ids (A, C) show the Unlocked badge, NOT the lock.
      for (const id of ["tx-A", "tx-C"]) {
        const row = within(screen.getByTestId(`row-${id}`));
        expect(row.getByTestId("unlock-badge-unlocked")).toBeInTheDocument();
        expect(row.queryByTestId("unlock-badge-locked")).not.toBeInTheDocument();
      }

      // Locked ids (B, D) show the lock, NOT the Unlocked badge.
      for (const id of ["tx-B", "tx-D"]) {
        const row = within(screen.getByTestId(`row-${id}`));
        expect(row.getByTestId("unlock-badge-locked")).toBeInTheDocument();
        expect(row.queryByTestId("unlock-badge-unlocked")).not.toBeInTheDocument();
      }
    });
  });
});
