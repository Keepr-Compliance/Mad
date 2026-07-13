/**
 * Unit proofs for the QA driver's action logging (BACKLOG-1969).
 *
 * These are the founder's guarantee that the "intent" and "reality" log lines have a STABLE,
 * greppable, diffable shape — so a run can be self-verified ("the driver pressed X, the DOM
 * delivered the event to X") without re-reading the whole transcript.
 *
 * Pure module → no app launch, no Playwright. Runs under `npm test` (and in CI via the
 * e2e/driver/__tests__ glob).
 */
import {
  ACTION_LOG_ENV,
  ActionLogger,
  DOM_CAPTURE_INIT_SCRIPT,
  DOM_EVENT_CONSOLE_RE,
  DOM_EVENT_PREFIX,
  formatClock,
  formatDomEventLine,
  formatIntentLine,
  INTENT_PREFIX,
  isActionLogEnabled,
  truncateText,
} from '../actionLog';

describe('formatIntentLine produces the exact greppable intent format', () => {
  const at = new Date(2026, 6, 11, 14, 3, 9, 512); // local 14:03:09.512

  it('renders "[driver-action] <clock> <verb> testid=<t> text=<text>" for a testid + text', () => {
    expect(formatIntentLine('press', 'nav-new-audit', 'New Audit', at)).toBe(
      '[driver-action] 14:03:09.512 press testid=nav-new-audit text="New Audit"',
    );
  });

  it('supports all three verbs', () => {
    expect(formatIntentLine('hover', 'nav-transactions', 'Transactions', at)).toBe(
      '[driver-action] 14:03:09.512 hover testid=nav-transactions text="Transactions"',
    );
    expect(formatIntentLine('fill', 'input[type=date]:start', '2026-01-01', at)).toBe(
      '[driver-action] 14:03:09.512 fill testid=input[type=date]:start text="2026-01-01"',
    );
  });

  it('carries a non-testid selector in the same testid= field (role/data-action fallbacks)', () => {
    expect(formatIntentLine('press', 'data-action=skip', 'Skip', at)).toBe(
      '[driver-action] 14:03:09.512 press testid=data-action=skip text="Skip"',
    );
  });

  it('empty/missing text yields text=""', () => {
    expect(formatIntentLine('press', 'nav-settings', '', at)).toBe(
      '[driver-action] 14:03:09.512 press testid=nav-settings text=""',
    );
    expect(formatIntentLine('press', 'nav-settings', null, at)).toBe(
      '[driver-action] 14:03:09.512 press testid=nav-settings text=""',
    );
  });

  it('is always prefixed so it can be grepped', () => {
    expect(formatIntentLine('press', 't', 'x', at).startsWith(INTENT_PREFIX)).toBe(true);
  });
});

describe('formatDomEventLine produces the exact greppable reality format', () => {
  it('renders "[dom-event] <type> testid=<t> text=<text>"', () => {
    expect(formatDomEventLine('click', 'nav-new-audit', 'New Audit')).toBe(
      '[dom-event] click testid=nav-new-audit text="New Audit"',
    );
    expect(formatDomEventLine('pointerover', 'nav-transactions', 'Transactions')).toBe(
      '[dom-event] pointerover testid=nav-transactions text="Transactions"',
    );
  });

  it('is recognised by the console re-emit regex; a non-dom-event line is not', () => {
    const line = formatDomEventLine('mousedown', 'nav-profile', 'Profile');
    expect(DOM_EVENT_CONSOLE_RE.test(line)).toBe(true);
    expect(DOM_EVENT_CONSOLE_RE.test('[driver-action] 00:00:00.000 press testid=x text="y"')).toBe(false);
    expect(DOM_EVENT_CONSOLE_RE.test('some unrelated console noise')).toBe(false);
  });

  it('is prefixed with DOM_EVENT_PREFIX', () => {
    expect(formatDomEventLine('click', 't', 'x').startsWith(DOM_EVENT_PREFIX)).toBe(true);
  });
});

describe('intent and reality lines are diffable on the same testid', () => {
  const at = new Date(2026, 6, 11, 9, 0, 0, 0);
  it('a matching press+click share the same testid= and text= fields', () => {
    const intent = formatIntentLine('press', 'nav-new-audit', 'New Audit', at);
    const reality = formatDomEventLine('click', 'nav-new-audit', 'New Audit');
    // Extract the "testid=<...> text=<...>" tail from each and confirm they match.
    const tail = (s: string): string => s.slice(s.indexOf('testid='));
    expect(tail(intent)).toBe(tail(reality));
  });

  it('a MISMATCH (driver pressed A, DOM delivered to B) is visible in the tail', () => {
    const intent = formatIntentLine('press', 'nav-new-audit', 'New Audit', at);
    const reality = formatDomEventLine('click', 'nav-clients-contacts', 'Clients');
    const tail = (s: string): string => s.slice(s.indexOf('testid='));
    expect(tail(intent)).not.toBe(tail(reality));
  });
});

