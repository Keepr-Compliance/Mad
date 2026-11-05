/**
 * Phone and tablet tap targets on the Billing page (BACKLOG-4140). Below lg (1024 px) every billing
 * action is at least 44 CSS px tall (text links also 44 wide); from lg up nothing changes.
 *
 * Same recipe as the portal's other 44 px controls (min-height on the call site, e.g.
 * components/submission/ReviewActions.tsx `min-h-[44px] md:min-h-0`), written max-lg because the
 * 768 px tablet is a touch screen too. There is no shared constant to reuse yet; a kit-level 44 px
 * size is BACKLOG-4141, and these two should fold into it.
 */
export const TOUCH_BUTTON = 'max-lg:min-h-11';
export const TOUCH_LINK = 'max-lg:inline-flex max-lg:min-h-11 max-lg:min-w-11 max-lg:items-center max-lg:justify-center';
