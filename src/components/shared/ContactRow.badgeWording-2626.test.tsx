import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactRow, badgeLabel } from "./ContactRow";
import type { ExtendedContact } from "../../types/components";
import type { ContactSource } from "../../../electron/types/models";

/**
 * BADGE WORDING — BACKLOG-2626, comment `d84dc2f6`. And the badge as a WAY IN,
 * BACKLOG-2603.
 *
 * ===========================================================================
 * WHAT THE FOUNDER SAID
 * ===========================================================================
 * > *"It showed the suggestions pill — I'd rather call it X duplicates found or
 * > something that a user can understand as duplicates found."*
 *
 * `Suggestion` was the app's INTERNAL CATEGORY NAME. It told the user that a
 * suggestion existed without saying what it was about or how many — and "how
 * much is outstanding on this contact" is the single question the badge exists
 * to answer. `Suggestion` cannot distinguish one question from four.
 *
 * The replacement is the COUNT plus THE NOUN THIS SURFACE ALREADY USES: the
 * header button says "Review N possible duplicates", the queue is titled
 * "Possible duplicates". A third name for one concept is how a user meets three
 * ideas where there is one.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT BUILT
 * ===========================================================================
 * "action required", which he also floated, is REJECTED and asserted against
 * below. These questions are optional; the queue's own copy promises *"nothing
 * changes until you answer"*, and he ruled the sibling badge *"a lens, not a
 * queue the user is behind on"* for the same reason. A badge that demands would
 * contradict the screen it points at.
 *
 * ===========================================================================
 * THE TWO NUMBERS, WHICH HE ASKED ABOUT BY NAME
 * ===========================================================================
 * > *"This badge's count is `openQuestions` — which is a different number from
 * > the `N records combined` text beside it. Decide whether both appear at once,
 * > and if they do, make sure each is unmistakable about what it counts."*
 *
 * They DO appear at once, and that is asserted here in ONE test rather than two,
 * so the two strings cannot drift apart — the standing instruction from
 * `14617008`, which is the defect where the badge counted columns while the
 * sentence beside it counted records.
 *
 * The judgement, recorded so a reviewer can overrule it rather than rediscover
 * it: they no longer collide. Each now names its own noun, and the tenses
 * separate them — "combined" is done, "possible duplicates" is outstanding. It
 * was `Suggestion` sitting beside "5 records combined" that could not be read,
 * because only one of the two said what it counted.
 */

function contactWith(
  state: Partial<{
    columns: number;
    records: number;
    needsReview: boolean;
    openQuestions: number;
    badge: "suggestion" | "autolinked" | "user_linked";
  }> | null,
  overrides: Partial<ExtendedContact> = {},
): ExtendedContact {
  return {
    id: "c-bianca",
    user_id: "user-1",
    name: "Bianca Okafor",
    display_name: "Bianca Okafor",
    email: "bianca@example.com",
    phone: "+1 (503) 555-0130",
    company: "Okafor Realty",
    source: "imported" as unknown as ContactSource,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(state
      ? {
          review_state: {
            columns: 2,
            records: 2,
            needsReview: false,
            openQuestions: 0,
            badge: "suggestion" as const,
            ...state,
          },
        }
      : {}),
    ...overrides,
  };
}

