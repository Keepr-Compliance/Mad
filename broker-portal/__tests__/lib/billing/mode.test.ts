/**
 * @jest-environment node
 *
 * BACKLOG-3845 — lib/billing/mode.ts. The mode comes from the key prefix only;
 * anything unrecognised throws rather than defaulting to a mode.
 */
import {
  currentStripeMode,
  eventMatchesCurrentMode,
  eventStripeMode,
  stripeModeFromKey,
} from '@/lib/billing/mode';

describe('stripeModeFromKey', () => {
  it.each([
    ['sk_test_abc', 'test'],
    ['rk_test_abc', 'test'],
    ['sk_live_abc', 'live'],
    ['rk_live_abc', 'live'],
  ])('%s → %s', (key, mode) => {
    expect(stripeModeFromKey(key)).toBe(mode);
  });

  it.each([[''], [undefined], [null], ['pk_live_abc'], ['sk_abc'], ['whsec_abc'], ['SK_LIVE_abc'], [' sk_live_abc']])(
    'refuses %p',
    (key) => {
      expect(() => stripeModeFromKey(key as string | undefined)).toThrow();
    }
  );
});

describe('currentStripeMode', () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = saved;
  });

  it('reads the key on every call (no memo)', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(currentStripeMode()).toBe('test');
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    expect(currentStripeMode()).toBe('live');
  });

  it('event mode follows livemode and is compared with the key', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    expect(eventStripeMode({ livemode: true })).toBe('live');
    expect(eventStripeMode({ livemode: false })).toBe('test');
    expect(eventMatchesCurrentMode({ livemode: true })).toBe(true);
    expect(eventMatchesCurrentMode({ livemode: false })).toBe(false);
  });
});
