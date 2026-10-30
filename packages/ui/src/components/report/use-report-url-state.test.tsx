import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextEncoder } from 'util';
import { useReportUrlState, type UrlStateCodec } from './use-report-url-state';
import { readList, writeParam } from './url-params';

interface S {
  outcomes: string[];
}
const codec: UrlStateCodec<S> = {
  parse: (params) => ({ outcomes: readList(params.get('outcome') ?? undefined) }),
  write: (params, state) => writeParam(params, 'outcome', state.outcomes.join(',')),
};

function Report({ initial }: { initial: S }) {
  const [state, setState] = useReportUrlState(codec, initial);
  return (
    <>
      <button type="button" onClick={() => setState({ outcomes: [...state.outcomes, 'failed'] })}>
        add
      </button>
      <button type="button" onClick={() => setState({ outcomes: [] })}>
        clear
      </button>
    </>
  );
}

describe('useReportUrlState', () => {
  let push: jest.SpyInstance;
  let replace: jest.SpyInstance;
  beforeEach(() => {
    window.history.replaceState(null, '', '/reports/x?period=month&keep=1');
    push = jest.spyOn(window.history, 'pushState');
    replace = jest.spyOn(window.history, 'replaceState');
  });
  afterEach(() => {
    push.mockRestore();
    replace.mockRestore();
  });

  it('mirrors state into the URL with replaceState, keeping params it does not own', () => {
    render(<Report initial={{ outcomes: [] }} />);
    expect(window.location.search).toBe('?period=month&keep=1');
    fireEvent.click(screen.getByText('add'));
    expect(window.location.search).toBe('?period=month&keep=1&outcome=failed');
    fireEvent.click(screen.getByText('clear'));
    expect(window.location.search).toBe('?period=month&keep=1');
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('falls back to the bare path when no params are left', () => {
    window.history.replaceState(null, '', '/reports/x?outcome=failed');
    render(<Report initial={codec.parse(new URLSearchParams(window.location.search))} />);
    fireEvent.click(screen.getByText('clear'));
    // A bare trailing "?" reads as an empty search, so check the URL written.
    expect(replace.mock.calls[replace.mock.calls.length - 1][2]).toBe('/reports/x');
    expect(window.location.href.endsWith('/reports/x')).toBe(true);
  });

  it('renders on the server without touching history', () => {
    // jsdom lacks TextEncoder, which react-dom/server needs at load time.
    (globalThis as unknown as { TextEncoder: unknown }).TextEncoder ??= TextEncoder;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { renderToString } = require('react-dom/server') as typeof import('react-dom/server');
    replace.mockClear();
    expect(renderToString(<Report initial={{ outcomes: [] }} />)).toContain('add');
    expect(replace).not.toHaveBeenCalled();
  });
});
