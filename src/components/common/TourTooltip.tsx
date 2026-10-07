/**
 * BACKLOG-3674: Joyride tooltip with a "Don't show this again" checkbox.
 *
 * Renders the stock Joyride layout (title, content, Skip, Back, Next/Done) with
 * the step's merged styles and locale, so it looks like the default tooltip.
 * Joyride's button props are spread unchanged: they carry the labels and the
 * `data-action` attributes the e2e driver clicks.
 *
 * The checkbox state comes from TourTooltipContext, not from props: Joyride
 * takes `tooltipComponent` as a component type, and a type rebuilt on every
 * render would remount the tooltip.
 */
import React, { createContext, useContext, useId } from "react";
import type { TooltipRenderProps } from "react-joyride";

export interface TourTooltipContextValue {
  dontShowAgain: boolean;
  setDontShowAgain: (value: boolean) => void;
}

export const TourTooltipContext = createContext<TourTooltipContextValue | null>(null);

export const DONT_SHOW_AGAIN_LABEL = "Don't show this again";

/** Joyride's runtime button props include `children` (the locale label). */
type ButtonProps = TooltipRenderProps["primaryProps"] & { children?: React.ReactNode };

export function TourTooltip(props: TooltipRenderProps): React.ReactElement {
  const { backProps, index, isLastStep, primaryProps, skipProps, step, tooltipProps } = props;
  const { content, hideBackButton, hideFooter, showSkipButton, styles, title } = step;
  const ctx = useContext(TourTooltipContext);
  const checkboxId = useId();

  // The last step's Done already dismisses the tour, so the box is not shown there.
  const showCheckbox = ctx !== null && !isLastStep;

  return (
    <div
      aria-label={typeof (title ?? content) === "string" ? String(title ?? content) : undefined}
      className="react-joyride__tooltip"
      style={styles.tooltip}
      {...tooltipProps}
    >
      <div style={styles.tooltipContainer}>
        {title && <h1 style={styles.tooltipTitle}>{title}</h1>}
        <div style={styles.tooltipContent}>{content}</div>
      </div>
      {!hideFooter && (
        <div style={styles.tooltipFooter}>
          <div style={{ ...styles.tooltipFooterSpacer, display: "flex", alignItems: "center", gap: 12 }}>
            {showSkipButton && !isLastStep && (
              <button
                aria-live="off"
                style={styles.buttonSkip}
                type="button"
                {...(skipProps as ButtonProps)}
              />
            )}
            {showCheckbox && (
              <label
                htmlFor={checkboxId}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#4b5563", cursor: "pointer" }}
              >
                <input
                  id={checkboxId}
                  type="checkbox"
                  checked={ctx.dontShowAgain}
                  onChange={(e) => ctx.setDontShowAgain(e.target.checked)}
                />
                {DONT_SHOW_AGAIN_LABEL}
              </label>
            )}
          </div>
          {!hideBackButton && index > 0 && (
            <button style={styles.buttonBack} type="button" {...(backProps as ButtonProps)} />
          )}
          <button style={styles.buttonNext} type="button" {...(primaryProps as ButtonProps)} />
        </div>
      )}
    </div>
  );
}

export default TourTooltip;
