/**
 * Unit proofs for the driver's public logged hover()/press() (BACKLOG-1971).
 *
 * These guarantee that the two net-new public actions emit the EXACT, greppable `[driver-action]`
 * INTENT line — correct verb, target (testid, or the caller's label override), resolved element
 * text — and that the intent is logged BEFORE the Playwright action fires (so the driver's intent
 * always precedes the DOM's reality in the interleaved log).
 *
 * Pure Node → no app launch, no real Playwright. We drive a REAL KeeprAppDriver instance against a
 * hand-rolled fake Page/Locator and capture the driver's default ActionLogger sink (console.log).
 * The `private` constructor is a compile-time-only guard (erased at runtime), so the test bypasses
 * it with a cast — no production API is widened for the sake of testing. Runs under the CI Node-jest
 * glob (e2e/driver/__tests__/**), same as the outcome + action-log proofs.
 */
import { ActionLogger } from '../actionLog';
import { KeeprAppDriver } from '../appDriver';

/** A fake Playwright Locator that records the ordered calls made against it. */
class FakeLocator {
  readonly calls: string[] = [];
  constructor(
    private readonly text: string,
    private readonly onAction: (verb: string) => void,
  ) {}
  first(): FakeLocator {
    return this;
  }
  locator(_sel: string): FakeLocator {
    return this;
  }
  async waitFor(): Promise<void> {
    this.calls.push('waitFor');
  }
  async innerText(): Promise<string> {
    this.calls.push('innerText');
    return this.text;
  }
  async hover(): Promise<void> {
    this.calls.push('hover');
    this.onAction('hover');
  }
  async click(): Promise<void> {
    this.calls.push('click');
    this.onAction('click');
  }
}

/** A fake Page exposing only getByTestId, returning a shared FakeLocator keyed by testid text. */
class FakePage {
  constructor(
    private readonly textByTestid: Record<string, string>,
    private readonly onAction: (verb: string) => void,
    readonly locators: Record<string, FakeLocator> = {},
  ) {}
  getByTestId(testid: string): FakeLocator {
    const loc = new FakeLocator(this.textByTestid[testid] ?? '', this.onAction);
    this.locators[testid] = loc;
    return loc;
  }
}

/** Build a driver whose `page`/`actionLog` are our fakes; capture every emitted log line. */
function makeDriver(textByTestid: Record<string, string>): {
  driver: KeeprAppDriver;
  lines: string[];
  actionOrder: string[];
} {
  const lines: string[] = [];
  const actionOrder: string[] = [];
  // Instantiate past the compile-time-private constructor (erased at runtime).
  const driver = new (KeeprAppDriver as unknown as new (repoRoot: string, opts: object) => KeeprAppDriver)(
    '/tmp/repo',
    {},
  );
  const page = new FakePage(textByTestid, (verb) => actionOrder.push(`action:${verb}`));
  // Wire the fakes into the private fields (typed as unknown to reach the internals in-test only).
  const internal = driver as unknown as { handle: { page: FakePage }; actionLog: ActionLogger };
  internal.handle = { page };
  // Use a REAL ActionLogger with a fixed clock + capturing sink so the test exercises the actual
  // production intent-formatting (formatIntentLine), not a hand-rolled stub. Record ordering by
  // tapping the sink (which the driver calls strictly before the Playwright action).
  internal.actionLog = new ActionLogger({
    enabled: true,
    sink: (line: string) => {
      // Normalize the wall-clock timestamp to a fixed value so the assertion is deterministic.
      lines.push(line.replace(/\b\d\d:\d\d:\d\d\.\d\d\d\b/, '00:00:00.000'));
      actionOrder.push(`intent:${line.split(' ')[2]}`); // tokens: [driver-action] <clock> <verb> …
    },
  });
  return { driver, lines, actionOrder };
}

describe('press() logs a [driver-action] press intent then clicks (BACKLOG-1971)', () => {
  it('emits verb=press, target=testid, resolved text — BEFORE the click', async () => {
    const { driver, lines, actionOrder } = makeDriver({ 'nav-new-audit': 'New Audit' });
    await driver.press('nav-new-audit');
    expect(lines).toEqual(['[driver-action] 00:00:00.000 press testid=nav-new-audit text="New Audit"']);
    // Intent MUST precede the action (the whole point of intent-vs-reality).
    expect(actionOrder).toEqual(['intent:press', 'action:click']);
  });

  it('uses the label override as the logged target when provided', async () => {
    const { driver, lines } = makeDriver({ 'nav-profile': 'Profile' });
    await driver.press('nav-profile', 'role=button:Profile');
    expect(lines[0]).toBe('[driver-action] 00:00:00.000 press testid=role=button:Profile text="Profile"');
  });
});

describe('hover() logs a [driver-action] hover intent then hovers (BACKLOG-1971)', () => {
  it('emits verb=hover, target=testid, resolved text — BEFORE the hover', async () => {
    const { driver, lines, actionOrder } = makeDriver({ 'nav-transactions': 'Transactions' });
    await driver.hover('nav-transactions');
    expect(lines).toEqual(['[driver-action] 00:00:00.000 hover testid=nav-transactions text="Transactions"']);
    expect(actionOrder).toEqual(['intent:hover', 'action:hover']);
  });

  it('uses the label override as the logged target when provided', async () => {
    const { driver, lines } = makeDriver({ 'tour-step': 'Next' });
    await driver.hover('tour-step', 'data-action=next');
    expect(lines[0]).toBe('[driver-action] 00:00:00.000 hover testid=data-action=next text="Next"');
  });
});
