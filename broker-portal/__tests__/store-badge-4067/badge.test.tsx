/**
 * MicrosoftStoreBadge and its id rules — BACKLOG-4067 (C1-C3, C4b).
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MicrosoftStoreBadge } from '@/components/download/MicrosoftStoreBadge';
import { FloorDashboard } from '@/app/dashboard/components/FloorDashboard';
import { microsoftStoreUrl } from '@/lib/download/microsoftStore';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/** Synthetic ids of each real shape. Not Keepr's listing id. */
const XP_ID = 'XPAAAAAAAAAAAA';
const NINE_ID = '9AAAAAAAAAAA';
const STORE_LINK = /Download from the Microsoft Store/;
const STORE_HREF = /^https:\/\/apps\.microsoft\.com\/detail\/(9[0-9A-Z]{11}|XP[0-9A-Z]{12})\?mode=full$/;

const originalUA = navigator.userAgent;
const originalEnv = process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID;
const setUA = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  setUA(originalUA);
  if (originalEnv === undefined) delete process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID;
  else process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID = originalEnv;
});

describe('C1: Windows + valid id', () => {
  it.each([XP_ID, NINE_ID])('%s: links to the listing with the vendored art', (id) => {
    setUA(WINDOWS_UA);
    render(<MicrosoftStoreBadge productId={id} />);
    const link = screen.getByRole('link', { name: STORE_LINK });
    expect(link.getAttribute('href')).toMatch(STORE_HREF);
    expect(link).toHaveAttribute('href', `https://apps.microsoft.com/detail/${id}?mode=full`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.className).toMatch(/focus-visible:ring-2/);
    expect(link).toHaveTextContent('(opens in a new tab)');
    const img = screen.getByRole('img', { name: 'Download from the Microsoft Store' });
    expect(img).toHaveAttribute('src', '/badges/microsoft-store-dark.svg');
    expect(img).toHaveAttribute('width', '200');
    expect(img).toHaveAttribute('height', '55');
  });

  it('reads the env var when no prop is given', () => {
    setUA(WINDOWS_UA);
    process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID = XP_ID;
    render(<MicrosoftStoreBadge />);
    expect(screen.getByRole('link', { name: STORE_LINK })).toHaveAttribute('href', `https://apps.microsoft.com/detail/${XP_ID}?mode=full`);
  });
});

describe('C2: not Windows -> nothing', () => {
  it.each([['Mac', MAC_UA], ['iPhone', IPHONE_UA], ['Android', ANDROID_UA]])('%s', (_n, ua) => {
    setUA(ua);
    const { container } = render(<MicrosoftStoreBadge productId={XP_ID} label="Or get it" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('show={false} hides it even on Windows', () => {
    setUA(WINDOWS_UA);
    const { container } = render(<MicrosoftStoreBadge productId={XP_ID} show={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('C3: empty or invalid id -> nothing, never a broken link', () => {
  it.each([
    ['empty', ''],
    ['Partner Center GUID', '00000000-0000-0000-0000-000000000000'],
    ['placeholder', '<KEEPR_PRODUCT_ID>'],
    ['truncated XP id', 'XPAAAAAAAAAA'],
    ['lower case', 'xpaaaaaaaaaaaa'],
    ['too long', 'XPAAAAAAAAAAAAA'],
  ])('%s', (_n, id) => {
    setUA(WINDOWS_UA);
    const { container } = render(<MicrosoftStoreBadge productId={id} label="Or get it" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('unset env var -> nothing, no warning', () => {
    setUA(WINDOWS_UA);
    delete process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID;
    const { container } = render(<MicrosoftStoreBadge />);
    expect(container).toBeEmptyDOMElement();
    expect(warn).not.toHaveBeenCalled();
  });

  it('set but invalid -> warns outside production', () => {
    expect(microsoftStoreUrl('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEXT_PUBLIC_MS_STORE_PRODUCT_ID'));
  });
});

describe('C4b: the agent dashboard', () => {
  it('Windows + id: badge on its own line, installer link and Open Keepr kept', () => {
    setUA(WINDOWS_UA);
    process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID = XP_ID;
    render(<FloorDashboard headerTitle="Welcome back" />);
    const badge = screen.getByRole('link', { name: STORE_LINK });
    expect(screen.getByRole('link', { name: /Download Keepr/ })).toHaveAttribute('href', '/download');
    expect(screen.getByRole('link', { name: 'Open Keepr' })).toHaveAttribute('href', 'keepr://focus');
    // Own line: not inside the flex-wrap row that holds Open Keepr.
    const row = screen.getByRole('link', { name: 'Open Keepr' }).parentElement!;
    expect(row.contains(badge)).toBe(false);
  });

  it('Mac + id: no badge', () => {
    setUA(MAC_UA);
    process.env.NEXT_PUBLIC_MS_STORE_PRODUCT_ID = XP_ID;
    render(<FloorDashboard headerTitle="Welcome back" />);
    expect(screen.queryByRole('link', { name: STORE_LINK })).not.toBeInTheDocument();
  });
});
