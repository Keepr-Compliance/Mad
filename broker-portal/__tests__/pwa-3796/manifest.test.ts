/**
 * BACKLOG-3796 — web app manifest. Every icon's declared size must equal the
 * real pixel size of the PNG it points at (read from the PNG header), or
 * Chrome rejects the icon and the install prompt never appears.
 *
 * @jest-environment node
 */

import fs from 'fs';
import path from 'path';
import manifest from '@/app/manifest';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function pngSize(file: string): string {
  const buf = fs.readFileSync(file);
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe('BACKLOG-3796 manifest', () => {
  const m = manifest();

  it('names the app Keepr and opens standalone on the dashboard', () => {
    expect(m.name).toBe('Keepr');
    expect(m.short_name).toBe('Keepr');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/dashboard');
    expect(m.scope).toBe('/');
    expect(m.theme_color).toBe('#111827');
  });

  it('declares a 192 and a 512 icon and a 512 maskable icon', () => {
    const icons = m.icons ?? [];
    expect(icons.some((i) => i.sizes === '192x192' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
  });

  it.each((manifest().icons ?? []).map((i) => [i.src, i.sizes, i.purpose] as const))(
    'icon %s (%s, %s) exists in public/ at exactly the declared size',
    (src, sizes) => {
      const file = path.join(PUBLIC_DIR, src);
      expect(fs.existsSync(file)).toBe(true);
      expect(pngSize(file)).toBe(sizes);
    }
  );
});
