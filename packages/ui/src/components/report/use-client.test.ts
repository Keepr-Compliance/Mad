import * as fs from 'fs';
import * as path from 'path';

/**
 * R10 (BACKLOG-3502a): every report kit component file, AND every .ts file
 * that uses React (the hooks), starts with 'use client' so a Next.js Server
 * Component can import it. jest/tsc never bundle, so this reads source. Pure
 * .ts helpers that never import React (url-params.ts) are exempt.
 */
const source = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const all = fs.readdirSync(__dirname).filter((f) => !/\.test\.tsx?$/.test(f) && f !== 'index.ts');
const components = all.filter((f) => f.endsWith('.tsx'));
const hooks = all.filter((f) => f.endsWith('.ts') && /from 'react'/.test(source(f)));

describe("report kit 'use client' directive", () => {
  it('finds the component and hook files', () => {
    expect(components.length).toBeGreaterThanOrEqual(7);
    expect(hooks.sort()).toEqual(['use-click-outside.ts', 'use-report-url-state.ts', 'use-sort-state.ts']);
  });

  it.each([...components, ...hooks])('%s starts with the directive', (file) => {
    expect(source(file).split('\n')[0].trim()).toBe("'use client';");
  });
});