describe("the badge says how many and what of (BACKLOG-2626 `d84dc2f6`)", () => {
  /**
   * CONTROL 8 — the badge reads the OPEN-QUESTION COUNT.
   *
   * OBSERVED RED: restoring `BADGE_LABELS.suggestion = "Suggestion"` and the
   * static lookup fails both rows here — `Expected "4 possible duplicates",
   * received "Suggestion"` — which is exactly what the founder saw on screen.
   *
   * Four is his own case: he imported one contact and four questions were filed
   * against her.
   */
  it.each([
    [4, "4 possible duplicates"],
    [2, "2 possible duplicates"],
  ])("says how many questions are open (%i)", (openQuestions, expected) => {
    render(<ContactRow contact={contactWith({ badge: "suggestion", openQuestions })} />);

    expect(screen.getByRole("status")).toHaveTextContent(expected);
  });

  /**
   * "1 possible duplicates" is the kind of small wrongness that makes a user
   * distrust the number beside it — and this badge exists to be trusted about a
   * number.
   */
  it("is singular at one", () => {
    render(<ContactRow contact={contactWith({ badge: "suggestion", openQuestions: 1 })} />);

    expect(screen.getByRole("status")).toHaveTextContent("1 possible duplicate");
    expect(screen.getByRole("status")).not.toHaveTextContent("duplicates");
  });

  /**
   * THE REJECTED WORDINGS, ASSERTED AS ABSENT.
   *
   * Both were live candidates in his own message. Asserting their absence is
   * what makes this a decision the code holds rather than a preference someone
   * remembers: "Suggestion" because it names an internal category, "action
   * required" because these are optional and the queue promises they are.
   */
  it("says neither `Suggestion` nor `action required`", () => {
    render(<ContactRow contact={contactWith({ badge: "suggestion", openQuestions: 3 })} />);

    const badge = screen.getByRole("status");
    expect(badge).not.toHaveTextContent(/suggestion/i);
    expect(badge).not.toHaveTextContent(/action required/i);
  });

  /**
   * THE OTHER TWO ARE UNCHANGED — he said so explicitly: *"`Autolinked` and
   * `You linked these` both already say what happened in plain words. Only the
   * suggestion state was named after its internal concept."*
   *
   * They carry NO count, which is the asymmetry that proves the count belongs to
   * the suggestion state rather than having been sprayed over all three.
   */
  it.each([
    ["autolinked" as const, "Autolinked"],
    ["user_linked" as const, "You linked these"],
  ])("leaves %s alone, with no number on it", (badge, expected) => {
    render(<ContactRow contact={contactWith({ badge, openQuestions: 0 })} />);

    const node = screen.getByRole("status");
    expect(node).toHaveTextContent(expected);
    expect(node.textContent).not.toMatch(/\d/);
  });

  /**
   * THE FOUNDER'S EXACT ROW, WITH BOTH NUMBERS ON IT — his question answered in
   * one assertion so the two strings cannot drift apart (`14617008`).
   *
   * His contact had FOUR sources attached and, at the moment he complained about
   * the wording, TWO questions still open. The row therefore says "4 records
   * combined" and "2 possible duplicates" at the same time, and the whole point
   * is that those are different numbers about different things.
   *
   * OBSERVED RED: sourcing the badge count from `records` instead of
   * `openQuestions` makes this read "4 possible duplicates" beside "4 records
   * combined" — two numbers agreeing by accident, which is worse than
   * disagreeing, because it looks correct.
   */
  it("shows the record count and the question count together, each saying what it counts", () => {
    render(
      <ContactRow
        contact={contactWith({
          badge: "suggestion",
          columns: 4,
          records: 4,
          openQuestions: 2,
        })}
      />,
    );

    expect(screen.getByTestId("contact-row-record-count")).toHaveTextContent(
      "4 records combined",
    );
    expect(screen.getByTestId("contact-row-badge")).toHaveTextContent(
      "2 possible duplicates",
    );
  });

  /**
   * CONTROL 8, SECOND HALF — the regression guard against decorating every row.
   * A contact with nothing outstanding and nothing combined carries no badge at
   * all, which is `review_state: undefined`, and it must never be read as a
   * fourth state.
   */
  it("puts no badge on the ordinary contact", () => {
    render(<ContactRow contact={contactWith(null)} />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("contact-row-badge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("contact-row-badge-action")).not.toBeInTheDocument();
  });

  /**
   * The exported helper and the rendered row agree. `ContactSearchList` labels a
   * FILTER from the same vocabulary, and two string literals in two files is how
   * "Needs review" survived in one place after being renamed in the other.
   */
  it("labels the row from the same function anything else would use", () => {
    render(<ContactRow contact={contactWith({ badge: "suggestion", openQuestions: 3 })} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      badgeLabel({ badge: "suggestion", openQuestions: 3 }),
    );
  });
});

/**
 * THE BADGE AS A WAY IN — BACKLOG-2603.
 *
 * Clients & Contacts routes a contact's open questions through its ROW CLICK.
 * The transaction wizard cannot: there the row click adds the contact to the
 * deal. So the badge takes the click on any surface that asks for it, and the
 * row keeps its own meaning everywhere.
 */
describe("the badge can be the way into the questions (BACKLOG-2603)", () => {
  it("is inert unless a consumer asks for it", () => {
    render(<ContactRow contact={contactWith({ badge: "suggestion", openQuestions: 2 })} />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /**
   * OBSERVED RED: dropping the `onOpenQuestions ?` branch and always rendering
   * the bare span leaves no button to press — `Unable to find role="button"`.
   */
  it("opens the questions when asked for, and does NOT also select the row", async () => {
    const onOpenQuestions = jest.fn();
    const onSelect = jest.fn();
    render(
      <ContactRow
        contact={contactWith({ badge: "suggestion", openQuestions: 2 })}
        onOpenQuestions={onOpenQuestions}
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByTestId("contact-row-badge-action"));

    expect(onOpenQuestions).toHaveBeenCalledTimes(1);
    /*
      THE HALF THAT MATTERS ON THIS SURFACE. Without `stopPropagation` the badge
      press bubbles to the row's own `onClick`, and in the transaction wizard
      that means the user is silently added to the deal on the way to reading a
      question. OBSERVED RED: removing `event.stopPropagation()` from
      `handleOpenQuestionsClick` fails here with `Expected 0, received 1`.
    */
    expect(onSelect).not.toHaveBeenCalled();
  });

  /**
   * The clickable shape wraps the SAME badge node; it does not draw a second
   * one. If it forked, the 2626 controls that assert `getByRole("status")` would
   * pass on one surface and quietly stop describing the other.
   */
  it("wraps the same status badge rather than drawing a second one", () => {
    render(
      <ContactRow
        contact={contactWith({ badge: "suggestion", openQuestions: 2 })}
        onOpenQuestions={jest.fn()}
      />,
    );

    const badges = screen.getAllByRole("status");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("2 possible duplicates");
    expect(screen.getByTestId("contact-row-badge-action")).toContainElement(badges[0]);
  });

  /**
   * A contact with nothing outstanding gains nothing from the prop. The
   * affordance follows the badge, and the badge follows the state — so a
   * consumer that opts in does not decorate its ordinary rows.
   */
  it("adds no affordance to a contact that has no badge", () => {
    render(<ContactRow contact={contactWith(null)} onOpenQuestions={jest.fn()} />);

    expect(screen.queryByTestId("contact-row-badge-action")).not.toBeInTheDocument();
  });
});
