/**
 * The /download page with the Microsoft Store badge — BACKLOG-4067 (C5, C4a).
 *
 * The page had no tests before this item. These pin the parts the badge must
 * not disturb: the installer stays the primary link, the 500 ms auto-download
 * still fires, and the badge stays on screen after it fires (a user whose
 * .exe was blocked looks for an alternative exactly then).
 */

import { act, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import DownloadPage from '@/app/download/page';

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Synthetic, well-formed XP-shape id. Not Keepr's real listing id. */
const FIXTURE_STORE_ID = 'XPAAAAAAAAAAAA';
const STORE_LINK = /Download from the Microsoft Store/;

const originalUA = navigator.userAgent;
const originalEnv = process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID;

function setUA(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  jest.useFakeTimers();
  process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID = FIXTURE_STORE_ID;
});

afterEach(() => {
  jest.useRealTimers();
  setUA(originalUA);
  if (originalEnv === undefined) delete process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID;
  else process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID = originalEnv;
});

describe('/download on Windows', () => {
  it('C5a: the installer is the primary link', () => {
    setUA(WINDOWS_UA);
    render(<DownloadPage />);
    expect(screen.getByRole('link', { name: 'Download for Windows' })).toHaveAttribute(
      'href',
      '/api/download?platform=windows',
    );
  });

  it('C5c: the auto-download still starts after 500 ms', () => {
    setUA(WINDOWS_UA);
    render(<DownloadPage />);
    expect(screen.queryByText(/Your download should begin automatically/)).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByText(/Your download should begin automatically/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'click here' })).toHaveAttribute(
      'href',
      '/api/download?platform=windows',
    );
  });

  it('C5b/C4a: the Store badge is shown, and is still shown after the auto-download starts', () => {
    setUA(WINDOWS_UA);
    render(<DownloadPage />);
    const before = screen.getByRole('link', { name: STORE_LINK });
    expect(before).toHaveAttribute('href', `https://apps.microsoft.com/detail/${FIXTURE_STORE_ID}?mode=full`);
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(screen.getByRole('link', { name: STORE_LINK })).toBeInTheDocument();
    // The installer is still offered alongside it.
    expect(screen.getByRole('link', { name: 'Download for Windows' })).toBeInTheDocument();
  });
});

describe('/download on a Mac', () => {
  it('C4a: no Store badge', () => {
    setUA(MAC_UA);
    render(<DownloadPage />);
    expect(screen.getByRole('link', { name: 'Download for macOS (Apple Silicon)' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: STORE_LINK })).not.toBeInTheDocument();
  });
});

describe('/download on Windows with no Store ID', () => {
  it('C3: no badge and no caption', () => {
    setUA(WINDOWS_UA);
    delete process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID;
    render(<DownloadPage />);
    expect(screen.queryByRole('link', { name: STORE_LINK })).not.toBeInTheDocument();
    expect(screen.queryByText('Or get it from the Microsoft Store')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download for Windows' })).toBeInTheDocument();
  });
});
