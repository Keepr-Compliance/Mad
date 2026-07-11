/**
 * Driver action logging (BACKLOG-1969) — self-verifiable automation.
 *
 * The QA driver drives the app blind: it clicks a testid and trusts that the RIGHT element
 * received the event. This module makes every hover/press/fill self-verifiable by logging two
 * things that can be diffed side by side:
 *
 *   1. INTENT  — what the DRIVER meant to do, emitted BEFORE the action:
 *        [driver-action] <HH:MM:SS.mmm> <verb> testid=<testid|selector> text="<resolved innerText>"
 *      e.g.  [driver-action] 14:03:09.512 press testid=nav-new-audit text="New Audit"
 *
 *   2. REALITY — what the DOM actually received, captured by an init-script that installs
 *      capture-phase listeners in the renderer and console.logs one line per real event; the
 *      driver captures the renderer console (page.on('console')) and re-emits these to its own
 *      log with the same prefix:
 *        [dom-event] <type> testid=<testid|selector> text="<innerText>"
 *      e.g.  [dom-event] click testid=nav-new-audit text="New Audit"
 *
 * With both streams interleaved, "the driver pressed X but the DOM delivered the click to Y"
 * becomes a trivial grep/diff (see docs/qa/driver-action-log.md).
 *
 * This module is PURE (no Playwright import) so the line formatters are unit-tested directly.
 * The DOM capture is shipped as a source STRING (DOM_CAPTURE_INIT_SCRIPT) that appDriver.ts
 * installs via page.addInitScript — keeping this file free of any runtime app/browser dependency.
 *
 * ADDITIVE OBSERVABILITY ONLY: nothing here changes assertion logic or outcome classification.
 */

/** The action verbs the driver logs. DOM-event `type`s are separate (pointerover/mousedown/click). */
export type ActionVerb = 'hover' | 'press' | 'fill';

/** Shared prefixes so both the emitter and the console re-emitter agree on the greppable markers. */
export const INTENT_PREFIX = '[driver-action]';
export const DOM_EVENT_PREFIX = '[dom-event]';

/** Env flag that gates action logging. Default ON — only an explicit "0"/"false"/"off" disables it. */
export const ACTION_LOG_ENV = 'KEEPR_QA_ACTION_LOG';

/** Max characters of resolved element text kept in a log line (keeps lines greppable + single-line). */
export const DEFAULT_TEXT_MAX = 60;

/**
 * True unless the env var is explicitly set to a falsy value. Logging is ON BY DEFAULT for driver
 * runs so the founder never has to remember to enable it; set KEEPR_QA_ACTION_LOG=0 to silence.
 */
export function isActionLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ACTION_LOG_ENV];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * Collapse an element's visible text to a SINGLE, trimmed, length-bounded line. Newlines/tabs and
 * runs of whitespace become single spaces so a multi-line button label never breaks the log format.
 */
export function truncateText(text: string | null | undefined, max: number = DEFAULT_TEXT_MAX): string {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  // Reserve one char for the ellipsis so the whole field never exceeds `max`.
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

/** Format a Date as HH:MM:SS.mmm in local time (zero-padded), for the intent line timestamp. */
export function formatClock(at: Date = new Date()): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const p3 = (n: number): string => String(n).padStart(3, '0');
  return `${p2(at.getHours())}:${p2(at.getMinutes())}:${p2(at.getSeconds())}.${p3(at.getMilliseconds())}`;
}

/**
 * Build an INTENT line. `target` is a testid (preferred) or a raw selector/role description when no
 * testid exists. Always single-line and greppable via INTENT_PREFIX.
 *
 *   [driver-action] 14:03:09.512 press testid=nav-new-audit text="New Audit"
 */
export function formatIntentLine(
  verb: ActionVerb,
  target: string,
  text: string | null | undefined,
  at: Date = new Date(),
  max: number = DEFAULT_TEXT_MAX,
): string {
  return `${INTENT_PREFIX} ${formatClock(at)} ${verb} testid=${target} text="${truncateText(text, max)}"`;
}

/**
 * Build a REALITY line from a captured DOM event. `type` is the real DOM event name
 * (pointerover | mousedown | click). Kept format-compatible with the init-script's own output so a
 * line produced in the renderer and a line re-emitted by the driver read identically.
 *
 *   [dom-event] click testid=nav-new-audit text="New Audit"
 */
export function formatDomEventLine(
  type: string,
  target: string,
  text: string | null | undefined,
  max: number = DEFAULT_TEXT_MAX,
): string {
  return `${DOM_EVENT_PREFIX} ${type} testid=${target} text="${truncateText(text, max)}"`;
}

/**
 * Match a `[dom-event] …` line as produced by DOM_CAPTURE_INIT_SCRIPT inside the renderer, so the
 * driver's console listener can recognise which console messages to re-emit. Only the prefix is
 * required to match — the driver forwards the whole line verbatim.
 */
