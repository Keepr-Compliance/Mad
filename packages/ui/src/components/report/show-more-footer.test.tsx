import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ShowMoreFooter } from './show-more-footer';

const noun = { one: 'finished run', other: 'finished runs' };

describe('ShowMoreFooter', () => {
  it('more than a step remains: "Show 5 more" and "Show all"', () => {
    render(<ShowMoreFooter shown={5} total={24} noun={noun} suffix="newest first" onShowMore={() => {}} onShowAll={() => {}} />);
    expect(screen.getByText('Showing 5 of 24 finished runs, newest first')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 5 more' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument();
  });

  it('less than a step remains (7 rows, step 5): "Show 2 more"', () => {
    render(<ShowMoreFooter shown={5} total={7} noun={noun} onShowMore={() => {}} />);
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeInTheDocument();
  });

  it('uses the step it is given', () => {
    render(<ShowMoreFooter shown={10} total={24} step={10} noun={noun} onShowMore={() => {}} />);
    expect(screen.getByRole('button', { name: 'Show 10 more' })).toBeInTheDocument();
  });

  it('hides both buttons once everything is shown', () => {
    render(<ShowMoreFooter shown={7} total={7} noun={noun} onShowMore={() => {}} onShowAll={() => {}} />);
    expect(screen.getByText('Showing 7 of 7 finished runs')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('Show more and Show all call their OWN handlers', () => {
    const more = jest.fn();
    const all = jest.fn();
    render(<ShowMoreFooter shown={5} total={24} noun={noun} onShowMore={more} onShowAll={all} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(all).toHaveBeenCalledTimes(1);
    expect(more).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }));
    expect(more).toHaveBeenCalledTimes(1);
  });

  it('no "Show all" without onShowAll; singular noun; nothing for zero rows', () => {
    const { container, rerender } = render(<ShowMoreFooter shown={0} total={1} noun={noun} onShowMore={() => {}} />);
    expect(screen.getByText('Showing 0 of 1 finished run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    rerender(<ShowMoreFooter shown={0} total={0} noun={noun} onShowMore={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
