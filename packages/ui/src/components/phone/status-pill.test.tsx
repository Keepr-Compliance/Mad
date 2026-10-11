import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render, screen } from '@testing-library/react';
import { StatusPill, PriorityPill } from './status-pill';

describe('StatusPill / PriorityPill', () => {
  it('yellow renders the literal testing-pill classes and the word', () => {
    render(<StatusPill hue="yellow">Testing</StatusPill>);
    const pill = screen.getByText('Testing');
    expect(pill).toHaveClass('bg-yellow-100', 'text-yellow-800');
  });

  it('red renders the literal blocked-pill classes', () => {
    render(<PriorityPill hue="red">Critical</PriorityPill>);
    expect(screen.getByText('Critical')).toHaveClass('bg-red-100', 'text-red-800');
  });

  it('no phone kit file carries its own hue map', () => {
    const dir = __dirname;
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .filter((f) => /bg-(gray|blue|green|red|yellow|orange|purple|amber|indigo)-100/.test(
        fs.readFileSync(path.join(dir, f), 'utf8')
      ));
    expect(offenders).toEqual([]);
  });
});
