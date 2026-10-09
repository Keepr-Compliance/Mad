/**
 * BACKLOG-3674: the "Don't show this again" checkbox sits on its own row above
 * the Back / Next / Skip row, and the last step has no checkbox.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import type { TooltipRenderProps } from "react-joyride";
import { TourTooltip, TourTooltipContext, DONT_SHOW_AGAIN_LABEL } from "../TourTooltip";

function makeProps(over: { isLastStep?: boolean; index?: number } = {}): TooltipRenderProps {
  const styles = {
    tooltip: {},
    tooltipContainer: {},
    tooltipTitle: {},
    tooltipContent: {},
    tooltipFooter: {},
    tooltipFooterSpacer: {},
    buttonSkip: {},
    buttonBack: {},
    buttonNext: {},
  };
  return {
    backProps: { children: "Back", "data-action": "back" },
    primaryProps: { children: "Next", "data-action": "primary" },
    skipProps: { children: "Skip", "data-action": "skip" },
    closeProps: {},
    tooltipProps: {},
    index: over.index ?? 1,
    isLastStep: over.isLastStep ?? false,
    size: 3,
    continuous: true,
    step: { title: "T", content: "C", showSkipButton: true, styles },
  } as unknown as TooltipRenderProps;
}

function renderTooltip(props: TooltipRenderProps) {
  return render(
    <TourTooltipContext.Provider value={{ dontShowAgain: false, setDontShowAgain: jest.fn() }}>
      <TourTooltip {...props} />
    </TourTooltipContext.Provider>
  );
}

describe("TourTooltip checkbox layout (BACKLOG-3674)", () => {
  it("renders the checkbox in its own row above, not inside, the button row", () => {
    renderTooltip(makeProps());
    const checkbox = screen.getByLabelText(DONT_SHOW_AGAIN_LABEL);
    const next = screen.getByText("Next");
    const buttonRow = next.parentElement as HTMLElement;
    expect(buttonRow.contains(checkbox)).toBe(false);
    expect(buttonRow.contains(screen.getByText("Back"))).toBe(true);
    expect(buttonRow.contains(screen.getByText("Skip"))).toBe(true);
    const checkboxRow = checkbox.closest('[data-testid="tour-dont-show-again-row"]') as HTMLElement;
    expect(checkboxRow).not.toBeNull();
    expect(checkboxRow.contains(next)).toBe(false);
    // the checkbox row precedes the button row in document order
    expect(
      checkboxRow.compareDocumentPosition(buttonRow) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows no checkbox on the last step", () => {
    renderTooltip(makeProps({ isLastStep: true }));
    expect(screen.queryByLabelText(DONT_SHOW_AGAIN_LABEL)).toBeNull();
    expect(screen.getByText("Next")).toBeTruthy();
  });
});
