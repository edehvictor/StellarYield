import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import StatusBadge from '../StatusBadge';

describe('StatusBadge', () => {
  it('renders label and has role=status', () => {
    render(<StatusBadge label="healthy" variant="success" />);
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveTextContent('healthy');
  });

  it('renders compact variant with small text', () => {
    render(<StatusBadge label="warn" variant="warning" compact />);
    const el = screen.getByRole('status');
    // compact uses text-xs
    expect(el.className).toMatch(/text-xs/);
    expect(el).toHaveTextContent('warn');
  });

  it('renders different variants', () => {
    render(<>
      <StatusBadge label="ok" variant="success" />
      <StatusBadge label="bad" variant="danger" />
      <StatusBadge label="meh" variant="neutral" />
    </>);

    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('bad')).toBeInTheDocument();
    expect(screen.getByText('meh')).toBeInTheDocument();
  });
});