export const DOM_EVENT_CONSOLE_RE = /^\[dom-event\]\s/;

/** A sink for log lines. Defaults to console.log; injectable so unit tests capture output. */
export type LogSink = (line: string) => void;

/**
 * Small logger the driver owns. Emits INTENT lines (before an action) and re-emits DOM-event
 * REALITY lines (from the captured renderer console). Honours KEEPR_QA_ACTION_LOG — when disabled
 * every method is a no-op, so wiring it into the driver has ZERO output cost when turned off.
 *
 * Every method is best-effort and swallows sink errors: logging can NEVER fail a driver step.
 */
export class ActionLogger {
  private readonly sink: LogSink;
  private readonly enabled: boolean;
  private readonly max: number;

  constructor(opts: { sink?: LogSink; enabled?: boolean; max?: number } = {}) {
    // eslint-disable-next-line no-console
    this.sink = opts.sink ?? ((line: string) => console.log(line));
    this.enabled = opts.enabled ?? isActionLogEnabled();
    this.max = opts.max ?? DEFAULT_TEXT_MAX;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Emit an INTENT line for an action the driver is ABOUT to perform. */
  intent(verb: ActionVerb, target: string, text?: string | null): void {
    if (!this.enabled) return;
    this.write(formatIntentLine(verb, target, text, new Date(), this.max));
  }

  /** Re-emit a REALITY line for a DOM event observed in the renderer (already prefixed). */
  domEvent(type: string, target: string, text?: string | null): void {
    if (!this.enabled) return;
    this.write(formatDomEventLine(type, target, text, this.max));
  }

  /**
   * Forward a raw console line from the renderer that already carries the [dom-event] prefix.
   * Used by the page.on('console') listener so the renderer's own formatting passes through
   * verbatim (single source of truth for the reality line's shape).
   */
  forwardConsoleLine(line: string): void {
    if (!this.enabled) return;
    if (!DOM_EVENT_CONSOLE_RE.test(line)) return;
    this.write(line);
  }

  private write(line: string): void {
    try {
      this.sink(line);
    } catch {
      // Logging must never throw into a driver step.
    }
  }
}

/**
 * Renderer-side DOM capture, shipped as a SOURCE STRING and installed via page.addInitScript so it
 * runs before app scripts on every document. It installs capture-phase listeners for
 * pointerover / mousedown / click on interactive elements and console.logs one greppable
 * `[dom-event] <type> testid=<...> text="<...>"` line per event — the "reality" the driver diffs
 * against its "intent". Self-contained (no imports); DEFAULT_TEXT_MAX is inlined as a literal so the
 * string has no external references. Idempotent via a window flag so a double-install is harmless.
 */
export const DOM_CAPTURE_INIT_SCRIPT = String.raw`
(() => {
  try {
    var FLAG = '__keeprDomEventCaptureInstalled';
    if (window[FLAG]) return;
    window[FLAG] = true;

    var MAX = ${DEFAULT_TEXT_MAX};
    var PREFIX = '[dom-event]';

    function trunc(s) {
      if (!s) return '';
      var c = String(s).replace(/\s+/g, ' ').trim();
      if (c.length <= MAX) return c;
      return c.slice(0, Math.max(0, MAX - 1)) + '…';
    }

    // Nearest interactive ancestor (so a click on a <span> inside a <button> reports the button).
    function interactiveTarget(el) {
      var node = el;
      while (node && node.nodeType === 1) {
        if (
          node.hasAttribute('data-testid') ||
          node.tagName === 'BUTTON' ||
          node.getAttribute('role') === 'button' ||
          node.tagName === 'A'
        ) {
          return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    function describe(el) {
      var testid = el.getAttribute('data-testid');
      if (testid) return 'testid=' + testid;
      var role = el.getAttribute('role');
      if (role) return 'role=' + role;
      return 'tag=' + el.tagName.toLowerCase();
    }

    function handler(type) {
      return function (ev) {
        try {
          var el = interactiveTarget(ev.target);
          if (!el) return;
          var text = trunc(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          // Console line is the single source of truth for the reality format; the driver forwards
          // it verbatim once captured via page.on('console').
          // eslint-disable-next-line no-console
          console.log(PREFIX + ' ' + type + ' ' + describe(el) + ' text="' + text + '"');
        } catch (e) {
          /* never let logging break the app */
        }
      };
    }

    // Capture phase (true) so we observe the event even if the app stops propagation.
    document.addEventListener('pointerover', handler('pointerover'), true);
    document.addEventListener('mousedown', handler('mousedown'), true);
    document.addEventListener('click', handler('click'), true);
  } catch (e) {
    /* capture install is best-effort; app must run regardless */
  }
})();
`;
