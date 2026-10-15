import * as fs from 'fs';
import * as path from 'path';

/**
 * R3: every phone kit component file starts with 'use client' so a Next.js
 * Server Component can import it. jest/tsc never bundle, so this reads source.
 */
describe("phone kit 'use client' directive", () => {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));

  it('finds the component files', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)('%s starts with the directive', (file) => {
    const firstLine = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n')[0].trim();
    expect(firstLine).toBe("'use client';");
  });
});
