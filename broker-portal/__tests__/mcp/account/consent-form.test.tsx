/**
 * BACKLOG-4238 — the consent form: no form element, buttons disabled in the
 * server render and while a choice is pending, the nonce of the current props,
 * navigation from the awaited result (also after unmount), https only.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderToString } from 'react-dom/server';

const mockApprove = jest.fn();
const mockDeny = jest.fn();
const mockLeaveTo = jest.fn();
jest.mock('@/lib/mcp/account/actions', () => ({
  approveAiApp: (...a: unknown[]) => mockApprove(...a),
  denyAiApp: (...a: unknown[]) => mockDeny(...a),
}));
jest.mock('@/lib/mcp/account/navigate', () => ({ leaveTo: (...a: unknown[]) => mockLeaveTo(...a) }));

import { ConsentForm } from '@/app/dashboard/account/ai-apps/connect/[requestId]/ConsentForm';
import { CONSENT, M_C } from '@/lib/mcp/account/messages';
import { NONCE, NONCE_2, REQUEST_ID } from './fixtures';

const LOCATION = 'https://callback.example.test/cb?code=x&iss=https%3A%2F%2Fportal.test';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  mockApprove.mockReset();
  mockDeny.mockReset();
  mockLeaveTo.mockReset();
});

const allow = () => screen.getByRole('button', { name: CONSENT.allow });
const deny = () => screen.getByRole('button', { name: CONSENT.deny });

describe('server render', () => {
  it('both buttons are disabled and there is no form element', () => {
    const html = renderToString(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    expect(html).not.toContain('<form');
    const tags = html.match(/<button[^>]*>/g) ?? [];
    expect(tags).toHaveLength(2);
    for (const t of tags) {
      expect(t).toMatch(/\sdisabled=""/);
      expect(t).toContain('type="button"');
    }
  });
});

describe('after mount', () => {
  it('both buttons are enabled', () => {
    render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    expect(allow()).toBeEnabled();
    expect(deny()).toBeEnabled();
  });

  it('Allow calls approveAiApp with exactly the request id and nonce, and leaves to the returned https address', async () => {
    mockApprove.mockResolvedValue({ kind: 'redirect', location: LOCATION });
    render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    expect(mockApprove.mock.calls).toEqual([[REQUEST_ID, NONCE]]);
    expect(mockLeaveTo.mock.calls).toEqual([[LOCATION]]);
  });

  it('Deny calls denyAiApp with exactly the request id and nonce', async () => {
    mockDeny.mockResolvedValue({ kind: 'redirect', location: LOCATION });
    render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(deny());
    });
    expect(mockDeny.mock.calls).toEqual([[REQUEST_ID, NONCE]]);
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockLeaveTo.mock.calls).toEqual([[LOCATION]]);
  });

  it('both buttons are disabled while a choice is pending, and a second click sends nothing', async () => {
    const d = deferred<unknown>();
    mockApprove.mockReturnValue(d.promise);
    render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    expect(screen.getByRole('button', { name: CONSENT.allowing })).toBeDisabled();
    expect(deny()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: CONSENT.allowing }));
    fireEvent.click(deny());
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockDeny).not.toHaveBeenCalled();
    await act(async () => {
      d.resolve({ kind: 'refused', message: M_C.requestInvalid });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.requestInvalid);
    expect(allow()).toBeEnabled();
  });

  it.each(['http://callback.example.test/cb', 'javascript:alert(1)', '//callback.example.test/cb', '/dashboard'])(
    'a returned address %s is not followed',
    async (location) => {
      mockApprove.mockResolvedValue({ kind: 'redirect', location });
      render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
      await act(async () => {
        fireEvent.click(allow());
      });
      expect(mockLeaveTo).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(M_C.noReturn);
    }
  );

  it('a refusal shows its message and leaves nowhere', async () => {
    mockApprove.mockResolvedValue({ kind: 'refused', message: M_C.notEntitled });
    render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.notEntitled);
    expect(mockLeaveTo).not.toHaveBeenCalled();
  });

  it('a thrown action shows the fixed message', async () => {
    mockApprove.mockRejectedValue(new Error('raw text'));
    render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
  });
});

describe('re-render tolerance', () => {
  it('after a re-render with a new nonce, Allow sends the new nonce', async () => {
    mockApprove.mockResolvedValue({ kind: 'refused', message: M_C.requestInvalid });
    const { rerender } = render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    rerender(<ConsentForm requestId={REQUEST_ID} nonce={NONCE_2} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    expect(mockApprove.mock.calls).toEqual([[REQUEST_ID, NONCE_2]]);
  });

  it('a nonce change while a choice is pending does not break the next click', async () => {
    const d = deferred<unknown>();
    mockApprove.mockReturnValueOnce(d.promise);
    mockApprove.mockResolvedValueOnce({ kind: 'redirect', location: LOCATION });
    const { rerender } = render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    rerender(<ConsentForm requestId={REQUEST_ID} nonce={NONCE_2} />);
    await act(async () => {
      d.resolve({ kind: 'refused', message: M_C.requestInvalid });
    });
    await act(async () => {
      fireEvent.click(allow());
    });
    expect(mockApprove.mock.calls).toEqual([
      [REQUEST_ID, NONCE],
      [REQUEST_ID, NONCE_2],
    ]);
    expect(mockLeaveTo).toHaveBeenCalledWith(LOCATION);
  });

  it('a completed approve still navigates when the form was unmounted before it resolved', async () => {
    const d = deferred<unknown>();
    mockApprove.mockReturnValue(d.promise);
    const { unmount } = render(<ConsentForm requestId={REQUEST_ID} nonce={NONCE} />);
    await act(async () => {
      fireEvent.click(allow());
    });
    unmount();
    await act(async () => {
      d.resolve({ kind: 'redirect', location: LOCATION });
    });
    expect(mockLeaveTo.mock.calls).toEqual([[LOCATION]]);
  });
});