describe('truncateText keeps lines single-line and bounded', () => {
  it('collapses whitespace/newlines to single spaces and trims', () => {
    expect(truncateText('  New\n\tAudit  ')).toBe('New Audit');
  });

  it('truncates to max with an ellipsis, never exceeding max', () => {
    const out = truncateText('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(out.length).toBe(5);
  });

  it('returns "" for null/undefined/empty', () => {
    expect(truncateText(null)).toBe('');
    expect(truncateText(undefined)).toBe('');
    expect(truncateText('')).toBe('');
  });
});

describe('formatClock is HH:MM:SS.mmm, zero-padded', () => {
  it('zero-pads every field', () => {
    expect(formatClock(new Date(2026, 0, 1, 1, 2, 3, 4))).toBe('01:02:03.004');
  });
  it('renders a full time correctly', () => {
    expect(formatClock(new Date(2026, 0, 1, 23, 59, 59, 999))).toBe('23:59:59.999');
  });
});

describe('isActionLogEnabled: default ON, only explicit falsy disables', () => {
  it('undefined (unset) → enabled', () => {
    expect(isActionLogEnabled({})).toBe(true);
  });
  it('"1"/"true"/anything-else → enabled', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'whatever']) {
      expect(isActionLogEnabled({ [ACTION_LOG_ENV]: v })).toBe(true);
    }
  });
  it('"0"/"false"/"off"/"no" (any case) → disabled', () => {
    for (const v of ['0', 'false', 'FALSE', 'off', 'Off', 'no', 'NO']) {
      expect(isActionLogEnabled({ [ACTION_LOG_ENV]: v })).toBe(false);
    }
  });
});

describe('ActionLogger routes to an injectable sink and honours the enable flag', () => {
  it('emits intent + forwarded dom-event lines when enabled', () => {
    const lines: string[] = [];
    const log = new ActionLogger({ sink: (l) => lines.push(l), enabled: true });
    expect(log.isEnabled).toBe(true);
    log.intent('press', 'nav-settings', 'Settings');
    log.domEvent('click', 'nav-settings', 'Settings');
    log.forwardConsoleLine('[dom-event] pointerover testid=nav-settings text="Settings"');
    log.forwardConsoleLine('not a dom-event line — dropped');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[driver-action\] \d\d:\d\d:\d\d\.\d\d\d press testid=nav-settings text="Settings"$/);
    expect(lines[1]).toBe('[dom-event] click testid=nav-settings text="Settings"');
    expect(lines[2]).toBe('[dom-event] pointerover testid=nav-settings text="Settings"');
  });

  it('is a complete no-op when disabled', () => {
    const lines: string[] = [];
    const log = new ActionLogger({ sink: (l) => lines.push(l), enabled: false });
    log.intent('press', 't', 'x');
    log.domEvent('click', 't', 'x');
    log.forwardConsoleLine('[dom-event] click testid=t text="x"');
    expect(lines).toHaveLength(0);
  });

  it('never throws even if the sink throws', () => {
    const log = new ActionLogger({
      sink: () => {
        throw new Error('sink blew up');
      },
      enabled: true,
    });
    expect(() => log.intent('press', 't', 'x')).not.toThrow();
  });
});

describe('DOM_CAPTURE_INIT_SCRIPT captures real DOM events as parseable [dom-event] lines', () => {
  it('logs one [dom-event] line per click, reporting the nearest interactive ancestor testid + text', () => {
    // Minimal DOM stub: a document with capture-phase listeners + elements. No jsdom needed — we
    // model exactly the surface the init script touches (addEventListener capture + element props).
    const logged: string[] = [];
    type Listener = (ev: { target: FakeEl }) => void;
    const captureListeners: Record<string, Listener[]> = {};

    class FakeEl {
      nodeType = 1;
      tagName: string;
      attrs: Record<string, string>;
      innerText: string;
      parentElement: FakeEl | null = null;
      constructor(tagName: string, attrs: Record<string, string> = {}, innerText = '') {
        this.tagName = tagName.toUpperCase();
        this.attrs = attrs;
        this.innerText = innerText;
      }
      hasAttribute(n: string): boolean {
        return n in this.attrs;
      }
      getAttribute(n: string): string | null {
        return n in this.attrs ? this.attrs[n] : null;
      }
      get textContent(): string {
        return this.innerText;
      }
    }

    const fakeWindow: Record<string, unknown> = {};
    const fakeDocument = {
      addEventListener(type: string, fn: Listener, capture: boolean): void {
        if (!capture) return;
        (captureListeners[type] ??= []).push(fn);
      },
    };
    const fakeConsole = { log: (line: string) => logged.push(line) };

    // Evaluate the init-script source with our stubs bound as window/document/console.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const run = new Function('window', 'document', 'console', DOM_CAPTURE_INIT_SCRIPT);
    run(fakeWindow, fakeDocument, fakeConsole);

    // Build: <button data-testid="nav-new-audit"><span>New Audit</span></button>; click the span.
    const button = new FakeEl('button', { 'data-testid': 'nav-new-audit' }, 'New Audit');
    const span = new FakeEl('span', {}, 'New Audit');
    span.parentElement = button;

    // Fire a capture-phase click at the inner span.
    for (const fn of captureListeners['click'] ?? []) fn({ target: span });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toBe('[dom-event] click testid=nav-new-audit text="New Audit"');
    expect(DOM_EVENT_CONSOLE_RE.test(logged[0])).toBe(true);
  });

  it('is idempotent — a second install does not double-register listeners', () => {
    const logged: string[] = [];
    type Listener = (ev: { target: unknown }) => void;
    const captureListeners: Record<string, Listener[]> = {};
    const fakeWindow: Record<string, unknown> = {};
    const fakeDocument = {
      addEventListener(type: string, fn: Listener, capture: boolean): void {
        if (!capture) return;
        (captureListeners[type] ??= []).push(fn);
      },
    };
    const fakeConsole = { log: (line: string) => logged.push(line) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const run = new Function('window', 'document', 'console', DOM_CAPTURE_INIT_SCRIPT);
    run(fakeWindow, fakeDocument, fakeConsole);
    run(fakeWindow, fakeDocument, fakeConsole); // second install — guarded by the window flag
    expect((captureListeners['click'] ?? []).length).toBe(1);
  });
});
